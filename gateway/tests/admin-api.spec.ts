import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
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
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users') })
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const admin = await deps.users.create({ username: 'boss', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const member = await deps.users.create({ username: 'worker', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(member.id, 'pw-12345678')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closer = () => new Promise(resolve => server.close(() => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const cookie = await login(base, 'boss', 'pw-12345678')
  return { deps, base, cookie, root, member, admin }
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
    expect((await fetch(`${base}/admin/api/users`, { headers: { cookie: workerCookie } })).status).toBe(403)
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
    const { base, cookie, root, member } = await setup()
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
    const afterDelete = JSON.parse(readFileSync(grantsPath, 'utf8')) as Array<{ label: string }>
    expect(afterDelete.some(g => g.label === 'Alpha')).toBe(false)
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
