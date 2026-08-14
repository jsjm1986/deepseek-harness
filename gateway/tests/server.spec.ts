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
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let closer: (() => Promise<void>) | undefined
afterEach(async () => { await closer?.() })

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
  const admin = await deps.users.create({ username: 'root-admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps)
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
})
