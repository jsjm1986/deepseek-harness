import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import type { ModelUsageSubject, UsageSummary } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import type { GatewayCollaborationService } from '../src/services.ts'
import { createGatewayServer, type GatewayDeps, type GatewayHandlers } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let closer: (() => Promise<void>) | undefined
afterEach(async () => { await closer?.() })

async function setup(env: NodeJS.ProcessEnv = {}, handlers: GatewayHandlers = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({
    ...env,
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
  })
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const admin = await deps.users.create({ username: 'root-admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), ...handlers })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  cfg.publicOrigins.push(base)
  closer = () => new Promise(resolve => server.close(() => resolve()))
  return { deps, base }
}

/** Install a small ACL adapter over the synchronous project service for HTTP route tests. */
function installProjectCollaboration(deps: GatewayDeps): void {
  const authority = async (projectId: number, userId: number) => {
    const [project, user] = await Promise.all([deps.projects.getById(projectId), deps.users.getById(userId)])
    if (project === null || user === null || user.status !== 'active') return null
    if (user.role === 'admin') return {
      projectId, name: project.name, path: project.path, mode: 'rw' as const, administrator: true,
    }
    const member = project.members.find(candidate => candidate.userId === userId)
    return member === undefined ? null : {
      projectId, name: project.name, path: project.path, mode: member.mode, administrator: false,
    }
  }
  deps.collaboration = {
    projectsForUser: async userId => {
      const scopes: Array<{ projectId: number; name: string; path: string; mode: 'ro' | 'rw' }> = []
      for (const project of await deps.projects.list()) {
        const value = await authority(project.id, userId)
        if (value === null) continue
        scopes.push({ projectId: value.projectId, name: value.name, path: value.path, mode: value.mode })
      }
      return scopes
    },
    projectForUser: authority,
    access: () => { throw new Error('not implemented in route test') },
    listConversations: () => [],
    readableSessionIds: () => [],
    setVisibility: () => { throw new Error('not implemented in route test') },
    claimInteraction: () => false,
  } satisfies GatewayCollaborationService
}

async function login(base: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }),
  })
  expect(response.status).toBe(302)
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

const emptyUsageSummary: UsageSummary = {
  month: '2026-08',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  estimatedCostMicros: 0,
  companyCostMicros: 0,
  calls: 0,
  missingUsageCalls: 0,
  tokenLimit: null,
  companyCostMicrosLimit: null,
  alerts: [],
}

