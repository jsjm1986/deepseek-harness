import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { UserService } from '../src/users.ts'

function setup(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), ...env })
  return { db, cfg, users: new UserService(db, cfg) }
}

describe('UserService', () => {
  it('provisions home dirs and sequential ports', async () => {
    const { cfg, users } = setup()
    const alice = await users.create({ username: 'alice', password: 'pw-123456' })
    await users.create({ username: 'bob', password: 'pw-123456' })
    expect(existsSync(join(cfg.usersRoot, 'alice', 'home'))).toBe(true)
    expect(existsSync(join(cfg.usersRoot, 'alice', 'dsh'))).toBe(true)
    const listed = users.list()
    expect(listed.map(u => u.port)).toEqual([42000, 42001])
    expect(alice.mustChangePassword).toBe(true)
  })

  it('rejects invalid or duplicate usernames', async () => {
    const { users } = setup()
    await users.create({ username: 'alice', password: 'pw-123456' })
    await expect(users.create({ username: 'alice', password: 'x' })).rejects.toThrow()
    await expect(users.create({ username: 'Bad Name', password: 'x' })).rejects.toThrow()
  })

  it('does not allocate below the configured port base when older rows use lower ports', async () => {
    const { db, users } = setup({ HGW_INSTANCE_PORT_BASE: '47000' })
    const legacy = await users.create({ username: 'legacy', password: 'pw-123456' })
    db.prepare('UPDATE instances SET port=46000 WHERE user_id=?').run(legacy.id)
    const current = await users.create({ username: 'current', password: 'pw-123456' })
    expect(users.list().find(user => user.id === current.id)?.port).toBe(47000)
  })

  it('logically deletes a user and removes active access without erasing history', async () => {
    const { db, users } = setup()
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'pw-123456' })
    db.prepare(`INSERT INTO projects(id, name, path, created_by, created_at, updated_at)
      VALUES(1, 'Project', '/tmp/project', ?, 1, 1)`).run(member.id)
    db.prepare(`INSERT INTO project_members(project_id, user_id, mode) VALUES(1, ?, 'rw')`).run(member.id)
    db.prepare(`INSERT INTO audit_log(ts, user_id, action) VALUES(1, ?, 'login')`).run(member.id)

    expect(users.remove(member.id)).toBe(true)
    expect(users.getById(member.id)).toBeNull()
    expect(users.count()).toBe(1)
    expect((db.prepare(`SELECT deleted_at, status FROM users WHERE id = ?`).get(member.id) as {
      deleted_at: number | null
      status: string
    })).toMatchObject({ status: 'disabled' })
    expect((db.prepare(`SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?`).get(member.id) as { n: number }).n).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?`).get(member.id) as { n: number }).n).toBe(1)
    expect(db.prepare(`SELECT state, pid FROM instances WHERE user_id = ?`).get(member.id)).toEqual({ state: 'stopped', pid: null })
    expect(users.getById(admin.id)).not.toBeNull()
    await expect(users.create({ username: 'member', password: 'pw-123456' })).rejects.toThrow()
  })

  it('refuses to delete the last active admin', async () => {
    const { users } = setup()
    const admin = await users.create({ username: 'only-admin', password: 'pw-123456', role: 'admin' })
    expect(() => users.remove(admin.id)).toThrow(/cannot-remove-last-admin/)
    expect(users.getById(admin.id)).not.toBeNull()
  })

  it('manages status, role and password lifecycle', async () => {
    const { users } = setup()
    const u = await users.create({ username: 'carol', password: 'pw-123456', role: 'admin' })
    await users.create({ username: 'other-admin', password: 'pw-123456', role: 'admin' })
    users.setStatus(u.id, 'disabled')
    expect(users.getById(u.id)?.status).toBe('disabled')
    await users.changeOwnPassword(u.id, 'pw-654321')
    expect(users.getById(u.id)?.mustChangePassword).toBe(false)
    await users.resetPassword(u.id, 'pw-000000')
    expect(users.getById(u.id)?.mustChangePassword).toBe(true)
  })

  it('refuses to disable or demote the last active admin', async () => {
    const { users } = setup()
    const admin = await users.create({ username: 'boss', password: 'pw-123456', role: 'admin' })
    expect(() => users.setStatus(admin.id, 'disabled')).toThrow(/cannot-remove-last-admin/)
    expect(() => users.setRole(admin.id, 'user')).toThrow(/cannot-remove-last-admin/)
  })

  it('allows demoting an admin when another active admin remains', async () => {
    const { users } = setup()
    const a = await users.create({ username: 'a-admin', password: 'pw-123456', role: 'admin' })
    await users.create({ username: 'b-admin', password: 'pw-123456', role: 'admin' })
    users.setRole(a.id, 'user')
    expect(users.getById(a.id)?.role).toBe('user')
  })

  it('updates display name', async () => {
    const { users } = setup()
    const u = await users.create({ username: 'dave', password: 'pw-123456' })
    users.setDisplayName(u.id, 'Dave Smith')
    expect(users.getById(u.id)?.displayName).toBe('Dave Smith')
  })
})
