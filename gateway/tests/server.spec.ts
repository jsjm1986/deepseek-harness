import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import type { ModelUsageSubject, UsageSummary } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps, type GatewayHandlers } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let closer: (() => Promise<void>) | undefined
afterEach(async () => { await closer?.() })

async function setup(env: NodeJS.ProcessEnv = {}, handlers: GatewayHandlers = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ ...env, HGW_USERS_ROOT: join(root, 'users') })
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
  const server = createGatewayServer(deps, handlers)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  cfg.publicOrigins.push(base)
  closer = () => new Promise(resolve => server.close(() => resolve()))
  return { deps, base }
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
