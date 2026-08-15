import { createHash, randomBytes } from 'node:crypto'
import type { UserRow } from '../auth.ts'
import type {
  CredentialClass,
  ModelUsageSubject,
  ModelRow,
  UsageEvent,
  UsageSummary,
} from '../model-governance.ts'
import type { Queryable } from './database.ts'
import { transaction } from './database.ts'
import { internalProjectId, internalUserId, type PostgresRuntimeContext } from './runtime-context.ts'

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

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function microsToDecimal(value: number): string {
  nonnegative(value, 'monetary value')
  return `${String(Math.floor(value / 1_000_000))}.${String(value % 1_000_000).padStart(6, '0')}`
}

function decimalToMicros(value: string | number): number {
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) throw new Error(`invalid non-negative decimal monetary value: ${text}`)
  const whole = Number(match[1])
  const fraction = (match[2] ?? '').padEnd(7, '0')
  let micros = whole * 1_000_000 + Number(fraction.slice(0, 6))
  if (Number(fraction[6]) >= 5) micros += 1
  if (!Number.isSafeInteger(micros)) throw new Error(`monetary value exceeds safe integer range: ${text}`)
  return micros
}

function safeCount(value: string | number, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} exceeds safe integer range`)
  return number
}

function dateParts(time: number, timeZone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(time)
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function localMidnight(year: number, month: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, 1)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = dateParts(candidate, timeZone)
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    )
    const next = candidate + target - represented
    if (next === candidate) return candidate
    candidate = next
  }
  return candidate
}

function monthBounds(month: string, timeZone: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM')
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const value = Number(monthText)
  if (value < 1 || value > 12) throw new Error('month must be YYYY-MM')
  return {
    start: localMidnight(year, value, timeZone),
    end: localMidnight(value === 12 ? year + 1 : year, value === 12 ? 1 : value + 1, timeZone),
  }
}

function monthOf(time: number, timeZone: string): string {
  const parts = dateParts(time, timeZone)
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}`
}

function roleForPostgres(role: 'admin' | 'user'): 'admin' | 'member' {
  return role === 'admin' ? 'admin' : 'member'
}

interface UsageTotalsRow {
  input: string
  output: string
  read: string
  write: string
  cost: string
  company: string
  calls: string
  missing: string
}

interface UsageAlertRow {
  metric: 'tokens' | 'company-cost'
  threshold: 80 | 100
  created_at: Date
}

function usageSummary(
  month: string,
  row: UsageTotalsRow,
  tokenLimit: number | null,
  companyCostMicrosLimit: number | null,
  alerts: readonly UsageAlertRow[],
): UsageSummary {
  const input = safeCount(row.input, 'input tokens')
  const output = safeCount(row.output, 'output tokens')
  const read = safeCount(row.read, 'cache read tokens')
  const write = safeCount(row.write, 'cache write tokens')
  return {
    month,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    totalTokens: input + output + read + write,
    estimatedCostMicros: decimalToMicros(row.cost),
    companyCostMicros: decimalToMicros(row.company),
    calls: safeCount(row.calls, 'usage calls'),
    missingUsageCalls: safeCount(row.missing, 'missing usage calls'),
    tokenLimit,
    companyCostMicrosLimit,
    alerts: alerts.map(alert => ({
      metric: alert.metric,
      threshold: alert.threshold,
      createdAt: alert.created_at.getTime(),
    })),
  }
}

