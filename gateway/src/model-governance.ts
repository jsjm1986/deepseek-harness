import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'

export type CredentialClass = 'company' | 'personal' | 'unknown'
export type UsageStatus = 'succeeded' | 'failed' | 'cancelled' | 'missing-usage' | 'denied'

/** Durable owner charged for one model-usage record. */
export type ModelUsageSubject = { kind: 'user'; id: number } | { kind: 'project'; id: number }

export interface ModelRow {
  provider: string
  model: string
  displayName: string
  enabled: boolean
  adminAllowed: boolean
  userAllowed: boolean
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
}

export interface UsageEvent {
  eventId: string
  occurredAt: number
  provider: string
  model: string
  purpose: string
  sessionId?: string
  credentialSource: string
  credentialClass: CredentialClass
  status: UsageStatus
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

export interface UsageSummary {
  month: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostMicros: number
  companyCostMicros: number
  calls: number
  missingUsageCalls: number
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
  alerts: Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }>
}

const nonEmpty = (value: string, name: string): string => {
  const accepted = value.trim()
  if (accepted === '') throw new Error(`${name} must not be empty`)
  return accepted
}

const nonnegative = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}


function credentialClassOf(source: string): CredentialClass {
  if (source === 'file' || source === 'project-env' || source === 'request') return 'personal'
  if (source === 'env' || source === 'process' || source === 'user-env') return 'company'
  return 'unknown'
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function dateParts(time: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(time)
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

function localMidnight(year: number, month: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, 1)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = dateParts(candidate, timeZone)
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    const next = candidate + target - represented
    if (next === candidate) return candidate
    candidate = next
  }
  return candidate
}

function monthBounds(month: string, timeZone: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM')
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText); const value = Number(monthText)
  if (value < 1 || value > 12) throw new Error('month must be YYYY-MM')
  const nextYear = value === 12 ? year + 1 : year
  const nextMonth = value === 12 ? 1 : value + 1
  return { start: localMidnight(year, value, timeZone), end: localMidnight(nextYear, nextMonth, timeZone) }
}

