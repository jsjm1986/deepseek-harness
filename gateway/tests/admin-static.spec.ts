import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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

async function setupWithAdminAssets() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const adminRoot = join(root, 'public/admin')
  mkdirSync(join(adminRoot, 'assets'), { recursive: true })
  writeFileSync(join(adminRoot, 'index.html'), '<div data-testid="admin-app">hello</div>')
  writeFileSync(join(adminRoot, 'assets', 'app.js'), 'window.__admin=1')
  writeFileSync(join(root, 'secret.txt'), 'nope')
  symlinkSync(join(root, 'secret.txt'), join(adminRoot, 'assets', 'leak.txt'))
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
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), adminRoot })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closer = () => new Promise(resolve => server.close(() => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const cookie = await login(base, 'boss', 'pw-12345678')
  return { deps, base, cookie, root, member, admin }
}

describe('admin static hosting', () => {
  it('serves the admin SPA shell for /admin and /admin/projects/1', async () => {
    const { base, cookie } = await setupWithAdminAssets()
    const page = await fetch(`${base}/admin`, { headers: { cookie, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('data-testid="admin-app"')
    const nested = await fetch(`${base}/admin/projects/1`, { headers: { cookie, accept: 'text/html' } })
    expect(nested.status).toBe(200)
    expect(await nested.text()).toContain('data-testid="admin-app"')
  })

  it('rejects a non-admin before serving static files', async () => {
    const { base } = await setupWithAdminAssets()
    const workerCookie = await login(base, 'worker', 'pw-12345678')
    const page = await fetch(`${base}/admin`, { headers: { cookie: workerCookie, accept: 'text/html' } })
    expect(page.status).toBe(403)
    expect(page.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await page.text()).toBe('forbidden')
    expect((await fetch(`${base}/admin/projects/1`, { headers: { cookie: workerCookie, accept: 'text/html' } })).status).toBe(403)
  })

  it('does not treat /adminfoo as admin', async () => {
    const { base } = await setupWithAdminAssets()
    const workerCookie = await login(base, 'worker', 'pw-12345678')
    const res = await fetch(`${base}/adminfoo`, { headers: { cookie: workerCookie, accept: 'text/html' } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'proxy-not-configured' })
  })

  it('serves /admin/assets with a content-type and 404s escaped paths', async () => {
    const { base, cookie } = await setupWithAdminAssets()
    const js = await fetch(`${base}/admin/assets/app.js`, { headers: { cookie } })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    expect(await js.text()).toBe('window.__admin=1')
    const escape = await fetch(`${base}/admin/assets/leak.txt`, { headers: { cookie } })
    expect(escape.status).toBe(404)
  })
})
