import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager, type RuntimeTargetInput } from '../src/instances.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let closer: (() => Promise<void>) | undefined
afterEach(async () => { await closer?.() })

async function login(base: string, username: string, password: string): Promise<string> {
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }),
  })
  return (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects') })
  const instances = new InstanceManager(db, cfg)
  const stoppedTargets: RuntimeTargetInput[] = []
  const stop = instances.stop.bind(instances)
  instances.stop = async target => {
    stoppedTargets.push(target)
    if (typeof target !== 'number' && target.kind === 'project') return
    await stop(target)
  }
  const withStopped = instances.withStopped.bind(instances)
  instances.withStopped = async <T>(target: RuntimeTargetInput, operation: () => Promise<T>): Promise<T> => {
    stoppedTargets.push(target)
    if (typeof target !== 'number' && target.kind === 'project') return operation()
    return withStopped(target, operation)
  }
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances,
    governance: new ModelGovernanceService(db),
  }
  const admin = await deps.users.create({ username: 'boss', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const member = await deps.users.create({ username: 'worker', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(member.id, 'pw-12345678')
  const server = createGatewayServer(deps, {
    admin: createAdminApiHandler(deps),
    adminRoot: join(root, 'public/admin'),
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closer = () => new Promise(resolve => server.close(() => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const cookie = await login(base, 'boss', 'pw-12345678')
  return { deps, base, cookie, root, member, admin, stoppedTargets }
}

describe('admin JSON API', () => {
  it('lets an admin create a project and assign members; non-admin is 403', async () => {
    const { base, cookie, root, member } = await setup()
    const shared = join(root, 'shared'); mkdirSync(shared)
    const created = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', path: shared }),
    })
    expect(created.status).toBe(200)
    const project = await created.json() as { id: number }
    expect((await fetch(`${base}/admin/api/projects/${project.id}/members/${member.id}`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ro' }),
    })).status).toBe(204)
    const workerCookie = await login(base, 'worker', 'pw-12345678')
    const forbidden = await fetch(`${base}/admin/api/users`, { headers: { cookie: workerCookie } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('content-type')).toMatch(/json/)
    expect(await forbidden.json()).toEqual({ error: 'forbidden' })
  })

  it('returns a stable error when a project directory is missing', async () => {
    const { base, cookie, root } = await setup()
    const response = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Missing', path: join(root, 'missing') }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'project-path-not-found' })
  })

  it('creates the project directory when the API receives only a name', async () => {
    const { base, cookie, root } = await setup()
    const response = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '产品文档' }),
    })
    expect(response.status).toBe(200)
    const project = await response.json() as { name: string; path: string }
    const expectedPath = realpathSync(join(root, 'projects', '产品文档'))
    expect(project).toMatchObject({ name: '产品文档', path: expectedPath })
    expect(existsSync(expectedPath)).toBe(true)
    expect(statSync(expectedPath).isDirectory()).toBe(true)
  })

  it('deletes a user after stopping the runtime, revoking access, and recording the action', async () => {
    const { base, cookie, member, admin, deps, stoppedTargets } = await setup()
    const memberCookie = await login(base, 'worker', 'pw-12345678')
    const memberToken = memberCookie.split('=')[1]
    expect(memberToken).toBeTruthy()
    const res = await fetch(`${base}/admin/api/users/${member.id}`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })
    expect(res.status).toBe(204)
    expect(stoppedTargets).toContainEqual(member.id)
    expect(await deps.users.getById(member.id)).toBeNull()
    expect(await deps.auth.validate(memberToken!)).toBeNull()
    expect((await deps.audit.query({ action: 'admin.users.delete' }))[0]).toMatchObject({
      userId: admin.id,
      action: 'admin.users.delete',
    })
  })

  it('rejects deleting the current administrator', async () => {
    const { base, cookie, admin, deps } = await setup()
    const res = await fetch(`${base}/admin/api/users/${admin.id}`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'cannot-delete-self' })
    expect(await deps.users.getById(admin.id)).not.toBeNull()
  })

  it('returns JSON { error: "origin not allowed" } for /admin/api CSRF failures', async () => {
    const { base, cookie } = await setup()
    const res = await fetch(`${base}/admin/api/users`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(await res.json()).toEqual({ error: 'origin not allowed' })
  })

  it('returns 409 when patching the last admin away', async () => {
    const { base, cookie, admin } = await setup()
    const res = await fetch(`${base}/admin/api/users/${admin.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'cannot-remove-last-admin' })
  })

  it('does not persist displayName when a later PATCH field fails', async () => {
    const { base, cookie, admin, deps } = await setup()
    const original = (await deps.users.getById(admin.id))!.displayName
    const lastAdmin = await fetch(`${base}/admin/api/users/${admin.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Should Not Stick', status: 'disabled' }),
    })
    expect(lastAdmin.status).toBe(409)
    expect((await deps.users.getById(admin.id))?.displayName).toBe(original)
    const invalidRole = await fetch(`${base}/admin/api/users/${admin.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Also Not Stick', role: 'nope' }),
    })
    expect(invalidRole.status).toBe(400)
    expect((await deps.users.getById(admin.id))?.displayName).toBe(original)
  })

  it('rewrites runtime grants when a user gains or loses the administrator role', async () => {
    const { base, cookie, root, member } = await setup()
    const grantsPath = join(root, 'users', 'worker', 'dsh', 'directory-grants.json')
    const promote = await fetch(`${base}/admin/api/users/${member.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(promote.status).toBe(204)
    const filesystemRoot = parse(member.homePath).root
    expect(JSON.parse(readFileSync(grantsPath, 'utf8'))).toEqual([
      { path: filesystemRoot, mode: 'rw', label: filesystemRoot },
    ])

    const demote = await fetch(`${base}/admin/api/users/${member.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    })
    expect(demote.status).toBe(204)
    expect(JSON.parse(readFileSync(grantsPath, 'utf8'))).toEqual([
      { path: member.homePath, mode: 'rw', label: '主目录' },
    ])
  })

  it('returns 400 when applying grants fails before restart', async () => {
    const { base, cookie, root, member } = await setup()
    const shared = join(root, 'shared'); mkdirSync(shared)
    const created = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', path: shared }),
    })
    const project = await created.json() as { id: number }
    expect((await fetch(`${base}/admin/api/projects/${project.id}/members/${member.id}`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ro' }),
    })).status).toBe(204)
    const grantsPath = join(root, 'users', 'worker', 'dsh', 'directory-grants.json')
    unlinkSync(grantsPath)
    mkdirSync(grantsPath)
    const res = await fetch(`${base}/admin/api/projects/${project.id}/members/${member.id}`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rw' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error.length).toBeGreaterThan(0)
  })

  it('filters audit entries by userId and omits detail', async () => {
    const { base, cookie, deps, member, admin } = await setup()
    deps.audit.write({ userId: member.id, action: 'login', ip: '1.1.1.1', detail: '{"password":"x"}' })
    deps.audit.write({ userId: admin.id, action: 'admin.users', ip: '2.2.2.2', detail: '{"body":true}' })
    const res = await fetch(`${base}/admin/api/audit?userId=${member.id}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<{ userId: number; action: string; detail?: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.userId === member.id)).toBe(true)
    expect(rows.every(r => r.detail === undefined)).toBe(true)
  })

  it('rewrites grants on member write and on project delete', async () => {
    const { base, cookie, root, member, stoppedTargets } = await setup()
    const shared = join(root, 'shared'); mkdirSync(shared)
    const created = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', path: shared }),
    })
    const project = await created.json() as { id: number }
    expect((await fetch(`${base}/admin/api/projects/${project.id}/members/${member.id}`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rw' }),
    })).status).toBe(204)
    const grantsPath = join(root, 'users', 'worker', 'dsh', 'directory-grants.json')
    const afterAdd = JSON.parse(readFileSync(grantsPath, 'utf8')) as Array<{ label: string }>
    expect(afterAdd.some(g => g.label === 'Alpha')).toBe(true)
    expect((await fetch(`${base}/admin/api/projects/${project.id}`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })).status).toBe(204)
    expect(stoppedTargets).toContainEqual({ kind: 'project', id: project.id })
    const afterDelete = JSON.parse(readFileSync(grantsPath, 'utf8')) as Array<{ label: string }>
    expect(afterDelete.some(g => g.label === 'Alpha')).toBe(false)
  })

  it('returns a conflict when a private conversation blocks member removal', async () => {
    const { base, cookie, root, member, deps } = await setup()
    const shared = join(root, 'shared-private'); mkdirSync(shared)
    const created = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Private', path: shared }),
    })
    const project = await created.json() as { id: number }
    deps.projects.removeMember = async () => { throw new CollaborationDeniedError('visibility-locked') }

    const response = await fetch(`${base}/admin/api/projects/${String(project.id)}/members/${String(member.id)}`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'visibility-locked' })
  })

  it('requires explicit quota fields so omission cannot grant unlimited usage', async () => {
    const { base, cookie } = await setup()
    for (const body of [
      { subjectType: 'role', subjectId: 'user', tokenLimit: 100 },
      { subjectType: 'role', subjectId: 'user', companyCostMicrosLimit: 100 },
    ]) {
      const response = await fetch(`${base}/admin/api/quotas`, {
        method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect((await response.json() as { error: string }).error).toMatch(/required/)
    }
    expect((await fetch(`${base}/admin/api/quotas`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectType: 'role', subjectId: 'user', tokenLimit: null, companyCostMicrosLimit: null,
      }),
    })).status).toBe(204)
  })
  it('rejects invalid JSON with 400 and leaves non-api /admin unhandled', async () => {
    const { base, cookie } = await setup()
    const bad = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid json' })
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(404)
  })
})