describe('gateway server', () => {
  it('serves healthz without auth and redirects anonymous html to /login', async () => {
    const { base } = await setup()
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    const anonymous = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('location')).toBe('/login')
    const api = await fetch(`${base}/api/session.list`, { method: 'POST', headers: { origin: base } })
    expect(api.status).toBe(401)
  })

  it('uses the runtime API body limit and returns JSON 413 before dispatch', async () => {
    const received: string[] = []
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtime: async (_req, res, _pathname, body) => {
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return true
      },
    })
    const accepted = await fetch(`${base}/internal/runtime/test`, { method: 'POST', body: '1234567890123456' })
    expect(accepted.status).toBe(200)
    const rejected = await fetch(`${base}/internal/runtime/test`, { method: 'POST', body: '12345678901234567' })
    expect(rejected.status).toBe(413)
    expect(rejected.headers.get('content-type')).toBe('application/json')
    expect(await rejected.json()).toEqual({ error: 'runtime-request-too-large' })
    expect(received).toEqual(['1234567890123456'])
  })

  it('logs in, enforces csrf origin, logs out', async () => {
    const { base } = await setup()
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const evil = await fetch(`${base}/api/x`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await evil.text()).toBe('origin not allowed')
    const out = await fetch(`${base}/logout`, {
      method: 'POST', redirect: 'manual', headers: { cookie, origin: base },
    })
    expect(out.status).toBe(302)
    const after = await fetch(`${base}/api/x`, { method: 'POST', headers: { cookie, origin: base } })
    expect(after.status).toBe(401)
  })

  it('forces password change before proxying', async () => {
    const { deps, base } = await setup()
    await deps.users.create({ username: 'fresh', password: 'pw-11111111' })
    const cookie = await login(base, 'fresh', 'pw-11111111')
    const blocked = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
    expect(blocked.status).toBe(302)
    expect(blocked.headers.get('location')).toBe('/account/password')
    const change = await fetch(`${base}/account/password`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ password: 'pw-22222222' }),
    })
    expect(change.status).toBe(302)
    const proxied = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
    expect(proxied.status).toBe(503)
  })

  it('does not steal the proxy for /adminfoo', async () => {
    const { base } = await setup()
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const res = await fetch(`${base}/adminfoo`, { headers: { cookie } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'proxy-not-configured' })
  })

  it('reads usage for the active personal or project scope', async () => {
    const { deps, base } = await setup()
    const calls: Array<{ subject: ModelUsageSubject; month?: string }> = []
    deps.governance = {
      summary: (subject, month) => {
        calls.push({ subject, ...(month === undefined ? {} : { month }) })
        return { ...emptyUsageSummary, month: month ?? emptyUsageSummary.month }
      },
    } as NonNullable<GatewayDeps['governance']>
    deps.collaboration = {
      projectForUser: (projectId, userId) => projectId === 42 && userId === 1
        ? { projectId, name: 'Shared project', path: '/shared', mode: 'rw' }
        : null,
    } as NonNullable<GatewayDeps['collaboration']>
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    expect((await fetch(`${base}/account/api/usage?month=2026-07`, {
      headers: { cookie },
    })).status).toBe(200)
    expect((await fetch(`${base}/account/api/usage?month=2026-06`, {
      headers: { cookie: `${cookie}; hgw_scope=project:42` },
    })).status).toBe(200)

    expect(calls).toEqual([
      { subject: { kind: 'user', id: 1 }, month: '2026-07' },
      { subject: { kind: 'project', id: 42 }, month: '2026-06' },
    ])
  })

  it('lets a user own a managed project, invite a member, and exposes one admin project view', async () => {
    const { deps, base } = await setup()
    const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678', displayName: 'Alice' })
    const bob = await deps.users.create({ username: 'bob', password: 'pw-12345678', displayName: 'Bob' })
    await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
    await deps.users.changeOwnPassword(bob.id, 'pw-12345678')
    installProjectCollaboration(deps)

    const aliceCookie = await login(base, 'alice', 'pw-12345678')
    const created = await fetch(`${base}/account/api/projects`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ name: '  Alice workspace  ' }),
    })
    expect(created.status).toBe(201)
    const project = await created.json() as {
      id: number; name: string; path: string; origin: string; owner: { id: number }; memberCount: number
    }
    expect(project).toMatchObject({ name: 'Alice workspace', origin: 'user', owner: { id: alice.id }, memberCount: 1 })
    expect(project.path.startsWith(realpathSync(deps.cfg.userProjectsRoot) + '/')).toBe(true)

    const aliceContext = await fetch(`${base}/account/api/context`, { headers: { cookie: aliceCookie } })
    expect(aliceContext.status).toBe(200)
    expect(await aliceContext.json()).toMatchObject({
      fullAccess: false,
      projects: [{ projectId: project.id, mode: 'rw', canManage: true }],
    })

    const invitationResponse = await fetch(`${base}/account/api/projects/${project.id}/invitations`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ username: 'bob', mode: 'ro' }),
    })
    expect(invitationResponse.status).toBe(201)
    const invitation = await invitationResponse.json() as { id: string; status: string; invitee: { username: string }; mode: string }
    expect(invitation).toMatchObject({ status: 'pending', mode: 'ro', invitee: { username: 'bob' } })

    const bobCookie = await login(base, 'bob', 'pw-12345678')
    const bobInvitations = await fetch(`${base}/account/api/invitations`, { headers: { cookie: bobCookie } })
    expect(bobInvitations.status).toBe(200)
    expect(await bobInvitations.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: invitation.id })]))
    const accepted = await fetch(`${base}/account/api/invitations/${encodeURIComponent(invitation.id)}/accept`, {
      method: 'POST', headers: { cookie: bobCookie, origin: base },
    })
    expect(accepted.status).toBe(204)

    const bobContext = await fetch(`${base}/account/api/context`, { headers: { cookie: bobCookie } })
    expect(await bobContext.json()).toMatchObject({
      fullAccess: false,
      projects: [{ projectId: project.id, mode: 'ro' }],
    })
    const bobCannotInvite = await fetch(`${base}/account/api/projects/${project.id}/invitations`, {
      method: 'POST', headers: {
        cookie: bobCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ username: 'root-admin', mode: 'ro' }),
    })
    expect(bobCannotInvite.status).toBe(403)

    const adminCookie = await login(base, 'root-admin', 'pw-12345678')
    const adminContext = await fetch(`${base}/account/api/context`, { headers: { cookie: adminCookie } })
    expect(await adminContext.json()).toMatchObject({
      fullAccess: true,
      projects: [expect.objectContaining({ projectId: project.id, mode: 'rw', canManage: true })],
    })
    const adminProjectContext = await fetch(`${base}/account/api/context`, {
      headers: { cookie: `${adminCookie}; hgw_scope=project:${project.id}` },
    })
    expect(await adminProjectContext.json()).toMatchObject({
      fullAccess: true,
      scope: { kind: 'project', projectId: project.id, mode: 'rw' },
    })
    const userProjects = await fetch(`${base}/admin/api/projects?origin=user`, { headers: { cookie: adminCookie } })
    expect(userProjects.status).toBe(200)
    expect(await userProjects.json()).toEqual([expect.objectContaining({
      id: project.id, origin: 'user', owner: expect.objectContaining({ id: alice.id }),
    })])

    const adminPath = join(deps.cfg.projectPathRoots[0] ?? deps.cfg.userProjectsRoot, 'admin-project')
    mkdirSync(adminPath, { recursive: true })
    const adminCreated = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: {
        cookie: adminCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ name: 'Admin workspace', path: adminPath }),
    })
    expect(adminCreated.status).toBe(200)
    const adminProject = await adminCreated.json() as { id: number; origin: string; owner: unknown }
    expect(adminProject).toMatchObject({ origin: 'admin', owner: null })
    const adminProjects = await fetch(`${base}/admin/api/projects?origin=admin`, { headers: { cookie: adminCookie } })
    expect(await adminProjects.json()).toEqual([expect.objectContaining({ id: adminProject.id, origin: 'admin' })])
  })

  it('rejects malformed encoded conversation ids without raising a server error', async () => {
    const { deps, base } = await setup()
    deps.collaboration = {
      projectsForUser: () => [],
      projectForUser: () => null,
      access: () => { throw new Error('must not authorize an invalid path') },
      listConversations: () => [],
      readableSessionIds: () => [],
      setVisibility: () => {},
      claimInteraction: () => false,
    }
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/conversations/%E0%A4%A`, {
      headers: { cookie },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-session-id' })
  })
})
