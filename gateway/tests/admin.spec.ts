import { mkdirSync, mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminHandler } from '../src/admin.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { GrantService } from '../src/grants.ts'
import { InstanceManager } from '../src/instances.ts'
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
    grants: new GrantService(db),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const admin = await deps.users.create({ username: 'boss', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const member = await deps.users.create({ username: 'worker', password: 'pw-12345678' })
  const server = createGatewayServer(deps, { admin: createAdminHandler(deps) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closer = () => new Promise(resolve => server.close(() => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'boss', password: 'pw-12345678' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const post = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
  return { deps, base, cookie, post, root, member }
}

describe('admin handler', () => {
  it('renders overview and creates users, groups and grants', async () => {
    const { deps, base, cookie, post, root, member } = await setup()
    const page = await fetch(`${base}/admin`, { headers: { cookie, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('worker')

    expect((await post('/admin/users', { username: 'newbie', password: 'pw-87654321', role: 'user' })).status).toBe(302)
    expect(deps.users.getByUsername('newbie')).not.toBeNull()

    expect((await post('/admin/groups', { name: 'team-x' })).status).toBe(302)
    const group = deps.grants.listGroups()[0]!
    expect((await post('/admin/groups/members/add', { groupId: String(group.id), userId: String(member.id) })).status).toBe(302)

    const shared = join(root, 'shared'); mkdirSync(shared)
    expect((await post('/admin/grants', { subjectType: 'group', subjectId: String(group.id), path: shared, mode: 'ro' })).status).toBe(302)
    expect(deps.grants.effectiveGrants(member.id).some(g => g.mode === 'ro')).toBe(true)
    expect(deps.audit.query({ action: 'admin.grants' })).toHaveLength(1)
  })

  it('refuses non-admin users', async () => {
    const { deps, base } = await setup()
    await deps.users.changeOwnPassword(deps.users.getByUsername('worker')!.id, 'pw-12345678')
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ username: 'worker', password: 'pw-12345678' }),
    })
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(403)
  })
})
