import { isIP } from 'node:net'
import type { AuditRow } from '../audit.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

function sourceIp(ip: string | undefined): string | null {
  const normalized = (ip ?? '').replace(/^::ffff:/, '')
  return isIP(normalized) === 0 ? null : normalized
}

function detailValue(detail: string | undefined): unknown {
  if (detail === undefined || detail === '') return ''
  try {
    return JSON.parse(detail) as unknown
  } catch {
    return detail
  }
}

/** PostgreSQL-backed audit writer and filtered history for one organization. */
export class PostgresAuditService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  async write(entry: {
    userId?: number
    action: string
    methodPath?: string
    status?: number
    ip?: string
    detail?: string
  }): Promise<void> {
    await this.context.pool.query(`INSERT INTO harness.audit_events(
      organization_id,actor_user_id,action,resource_type,source_ip,outcome,status_code,detail
    ) VALUES($1,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2),$3,$4,$5,$6,$7,$8::jsonb)`, [
      this.context.organizationId,
      entry.userId ?? null,
      entry.action,
      entry.methodPath === undefined || entry.methodPath === '' ? null : 'http',
      sourceIp(entry.ip),
      entry.status !== undefined && entry.status >= 400 ? 'failure' : 'success',
      entry.status ?? null,
      JSON.stringify({ methodPath: entry.methodPath ?? '', detail: detailValue(entry.detail) }),
    ])
  }

  async query(filter: {
    userId?: number
    action?: string
    actionPrefix?: string
    fromMs?: number
    toMs?: number
    offset?: number
    limit?: number
  } = {}): Promise<AuditRow[]> {
    const clauses = ['e.organization_id=$1']
    const values: unknown[] = [this.context.organizationId]
    const add = (clause: string, value: unknown): void => {
      values.push(value)
      clauses.push(clause.replace('?', `$${String(values.length)}`))
    }
    if (filter.userId !== undefined) add('u.public_id=?', filter.userId)
    if (filter.action !== undefined) add('e.action LIKE ?', filter.action)
    if (filter.actionPrefix !== undefined) add('e.action LIKE ?', `${filter.actionPrefix}%`)
    if (filter.fromMs !== undefined) add('e.occurred_at >= to_timestamp(?/1000.0)', filter.fromMs)
    if (filter.toMs !== undefined) add('e.occurred_at <= to_timestamp(?/1000.0)', filter.toMs)
    values.push(filter.limit ?? 200)
    const limit = `$${String(values.length)}`
    values.push(filter.offset ?? 0)
    const offset = `$${String(values.length)}`
    const result = await this.context.pool.query<{
      id: string
      ts: string
      user_id: string | null
      action: string
      method_path: string
      status_code: number | null
      source_ip: string | null
      detail_text: string
    }>(`SELECT e.id::text,(extract(epoch FROM e.occurred_at)*1000)::text ts,
      u.public_id::text user_id,e.action,COALESCE(e.detail->>'methodPath','') method_path,
      e.status_code,e.source_ip::text,
      CASE WHEN e.detail ? 'detail' THEN e.detail->>'detail'
        WHEN e.detail ? 'legacyDetail' THEN e.detail->>'legacyDetail' ELSE '' END detail_text
      FROM harness.audit_events e
      LEFT JOIN harness.users u ON u.id=e.actor_user_id AND u.organization_id=e.organization_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.id DESC LIMIT ${limit} OFFSET ${offset}`, values)
    return result.rows.map(row => ({
      id: publicNumber(row.id, 'audit event'),
      ts: Number(row.ts),
      userId: row.user_id === null ? null : publicNumber(row.user_id, 'user'),
      action: row.action,
      methodPath: row.method_path,
      status: row.status_code,
      ip: row.source_ip ?? '',
      detail: row.detail_text,
    }))
  }
}
