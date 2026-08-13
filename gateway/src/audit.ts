import type Database from 'better-sqlite3'

export interface AuditRow {
  id: number
  ts: number
  userId: number | null
  action: string
  methodPath: string
  status: number | null
  ip: string
  detail: string
}

export class AuditService {
  constructor(private readonly db: Database.Database) {}

  write(entry: { userId?: number; action: string; methodPath?: string; status?: number; ip?: string; detail?: string }): void {
    this.db.prepare(
      `INSERT INTO audit_log(ts, user_id, action, method_path, status, ip, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), entry.userId ?? null, entry.action, entry.methodPath ?? '', entry.status ?? null, entry.ip ?? '', entry.detail ?? '')
  }

  query(filter: { userId?: number; action?: string; sinceMs?: number; limit?: number } = {}): AuditRow[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.userId !== undefined) { clauses.push('user_id = ?'); params.push(filter.userId) }
    if (filter.action !== undefined) { clauses.push('action = ?'); params.push(filter.action) }
    if (filter.sinceMs !== undefined) { clauses.push('ts >= ?'); params.push(filter.sinceMs) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...params, filter.limit ?? 200) as
      Array<{ id: number; ts: number; user_id: number | null; action: string; method_path: string; status: number | null; ip: string; detail: string }>
    return rows.map(r => ({ id: r.id, ts: r.ts, userId: r.user_id, action: r.action, methodPath: r.method_path, status: r.status, ip: r.ip, detail: r.detail }))
  }
}
