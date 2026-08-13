import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.ts'

function tables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
    .map(r => r.name)
}

describe('schema v2 migration', () => {
  it('creates project tables on a fresh database and records schema_version=2', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')
    const db = openDb(file)
    expect(tables(db)).toEqual(expect.arrayContaining(['projects', 'project_members', 'schema_meta']))
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'dir_grants']))
    expect((db.prepare(`SELECT version FROM schema_meta`).get() as { version: number }).version).toBe(2)
  })

  it('folds dir_grants and group members into projects; rw beats ro; then drops old tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-'))
    const shared = join(root, 'shared'); mkdirSync(shared)
    const file = join(root, 'legacy.sqlite')
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, home_path TEXT);
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER);
      CREATE TABLE group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY(group_id, user_id));
      CREATE TABLE dir_grants (id INTEGER PRIMARY KEY, subject_type TEXT, subject_id INTEGER, path TEXT, mode TEXT, note TEXT, created_by INTEGER, created_at INTEGER);
    `)
    raw.prepare(`INSERT INTO users(id, username, home_path) VALUES(1,'alice',?), (2,'bob',?)`)
      .run(join(root, 'alice'), join(root, 'bob'))
    raw.prepare(`INSERT INTO groups(id, name, description, created_at) VALUES(1,'team','',0)`).run()
    raw.prepare(`INSERT INTO group_members(group_id, user_id) VALUES(1,1),(1,2)`).run()
    raw.prepare(`INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
      VALUES('group',1,?, 'ro','',NULL,0),('user',1,?, 'rw','',NULL,0)`).run(shared, shared)
    raw.close()

    const db = openDb(file)
    const project = db.prepare(`SELECT name, path FROM projects`).get() as { name: string; path: string }
    expect(project.path).toBe(shared)
    expect(project.name).toBe('shared')
    const members = db.prepare(`SELECT user_id, mode FROM project_members ORDER BY user_id`).all()
    expect(members).toEqual([{ user_id: 1, mode: 'rw' }, { user_id: 2, mode: 'ro' }])
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'group_members', 'dir_grants']))
  })
})