/** PostgreSQL-backed model access, pricing, quotas, and usage accounting. */
export class PostgresModelGovernanceService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly timeZone = 'Asia/Shanghai',
  ) {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  }

  async listModels(): Promise<ModelRow[]> {
    const result = await this.context.pool.query<{
      provider: string
      model: string
      display_name: string
      enabled: boolean
      admin_allowed: boolean
      user_allowed: boolean
      input_price: string
      output_price: string
      cache_read_price: string
      cache_write_price: string
    }>(`SELECT m.provider_key provider,m.model_key model,m.display_name,m.enabled,
      COALESCE(a.allowed,true) admin_allowed,COALESCE(u.allowed,false) user_allowed,
      COALESCE(p.input_per_million,0)::text input_price,
      COALESCE(p.output_per_million,0)::text output_price,
      COALESCE(p.cache_read_per_million,0)::text cache_read_price,
      COALESCE(p.cache_write_per_million,0)::text cache_write_price
      FROM harness.model_catalog m
      LEFT JOIN harness.model_role_access a ON a.organization_id=m.organization_id
        AND a.model_id=m.id AND a.role='admin'
      LEFT JOIN harness.model_role_access u ON u.organization_id=m.organization_id
        AND u.model_id=m.id AND u.role='member'
      LEFT JOIN LATERAL (SELECT * FROM harness.model_prices p
        WHERE p.model_id=m.id ORDER BY p.effective_at DESC,p.id DESC LIMIT 1) p ON true
      WHERE m.organization_id=$1 ORDER BY m.provider_key,m.model_key`, [this.context.organizationId])
    return result.rows.map(row => ({
      provider: row.provider,
      model: row.model,
      displayName: row.display_name,
      enabled: row.enabled,
      adminAllowed: row.admin_allowed,
      userAllowed: row.user_allowed,
      inputMicrosPerMillion: decimalToMicros(row.input_price),
      outputMicrosPerMillion: decimalToMicros(row.output_price),
      cacheReadMicrosPerMillion: decimalToMicros(row.cache_read_price),
      cacheWriteMicrosPerMillion: decimalToMicros(row.cache_write_price),
    }))
  }

  async upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & {
    adminAllowed?: boolean
    userAllowed?: boolean
  }): Promise<void> {
    const provider = nonEmpty(input.provider, 'provider')
    const model = nonEmpty(input.model, 'model')
    const prices = [
      input.inputMicrosPerMillion,
      input.outputMicrosPerMillion,
      input.cacheReadMicrosPerMillion,
      input.cacheWriteMicrosPerMillion,
    ].map((value, index) => microsToDecimal(nonnegative(value, `price[${String(index)}]`)))
    await transaction(this.context.pool, async (client) => {
      const catalog = await client.query<{ id: string }>(`INSERT INTO harness.model_catalog(
        organization_id,provider_key,model_key,display_name,enabled
      ) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,provider_key,model_key) DO UPDATE SET
        display_name=excluded.display_name,enabled=excluded.enabled,updated_at=now() RETURNING id`,
      [this.context.organizationId, provider, model, nonEmpty(input.displayName, 'displayName'), input.enabled])
      const modelId = catalog.rows[0]?.id
      if (modelId === undefined) throw new Error('model upsert returned no row')
      for (const [role, allowed] of [
        ['admin', input.adminAllowed ?? true],
        ['member', input.userAllowed ?? false],
      ] as const) {
        await client.query(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
          VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [this.context.organizationId, role, modelId, allowed])
      }
      const latest = await client.query<{ effective_at: Date }>(`SELECT GREATEST(
        clock_timestamp(),COALESCE(MAX(effective_at)+interval '1 microsecond',clock_timestamp())
      ) effective_at FROM harness.model_prices WHERE model_id=$1`, [modelId])
      await client.query(`INSERT INTO harness.model_prices(model_id,effective_at,input_per_million,
        output_per_million,cache_read_per_million,cache_write_per_million)
        VALUES($1,$2,$3,$4,$5,$6)`, [modelId, latest.rows[0]!.effective_at, ...prices])
    })
  }

  async setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): Promise<void> {
    provider = nonEmpty(provider, 'provider')
    model = nonEmpty(model, 'model')
    await transaction(this.context.pool, async (client) => {
      const user = await internalUserId(client, this.context.organizationId, userId)
      if (user === null) throw new Error(`unknown user ${String(userId)}`)
      const catalog = await client.query<{ id: string }>(`SELECT id FROM harness.model_catalog
        WHERE organization_id=$1 AND provider_key=$2 AND model_key=$3`,
      [this.context.organizationId, provider, model])
      const modelId = catalog.rows[0]?.id
      if (modelId === undefined) throw new Error(`unknown model ${provider}/${model}`)
      if (allowed === null) {
        await client.query('DELETE FROM harness.model_user_access WHERE user_id=$1 AND model_id=$2', [user, modelId])
      } else {
        await client.query(`INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed)
          VALUES($1,$2,$3,$4) ON CONFLICT(user_id,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [this.context.organizationId, user, modelId, allowed])
      }
    })
  }

  async userOverrides(userId: number): Promise<Array<{ provider: string; model: string; allowed: boolean }>> {
    const result = await this.context.pool.query<{ provider: string; model: string; allowed: boolean }>(`SELECT
      m.provider_key provider,m.model_key model,x.allowed
      FROM harness.model_user_access x
      JOIN harness.users u ON u.id=x.user_id AND u.organization_id=x.organization_id
      JOIN harness.model_catalog m ON m.id=x.model_id AND m.organization_id=x.organization_id
      WHERE x.organization_id=$1 AND u.public_id=$2 ORDER BY m.provider_key,m.model_key`,
    [this.context.organizationId, userId])
    return result.rows
  }

  async policyFor(user: UserRow): Promise<{
    version: number
    defaultAllowed: boolean
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }> {
    const result = await this.context.pool.query<{
      provider: string
      model: string
      enabled: boolean
      allowed: boolean
    }>(`SELECT m.provider_key provider,m.model_key model,m.enabled,
      COALESCE(x.allowed,r.allowed,$3::boolean) allowed
      FROM harness.model_catalog m
      LEFT JOIN harness.model_role_access r ON r.organization_id=m.organization_id
        AND r.model_id=m.id AND r.role=$4
      LEFT JOIN harness.users u ON u.organization_id=m.organization_id AND u.public_id=$2
      LEFT JOIN harness.model_user_access x ON x.organization_id=m.organization_id
        AND x.model_id=m.id AND x.user_id=u.id
      WHERE m.organization_id=$1 ORDER BY m.provider_key,m.model_key`,
    [this.context.organizationId, user.id, user.role === 'admin', roleForPostgres(user.role)])
    return {
      version: Date.now(),
      defaultAllowed: user.role === 'admin',
      models: result.rows.map(row => ({
        provider: row.provider,
        model: row.model,
        allowed: row.enabled && row.allowed,
      })),
    }
  }

  async policyForProject(projectId: number): Promise<{
    version: number
    defaultAllowed: false
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }> {
    if (await internalProjectId(this.context.pool, this.context.organizationId, projectId) === null) {
      throw new Error(`unknown project ${String(projectId)}`)
    }
    const result = await this.context.pool.query<{
      provider: string
      model: string
      enabled: boolean
      allowed: boolean
    }>(`SELECT m.provider_key provider,m.model_key model,m.enabled,
      COALESCE(r.allowed,false) allowed
      FROM harness.model_catalog m
      LEFT JOIN harness.model_role_access r ON r.organization_id=m.organization_id
        AND r.model_id=m.id AND r.role='member'
      WHERE m.organization_id=$1 ORDER BY m.provider_key,m.model_key`, [this.context.organizationId])
    return {
      version: Date.now(),
      defaultAllowed: false,
      models: result.rows.map(row => ({
        provider: row.provider,
        model: row.model,
        allowed: row.enabled && row.allowed,
      })),
    }
  }

  async issueIntakeToken(subject: ModelUsageSubject): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    if (subject.kind === 'user') {
      const user = await internalUserId(this.context.pool, this.context.organizationId, subject.id)
      if (user === null) throw new Error(`unknown user ${String(subject.id)}`)
      await this.context.pool.query(`INSERT INTO harness.model_intake_tokens(user_id,token_hash)
        VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now()`,
      [user, tokenHash(token)])
    } else {
      const project = await internalProjectId(this.context.pool, this.context.organizationId, subject.id)
      if (project === null) throw new Error(`unknown project ${String(subject.id)}`)
      await this.context.pool.query(`INSERT INTO harness.project_model_intake_tokens(project_id,token_hash)
        VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now()`,
      [project, tokenHash(token)])
    }
    return token
  }

  async subjectForIntakeToken(token: string): Promise<ModelUsageSubject | null> {
    const result = await this.context.pool.query<{ kind: 'user' | 'project'; public_id: string }>(`SELECT
      'user'::text kind,u.public_id::text public_id
      FROM harness.model_intake_tokens t
      JOIN harness.users u ON u.id=t.user_id
      WHERE u.organization_id=$1 AND t.token_hash=$2
      UNION ALL
      SELECT 'project'::text kind,p.public_id::text public_id
      FROM harness.project_model_intake_tokens t
      JOIN harness.projects p ON p.id=t.project_id
      WHERE p.organization_id=$1 AND t.token_hash=$2`, [this.context.organizationId, tokenHash(token)])
    if (result.rows.length > 1) throw new Error('model intake token resolves more than one subject')
    const row = result.rows[0]
    return row === undefined ? null : { kind: row.kind, id: safeCount(row.public_id, `${row.kind} id`) }
  }

  async setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): Promise<void> {
    subjectId = nonEmpty(subjectId, 'subjectId')
    if (subjectType === 'role') {
      if (subjectId !== 'admin' && subjectId !== 'user') throw new Error('role quota subject must be admin or user')
      if (tokenLimit === 'inherit' || costLimit === 'inherit') throw new Error('role quotas cannot inherit')
      await this.context.pool.query(`INSERT INTO harness.role_quotas(
        organization_id,role,token_limit,company_cost_limit
      ) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role) DO UPDATE SET
        token_limit=excluded.token_limit,company_cost_limit=excluded.company_cost_limit`, [
        this.context.organizationId,
        roleForPostgres(subjectId),
        tokenLimit === null ? null : nonnegative(tokenLimit, 'tokenLimit'),
        costLimit === null ? null : microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')),
      ])
      return
    }
    const publicId = Number(subjectId)
    if (!Number.isSafeInteger(publicId) || publicId <= 0) {
      throw new Error(`${subjectType} quota subject must be a positive ${subjectType} id`)
    }
    if (subjectType === 'project') {
      const project = await internalProjectId(this.context.pool, this.context.organizationId, publicId)
      if (project === null) throw new Error(`unknown project ${subjectId}`)
      if (tokenLimit === 'inherit' && costLimit === 'inherit') {
        await this.context.pool.query('DELETE FROM harness.project_quotas WHERE project_id=$1', [project])
        return
      }
      if (tokenLimit === 'inherit' || costLimit === 'inherit') {
        throw new Error('project quota fields must both inherit or both be explicit')
      }
      await this.context.pool.query(`INSERT INTO harness.project_quotas(
        project_id,token_limit,company_cost_limit
      ) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET
        token_limit=excluded.token_limit,company_cost_limit=excluded.company_cost_limit`, [
        project,
        tokenLimit === null ? null : nonnegative(tokenLimit, 'tokenLimit'),
        costLimit === null ? null : microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')),
      ])
      return
    }
    const user = await internalUserId(this.context.pool, this.context.organizationId, publicId)
    if (user === null) throw new Error(`unknown user ${subjectId}`)
    if (tokenLimit === 'inherit' && costLimit === 'inherit') {
      await this.context.pool.query('DELETE FROM harness.user_quotas WHERE user_id=$1', [user])
      return
    }
    const tokenMode = tokenLimit === 'inherit' ? 'inherit' : tokenLimit === null ? 'unlimited' : 'custom'
    const costMode = costLimit === 'inherit' ? 'inherit' : costLimit === null ? 'unlimited' : 'custom'
    await this.context.pool.query(`INSERT INTO harness.user_quotas(
      user_id,token_mode,token_limit,company_cost_mode,company_cost_limit
    ) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET
      token_mode=excluded.token_mode,token_limit=excluded.token_limit,
      company_cost_mode=excluded.company_cost_mode,company_cost_limit=excluded.company_cost_limit`, [
      user,
      tokenMode,
      typeof tokenLimit === 'number' ? nonnegative(tokenLimit, 'tokenLimit') : null,
      costMode,
      typeof costLimit === 'number' ? microsToDecimal(nonnegative(costLimit, 'companyCostMicrosLimit')) : null,
    ])
  }

  async ingest(subject: ModelUsageSubject, event: UsageEvent): Promise<{ inserted: boolean; alerts: number }> {
    if (event === null || typeof event !== 'object') throw new Error('usage event must be an object')
    nonEmpty(event.eventId, 'eventId')
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new Error('occurredAt must be a non-negative safe integer')
    }
    if (!['company', 'personal', 'unknown'].includes(event.credentialClass)) throw new Error('invalid credentialClass')
    if (!['succeeded', 'failed', 'cancelled', 'missing-usage', 'denied'].includes(event.status)) {
      throw new Error('invalid status')
    }
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
    const provider = nonEmpty(event.provider, 'provider')
    const model = nonEmpty(event.model, 'model')
    return transaction(this.context.pool, async (client) => {
      const user = subject.kind === 'user'
        ? await internalUserId(client, this.context.organizationId, subject.id)
        : null
      const project = subject.kind === 'project'
        ? await internalProjectId(client, this.context.organizationId, subject.id)
        : null
      if (subject.kind === 'user' && user === null) throw new Error(`unknown user ${String(subject.id)}`)
      if (subject.kind === 'project' && project === null) throw new Error(`unknown project ${String(subject.id)}`)
      const catalog = await client.query<{
        id: string
        input_price: string | null
        output_price: string | null
        cache_read_price: string | null
        cache_write_price: string | null
      }>(`SELECT m.id,p.input_per_million::text input_price,p.output_per_million::text output_price,
        p.cache_read_per_million::text cache_read_price,p.cache_write_per_million::text cache_write_price
        FROM harness.model_catalog m LEFT JOIN LATERAL (
          SELECT * FROM harness.model_prices p WHERE p.model_id=m.id
            AND p.effective_at<=to_timestamp($4/1000.0)
          ORDER BY p.effective_at DESC,p.id DESC LIMIT 1
        ) p ON true WHERE m.organization_id=$1 AND m.provider_key=$2 AND m.model_key=$3`,
      [this.context.organizationId, provider, model, event.occurredAt])
      const price = catalog.rows[0]
      const estimated = price?.input_price === null || price?.input_price === undefined ? 0 : Math.round((
        buckets.input * decimalToMicros(price.input_price)
        + buckets.output * decimalToMicros(price.output_price ?? '0')
        + buckets.read * decimalToMicros(price.cache_read_price ?? '0')
        + buckets.write * decimalToMicros(price.cache_write_price ?? '0')
      ) / 1_000_000)
      const companyCost = credentialClass === 'personal' ? 0 : estimated
      const inserted = await client.query<{ event_id: string }>(`INSERT INTO harness.model_usage(
        event_id,organization_id,user_id,project_id,occurred_at,received_at,model_id,provider_key,model_key,purpose,
        session_id,credential_source,credential_class,status,input_tokens,output_tokens,cache_read_tokens,
        cache_write_tokens,estimated_cost,company_cost
      ) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),now(),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT(organization_id,event_id) DO NOTHING RETURNING event_id`, [
        event.eventId,
        this.context.organizationId,
        user,
        project,
        event.occurredAt,
        price?.id ?? null,
        provider,
        model,
        nonEmpty(event.purpose, 'purpose'),
        event.sessionId ?? null,
        event.credentialSource,
        credentialClass,
        event.status,
        buckets.input,
        buckets.output,
        buckets.read,
        buckets.write,
        microsToDecimal(estimated),
        microsToDecimal(companyCost),
      ])
      if (inserted.rows.length === 0) return { inserted: false, alerts: 0 }
      return {
        inserted: true,
        alerts: await this.evaluateAlerts(client, subject, monthOf(event.occurredAt, this.timeZone)),
      }
    })
  }

  async summary(subject: ModelUsageSubject, month = monthOf(Date.now(), this.timeZone)): Promise<UsageSummary> {
    return this.summaryWith(this.context.pool, subject, month)
  }

  private async usageTotals(
    queryable: Queryable,
    subject: ModelUsageSubject,
    internalId: string,
    month: string,
  ): Promise<UsageTotalsRow> {
    const { start, end } = monthBounds(month, this.timeZone)
    const subjectColumn = subject.kind === 'user' ? 'user_id' : 'project_id'
    const usage = await queryable.query<UsageTotalsRow>(`SELECT COALESCE(SUM(input_tokens),0)::text input,
      COALESCE(SUM(output_tokens),0)::text output,COALESCE(SUM(cache_read_tokens),0)::text read,
      COALESCE(SUM(cache_write_tokens),0)::text write,COALESCE(SUM(estimated_cost),0)::text cost,
      COALESCE(SUM(company_cost),0)::text company,COUNT(*)::text calls,
      COUNT(*) FILTER (WHERE status='missing-usage')::text missing
      FROM harness.model_usage WHERE organization_id=$1 AND ${subjectColumn}=$2
        AND occurred_at>=to_timestamp($3/1000.0) AND occurred_at<to_timestamp($4/1000.0)`,
    [this.context.organizationId, internalId, start, end])
    return usage.rows[0]!
  }

  private async summaryWith(
    queryable: Queryable,
    subject: ModelUsageSubject,
    month: string,
  ): Promise<UsageSummary> {
    return subject.kind === 'user'
      ? this.userSummaryWith(queryable, subject.id, month)
      : this.projectSummaryWith(queryable, subject.id, month)
  }

  private async userSummaryWith(queryable: Queryable, userId: number, month: string): Promise<UsageSummary> {
    const user = await queryable.query<{ id: string; role: 'admin' | 'member' }>(`SELECT u.id,m.role
      FROM harness.users u JOIN harness.memberships m
        ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [this.context.organizationId, userId])
    const identity = user.rows[0]
    if (identity === undefined) throw new Error(`unknown user ${String(userId)}`)
    const row = await this.usageTotals(queryable, { kind: 'user', id: userId }, identity.id, month)
    const userQuota = await queryable.query<{
      token_mode: 'inherit' | 'unlimited' | 'custom'
      token_limit: string | null
      company_cost_mode: 'inherit' | 'unlimited' | 'custom'
      company_cost_limit: string | null
    }>('SELECT token_mode,token_limit::text,company_cost_mode,company_cost_limit::text FROM harness.user_quotas WHERE user_id=$1',
    [identity.id])
    const roleQuota = await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
      token_limit::text,company_cost_limit::text FROM harness.role_quotas
      WHERE organization_id=$1 AND role=$2`, [this.context.organizationId, identity.role])
    const alerts = await queryable.query<UsageAlertRow>(`SELECT metric,threshold,created_at FROM harness.model_usage_alerts
      WHERE user_id=$1 AND period_start=$2::date ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END,threshold`,
    [identity.id, `${month}-01`])
    const userLimits = userQuota.rows[0]
    const roleLimits = roleQuota.rows[0]
    const inheritedToken = roleLimits?.token_limit === null || roleLimits?.token_limit === undefined
      ? null
      : safeCount(roleLimits.token_limit, 'role token limit')
    const inheritedCost = roleLimits?.company_cost_limit === null || roleLimits?.company_cost_limit === undefined
      ? null
      : decimalToMicros(roleLimits.company_cost_limit)
    const tokenLimit = userLimits === undefined || userLimits.token_mode === 'inherit'
      ? inheritedToken
      : userLimits.token_mode === 'unlimited'
        ? null
        : safeCount(userLimits.token_limit!, 'user token limit')
    const companyCostMicrosLimit = userLimits === undefined || userLimits.company_cost_mode === 'inherit'
      ? inheritedCost
      : userLimits.company_cost_mode === 'unlimited'
        ? null
        : decimalToMicros(userLimits.company_cost_limit!)
    return usageSummary(month, row, tokenLimit, companyCostMicrosLimit, alerts.rows)
  }

  private async projectSummaryWith(queryable: Queryable, projectId: number, month: string): Promise<UsageSummary> {
    const project = await queryable.query<{ id: string }>(`SELECT id FROM harness.projects
      WHERE organization_id=$1 AND public_id=$2 AND status='active'`, [this.context.organizationId, projectId])
    const identity = project.rows[0]
    if (identity === undefined) throw new Error(`unknown project ${String(projectId)}`)
    const row = await this.usageTotals(queryable, { kind: 'project', id: projectId }, identity.id, month)
    const quota = await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
      token_limit::text,company_cost_limit::text FROM harness.project_quotas WHERE project_id=$1`, [identity.id])
    const projectLimits = quota.rows[0]
    const inherited = projectLimits === undefined
      ? await queryable.query<{ token_limit: string | null; company_cost_limit: string | null }>(`SELECT
        token_limit::text,company_cost_limit::text FROM harness.role_quotas
        WHERE organization_id=$1 AND role='member'`, [this.context.organizationId])
      : undefined
    const alerts = await queryable.query<UsageAlertRow>(`SELECT metric,threshold,created_at
      FROM harness.project_usage_alerts
      WHERE project_id=$1 AND period_start=$2::date
      ORDER BY CASE metric WHEN 'tokens' THEN 0 ELSE 1 END,threshold`, [identity.id, `${month}-01`])
    const limits = projectLimits ?? inherited?.rows[0]
    return usageSummary(
      month,
      row,
      limits?.token_limit === null || limits?.token_limit === undefined
        ? null
        : safeCount(limits.token_limit, 'project token limit'),
      limits?.company_cost_limit === null || limits?.company_cost_limit === undefined
        ? null
        : decimalToMicros(limits.company_cost_limit),
      alerts.rows,
    )
  }

  private async evaluateAlerts(queryable: Queryable, subject: ModelUsageSubject, month: string): Promise<number> {
    const summary = await this.summaryWith(queryable, subject, month)
    const internalId = subject.kind === 'user'
      ? await internalUserId(queryable, this.context.organizationId, subject.id)
      : await internalProjectId(queryable, this.context.organizationId, subject.id)
    if (internalId === null) throw new Error(`unknown ${subject.kind} ${String(subject.id)}`)
    const table = subject.kind === 'user' ? 'model_usage_alerts' : 'project_usage_alerts'
    const column = subject.kind === 'user' ? 'user_id' : 'project_id'
    let inserted = 0
    for (const [metric, value, limit] of [
      ['tokens', summary.totalTokens, summary.tokenLimit],
      ['company-cost', summary.companyCostMicros, summary.companyCostMicrosLimit],
    ] as const) {
      if (limit === null || limit <= 0) continue
      for (const threshold of [80, 100] as const) {
        if (value * 100 < limit * threshold) continue
        const result = await queryable.query(`INSERT INTO harness.${table}(
          ${column},period_start,metric,threshold
        ) VALUES($1,$2::date,$3,$4) ON CONFLICT DO NOTHING`,
        [internalId, `${month}-01`, metric, threshold])
        inserted += result.rowCount ?? 0
      }
    }
    return inserted
  }
}
