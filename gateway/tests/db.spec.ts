import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'

describe('openDb', () => {
  it('creates all tables idempotently and enforces constraints', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')
    const db = openDb(file)
    openDb(file)
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
      .map(r => (r as { name: string }).name)
    for (const t of ['users', 'projects', 'project_members', 'schema_meta', 'auth_sessions', 'login_attempts', 'instances', 'audit_log']) {
      expect(names).toContain(t)
    }
    expect(() => db.prepare(
      `INSERT INTO users(username, password_hash, home_path, role) VALUES('x', 'h', '/x', 'superman')`,
    ).run()).toThrow()
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal')
  })
})