function monthOf(time: number, timeZone: string): string {
  const parts = dateParts(time, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`
}

export class ModelGovernanceService {
  constructor(private readonly db: Database.Database, private readonly timeZone = 'Asia/Shanghai') {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  }

  listModels(): ModelRow[] {
    const rows = this.db.prepare(`
      SELECT m.*,
        COALESCE(a.allowed, 1) AS admin_allowed,
        COALESCE(u.allowed, 0) AS user_allowed,
        COALESCE(p.input_micros_per_million, 0) AS input_price,
        COALESCE(p.output_micros_per_million, 0) AS output_price,
        COALESCE(p.cache_read_micros_per_million, 0) AS cache_read_price,
        COALESCE(p.cache_write_micros_per_million, 0) AS cache_write_price
      FROM model_catalog m
      LEFT JOIN model_role_access a ON a.role='admin' AND a.provider=m.provider AND a.model=m.model
      LEFT JOIN model_role_access u ON u.role='user' AND u.provider=m.provider AND u.model=m.model
      LEFT JOIN model_prices p ON p.id = (
        SELECT id FROM model_prices px WHERE px.provider=m.provider AND px.model=m.model
        ORDER BY effective_at DESC, id DESC LIMIT 1
      )
      ORDER BY m.provider, m.model
    `).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      provider: String(row.provider), model: String(row.model), displayName: String(row.display_name),
      enabled: row.enabled === 1, adminAllowed: row.admin_allowed === 1, userAllowed: row.user_allowed === 1,
      inputMicrosPerMillion: Number(row.input_price), outputMicrosPerMillion: Number(row.output_price),
      cacheReadMicrosPerMillion: Number(row.cache_read_price), cacheWriteMicrosPerMillion: Number(row.cache_write_price),
    }))
  }

  upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & { adminAllowed?: boolean; userAllowed?: boolean }): void {
    const provider = nonEmpty(input.provider, 'provider')
    const model = nonEmpty(input.model, 'model')
    const now = Date.now()
    const apply = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO model_catalog(provider, model, display_name, enabled, created_at, updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET display_name=excluded.display_name,
        enabled=excluded.enabled, updated_at=excluded.updated_at`)
        .run(provider, model, nonEmpty(input.displayName, 'displayName'), input.enabled ? 1 : 0, now, now)
      for (const [role, allowed] of [['admin', input.adminAllowed ?? true], ['user', input.userAllowed ?? false]] as const) {
        this.db.prepare(`INSERT INTO model_role_access(role,provider,model,allowed) VALUES(?,?,?,?)
          ON CONFLICT(role,provider,model) DO UPDATE SET allowed=excluded.allowed`).run(role, provider, model, allowed ? 1 : 0)
      }
      const prices = [input.inputMicrosPerMillion, input.outputMicrosPerMillion,
        input.cacheReadMicrosPerMillion, input.cacheWriteMicrosPerMillion]
        .map((value, index) => nonnegative(value, `price[${index}]`))
      const latest = this.db.prepare(`SELECT MAX(effective_at) AS at FROM model_prices WHERE provider=? AND model=?`)
        .get(provider, model) as { at: number | null }
      const effectiveAt = Math.max(now, (latest.at ?? -1) + 1)
      this.db.prepare(`INSERT INTO model_prices(provider,model,effective_at,input_micros_per_million,
        output_micros_per_million,cache_read_micros_per_million,cache_write_micros_per_million)
        VALUES(?,?,?,?,?,?,?)`).run(provider, model, effectiveAt, ...prices)
    })
    apply()
  }

  setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): void {
    provider = nonEmpty(provider, 'provider')
    model = nonEmpty(model, 'model')
    if (this.db.prepare(`SELECT 1 FROM model_catalog WHERE provider=? AND model=?`).get(provider, model) === undefined) {
      throw new Error(`unknown model ${provider}/${model}`)
    }
    if (allowed === null) {
      this.db.prepare(`DELETE FROM model_user_access WHERE user_id=? AND provider=? AND model=?`).run(userId, provider, model)
      return
    }
    this.db.prepare(`INSERT INTO model_user_access(user_id,provider,model,allowed) VALUES(?,?,?,?)
      ON CONFLICT(user_id,provider,model) DO UPDATE SET allowed=excluded.allowed`).run(userId, provider, model, allowed ? 1 : 0)
  }

  userOverrides(userId: number): Array<{ provider: string; model: string; allowed: boolean }> {
    const rows = this.db.prepare(`SELECT provider,model,allowed FROM model_user_access WHERE user_id=? ORDER BY provider,model`)
      .all(userId) as Array<{ provider: string; model: string; allowed: number }>
    return rows.map(row => ({ provider: row.provider, model: row.model, allowed: row.allowed === 1 }))
  }

  policyFor(user: UserRow): { version: number; defaultAllowed: boolean; models: Array<{ provider: string; model: string; allowed: boolean }> } {
    const rows = this.db.prepare(`SELECT m.provider,m.model,m.enabled,
      COALESCE(x.allowed,r.allowed,CASE WHEN ?='admin' THEN 1 ELSE 0 END) AS allowed
      FROM model_catalog m
      LEFT JOIN model_role_access r ON r.role=? AND r.provider=m.provider AND r.model=m.model
      LEFT JOIN model_user_access x ON x.user_id=? AND x.provider=m.provider AND x.model=m.model
      ORDER BY m.provider,m.model`).all(user.role, user.role, user.id) as Array<{
        provider: string; model: string; enabled: number; allowed: number
      }>
    return {
      version: Date.now(),
      defaultAllowed: user.role === 'admin',
      models: rows.map(row => ({ provider: row.provider, model: row.model, allowed: row.enabled === 1 && row.allowed === 1 })),
    }
  }

  policyForProject(_projectId: number): {
    version: number
    defaultAllowed: false
    models: Array<{ provider: string; model: string; allowed: boolean }>
  } {
    throw new Error('SQLite model governance has no project runtime support')
  }

  private userId(subject: ModelUsageSubject): number {
    if (subject.kind !== 'user') throw new Error('SQLite model governance has no project runtime support')
    return subject.id
  }

  issueIntakeToken(subject: ModelUsageSubject): string {
    const userId = this.userId(subject)
    const token = randomBytes(32).toString('base64url')
    this.db.prepare(`INSERT INTO model_intake_tokens(user_id,token_hash,created_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at`)
      .run(userId, tokenHash(token), Date.now())
    return token
  }

  subjectForIntakeToken(token: string): ModelUsageSubject | null {
    const row = this.db.prepare(`SELECT user_id FROM model_intake_tokens WHERE token_hash=?`).get(tokenHash(token)) as
      { user_id: number } | undefined
    return row === undefined ? null : { kind: 'user', id: row.user_id }
  }

  setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): void {
    subjectId = nonEmpty(subjectId, 'subjectId')
    if (subjectType === 'project') throw new Error('SQLite model governance has no project runtime support')
    if (subjectType === 'role' && subjectId !== 'admin' && subjectId !== 'user') throw new Error('role quota subject must be admin or user')
    if (subjectType === 'user' && (!Number.isSafeInteger(Number(subjectId)) || Number(subjectId) <= 0)) throw new Error('user quota subject must be a positive user id')
    if (subjectType === 'role' && (tokenLimit === 'inherit' || costLimit === 'inherit')) {
      throw new Error('role quotas cannot inherit')
    }
    const stored = (value: number | null | 'inherit', name: string): number | null =>
      value === 'inherit' ? -1 : value === null ? null : nonnegative(value, name)
    if (subjectType === 'user' && tokenLimit === 'inherit' && costLimit === 'inherit') {
      this.db.prepare(`DELETE FROM model_quotas WHERE subject_type='user' AND subject_id=?`).run(subjectId)
      return
    }
    this.db.prepare(`INSERT INTO model_quotas(subject_type,subject_id,token_limit,company_cost_micros_limit)
      VALUES(?,?,?,?) ON CONFLICT(subject_type,subject_id) DO UPDATE SET token_limit=excluded.token_limit,
      company_cost_micros_limit=excluded.company_cost_micros_limit`)
      .run(subjectType, subjectId, stored(tokenLimit, 'tokenLimit'), stored(costLimit, 'companyCostMicrosLimit'))
  }

  ingest(subject: ModelUsageSubject, event: UsageEvent): { inserted: boolean; alerts: number } {
    const userId = this.userId(subject)
    if (event === null || typeof event !== 'object') throw new Error('usage event must be an object')
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) throw new Error('occurredAt must be a non-negative safe integer')
    if (!['company', 'personal', 'unknown'].includes(event.credentialClass)) throw new Error('invalid credentialClass')
    if (!['succeeded', 'failed', 'cancelled', 'missing-usage', 'denied'].includes(event.status)) throw new Error('invalid status')
    if (typeof event.credentialSource !== 'string') throw new Error('credentialSource must be a string')
    const credentialClass = credentialClassOf(event.credentialSource)
    if (event.credentialClass !== credentialClass) throw new Error('credentialClass does not match credentialSource')
    const usage = event.usage
    const buckets = {
      input: nonnegative(usage?.inputTokens ?? 0, 'inputTokens'),
      output: nonnegative(usage?.outputTokens ?? 0, 'outputTokens'),
      read: nonnegative(usage?.cacheReadTokens ?? 0, 'cacheReadTokens'),
      write: nonnegative(usage?.cacheWriteTokens ?? 0, 'cacheWriteTokens'),
    }
    const price = this.db.prepare(`SELECT * FROM model_prices WHERE provider=? AND model=? AND effective_at<=?
      ORDER BY effective_at DESC,id DESC LIMIT 1`).get(event.provider, event.model, event.occurredAt) as
      | { input_micros_per_million: number; output_micros_per_million: number;
        cache_read_micros_per_million: number; cache_write_micros_per_million: number }
      | undefined
    const estimated = price === undefined ? 0 : Math.round((
      buckets.input * price.input_micros_per_million + buckets.output * price.output_micros_per_million
      + buckets.read * price.cache_read_micros_per_million + buckets.write * price.cache_write_micros_per_million
    ) / 1_000_000)
    const companyCost = credentialClass === 'personal' ? 0 : estimated
    const insert = this.db.prepare(`INSERT OR IGNORE INTO model_usage(event_id,user_id,occurred_at,received_at,provider,model,
      purpose,session_id,credential_source,credential_class,status,input_tokens,output_tokens,cache_read_tokens,
      cache_write_tokens,estimated_cost_micros,company_cost_micros) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(event.eventId, userId, event.occurredAt, Date.now(), nonEmpty(event.provider, 'provider'),
        nonEmpty(event.model, 'model'), nonEmpty(event.purpose, 'purpose'), event.sessionId ?? null,
        event.credentialSource, credentialClass, event.status, buckets.input, buckets.output, buckets.read,
        buckets.write, estimated, companyCost)
    if (insert.changes === 0) return { inserted: false, alerts: 0 }
    return { inserted: true, alerts: this.evaluateAlerts(userId, monthOf(event.occurredAt, this.timeZone)) }
  }

  summary(subject: ModelUsageSubject, month = monthOf(Date.now(), this.timeZone)): UsageSummary {
    const userId = this.userId(subject)
    const { start, end } = monthBounds(month, this.timeZone)
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input,COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(SUM(cache_read_tokens),0) AS read,COALESCE(SUM(cache_write_tokens),0) AS write,
      COALESCE(SUM(estimated_cost_micros),0) AS cost,COALESCE(SUM(company_cost_micros),0) AS company,
      COUNT(*) AS calls,COALESCE(SUM(CASE WHEN status='missing-usage' THEN 1 ELSE 0 END),0) AS missing
      FROM model_usage WHERE user_id=? AND occurred_at>=? AND occurred_at<?`).get(userId, start, end) as {
        input: number; output: number; read: number; write: number; cost: number; company: number; calls: number; missing: number
      }
    const user = this.db.prepare(`SELECT role FROM users WHERE id=? AND deleted_at IS NULL`).get(userId) as { role: string } | undefined
    const userQuota = this.db.prepare(`SELECT * FROM model_quotas WHERE subject_type='user' AND subject_id=?`).get(String(userId)) as
      { token_limit: number | null; company_cost_micros_limit: number | null } | undefined
    const roleQuota = user === undefined ? undefined : this.db.prepare(
      `SELECT * FROM model_quotas WHERE subject_type='role' AND subject_id=?`,
    ).get(user.role) as { token_limit: number | null; company_cost_micros_limit: number | null } | undefined
    const alerts = this.db.prepare(`SELECT metric,threshold,created_at FROM model_usage_alerts WHERE user_id=? AND month=?
      ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END, threshold`).all(userId, month) as Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; created_at: number }>
    const total = row.input + row.output + row.read + row.write
    const quota = (userValue: number | null | undefined, roleValue: number | null | undefined): number | null =>
      userValue === undefined || userValue === -1 ? roleValue ?? null : userValue
    return {
      month, inputTokens: row.input, outputTokens: row.output, cacheReadTokens: row.read, cacheWriteTokens: row.write,
      totalTokens: total, estimatedCostMicros: row.cost, companyCostMicros: row.company, calls: row.calls,
      missingUsageCalls: row.missing, tokenLimit: quota(userQuota?.token_limit, roleQuota?.token_limit),
      companyCostMicrosLimit: quota(userQuota?.company_cost_micros_limit, roleQuota?.company_cost_micros_limit),
      alerts: alerts.map(alert => ({ metric: alert.metric, threshold: alert.threshold, createdAt: alert.created_at })),
    }
  }

  private evaluateAlerts(userId: number, month: string): number {
    const summary = this.summary({ kind: 'user', id: userId }, month)
    let inserted = 0
    for (const [metric, value, limit] of [
      ['tokens', summary.totalTokens, summary.tokenLimit],
      ['company-cost', summary.companyCostMicros, summary.companyCostMicrosLimit],
    ] as const) {
      if (limit === null || limit <= 0) continue
      for (const threshold of [80, 100] as const) {
        if (value * 100 < limit * threshold) continue
        inserted += this.db.prepare(`INSERT OR IGNORE INTO model_usage_alerts(user_id,month,metric,threshold,created_at)
          VALUES(?,?,?,?,?)`).run(userId, month, metric, threshold, Date.now()).changes
      }
    }
    return inserted
  }
}
