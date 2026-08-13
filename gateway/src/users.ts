import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { toUserRow, type UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { hashPassword } from './password.ts'

const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/

export class UserService {
  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {}

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n
  }

  async create(input: { username: string; password: string; role?: 'admin' | 'user'; displayName?: string }): Promise<UserRow> {
    if (!USERNAME_RE.test(input.username)) throw new Error(`invalid username: ${input.username}`)
    const homePath = join(this.cfg.usersRoot, input.username, 'home')
    mkdirSync(homePath, { recursive: true })
    mkdirSync(join(this.cfg.usersRoot, input.username, 'dsh'), { recursive: true })
    const now = Date.now()
    const hash = await hashPassword(input.password)
    const insert = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO users(username, password_hash, display_name, role, home_path, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.username, hash, input.displayName ?? input.username, input.role ?? 'user', homePath, now, now)
      const userId = Number(info.lastInsertRowid)
      const maxPort = (this.db.prepare(`SELECT MAX(port) AS p FROM instances`).get() as { p: number | null }).p
      this.db.prepare(`INSERT INTO instances(user_id, port, state) VALUES(?, ?, 'stopped')`)
        .run(userId, maxPort === null ? this.cfg.instancePortBase : maxPort + 1)
      return userId
    })
    const id = insert()
    const row = this.getById(id)
    if (row === null) throw new Error('user row missing after insert')
    return row
  }

  list(): Array<UserRow & { port: number; instanceState: string }> {
    const rows = this.db.prepare(
      `SELECT u.*, i.port AS port, i.state AS instance_state
       FROM users u JOIN instances i ON i.user_id = u.id ORDER BY u.id`,
    ).all() as never[]
    return rows.map((r) => {
      const raw = r as { port: number; instance_state: string }
      return { ...toUserRow(r), port: raw.port, instanceState: raw.instance_state }
    })
  }

  getById(id: number): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)
    return row === undefined ? null : toUserRow(row as never)
  }

  getByUsername(username: string): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username)
    return row === undefined ? null : toUserRow(row as never)
  }

  setStatus(id: number, status: 'active' | 'disabled'): void {
    this.db.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id)
    if (status === 'disabled') this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
  }

  setRole(id: number, role: 'admin' | 'user'): void {
    this.db.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).run(role, Date.now(), id)
  }

  async resetPassword(id: number, newPassword: string): Promise<void> {
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?`)
      .run(await hashPassword(newPassword), Date.now(), id)
    this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
  }

  async changeOwnPassword(id: number, newPassword: string): Promise<void> {
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`)
      .run(await hashPassword(newPassword), Date.now(), id)
  }
}
