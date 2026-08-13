import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { UserService } from '../src/users.ts'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users') })
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

  it('manages status, role and password lifecycle', async () => {
    const { users } = setup()
    const u = await users.create({ username: 'carol', password: 'pw-123456', role: 'admin' })
    users.setStatus(u.id, 'disabled')
    expect(users.getById(u.id)?.status).toBe('disabled')
    await users.changeOwnPassword(u.id, 'pw-654321')
    expect(users.getById(u.id)?.mustChangePassword).toBe(false)
    await users.resetPassword(u.id, 'pw-000000')
    expect(users.getById(u.id)?.mustChangePassword).toBe(true)
  })
})
