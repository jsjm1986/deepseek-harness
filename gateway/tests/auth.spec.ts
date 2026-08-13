import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/password.ts'

async function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite'))
  const now = Date.now()
  db.prepare(`INSERT INTO users(username, password_hash, home_path, role, must_change_password, created_at, updated_at)
              VALUES('alice', ?, '/tmp/alice', 'user', 0, ?, ?)`)
    .run(await hashPassword('secret-1'), now, now)
  return { db, auth: new AuthService(db, loadConfig({})) }
}

describe('AuthService', () => {
  it('logs in, validates with sliding expiry, revokes', async () => {
    const { auth } = await setup()
    const result = await auth.login('alice', 'secret-1', '1.2.3.4', 'ua')
    if (result === 'invalid' || result === 'locked') throw new Error(result)
    expect(result.user.username).toBe('alice')
    expect(auth.validate(result.token)?.username).toBe('alice')
    auth.revoke(result.token)
    expect(auth.validate(result.token)).toBeNull()
  })

  it('rejects wrong password and locks after 5 failures', async () => {
    const { auth } = await setup()
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('alice', 'nope', '9.9.9.9', 'ua')).toBe('invalid')
    }
    expect(await auth.login('alice', 'secret-1', '9.9.9.9', 'ua')).toBe('locked')
    const elsewhere = await auth.login('alice', 'secret-1', '8.8.8.8', 'ua')
    expect(elsewhere).not.toBe('locked')
  })

  it('rejects disabled users and unknown tokens', async () => {
    const { db, auth } = await setup()
    db.prepare(`UPDATE users SET status='disabled'`).run()
    expect(await auth.login('alice', 'secret-1', '1.1.1.1', 'ua')).toBe('invalid')
    expect(auth.validate('bogus')).toBeNull()
  })
})
