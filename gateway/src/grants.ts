import { realpathSync, statSync } from 'node:fs'
import type Database from 'better-sqlite3'

export interface GrantRow {
  id: number
  subjectType: 'user' | 'group'
  subjectId: number
  path: string
  mode: 'ro' | 'rw'
  note: string
}

export class GrantService {
  constructor(private readonly db: Database.Database) {}

  createGroup(name: string, description = ''): number {
    const info = this.db.prepare(`INSERT INTO groups(name, description, created_at) VALUES(?, ?, ?)`)
      .run(name, description, Date.now())
    return Number(info.lastInsertRowid)
  }

  deleteGroup(id: number): void {
    this.db.prepare(`DELETE FROM dir_grants WHERE subject_type = 'group' AND subject_id = ?`).run(id)
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id)
  }

  listGroups(): Array<{ id: number; name: string; description: string; members: string[] }> {
    const groups = this.db.prepare(`SELECT * FROM groups ORDER BY id`).all() as
      Array<{ id: number; name: string; description: string }>
    const members = this.db.prepare(
      `SELECT gm.group_id AS gid, u.username AS name FROM group_members gm JOIN users u ON u.id = gm.user_id`,
    ).all() as Array<{ gid: number; name: string }>
    return groups.map(g => ({
      ...g,
      members: members.filter(m => m.gid === g.id).map(m => m.name),
    }))
  }

  addMember(groupId: number, userId: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?, ?)`).run(groupId, userId)
  }

  removeMember(groupId: number, userId: number): void {
    this.db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).run(groupId, userId)
  }

  addGrant(input: { subjectType: 'user' | 'group'; subjectId: number; path: string; mode: 'ro' | 'rw'; note?: string; createdBy?: number }): number {
    const canonical = realpathSync(input.path)
    if (!statSync(canonical).isDirectory()) throw new Error(`not a directory: ${canonical}`)
    const info = this.db.prepare(
      `INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.subjectType, input.subjectId, canonical, input.mode, input.note ?? '', input.createdBy ?? null, Date.now())
    return Number(info.lastInsertRowid)
  }

  removeGrant(id: number): void {
    this.db.prepare(`DELETE FROM dir_grants WHERE id = ?`).run(id)
  }

  listGrants(): GrantRow[] {
    const rows = this.db.prepare(`SELECT * FROM dir_grants ORDER BY id`).all() as
      Array<{ id: number; subject_type: 'user' | 'group'; subject_id: number; path: string; mode: 'ro' | 'rw'; note: string }>
    return rows.map(r => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, path: r.path, mode: r.mode, note: r.note }))
  }

  effectiveGrants(userId: number): Array<{ path: string; mode: 'ro' | 'rw' }> {
    const merged = new Map<string, 'ro' | 'rw'>()
    const apply = (path: string, mode: 'ro' | 'rw') => {
      if (mode === 'rw' || !merged.has(path)) merged.set(path, merged.get(path) === 'rw' ? 'rw' : mode)
    }
    const rows = this.db.prepare(
      `SELECT path, mode FROM dir_grants
       WHERE (subject_type = 'user' AND subject_id = ?)
          OR (subject_type = 'group' AND subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`,
    ).all(userId, userId) as Array<{ path: string; mode: 'ro' | 'rw' }>
    for (const row of rows) apply(row.path, row.mode)
    const home = this.db.prepare(`SELECT home_path FROM users WHERE id = ?`).get(userId) as { home_path: string } | undefined
    if (home !== undefined) merged.set(home.home_path, 'rw')
    return [...merged.entries()].map(([path, mode]) => ({ path, mode })).sort((a, b) => a.path.localeCompare(b.path))
  }
}
