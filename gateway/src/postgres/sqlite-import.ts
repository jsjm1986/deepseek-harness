import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import Database from 'better-sqlite3'
import type { Pool, PoolClient } from 'pg'
import { SCHEMA_VERSION } from '../db.ts'
import { transaction } from './database.ts'

export interface SqliteImportOptions {
  sqliteFile: string
  organizationSlug?: string
  organizationName?: string
  nodeName?: string
}

export interface SqliteImportReport {
  organizationId: string
  nodeId: string
  users: number
  projects: number
  projectMembers: number
  projectInvitations: number
  instances: number
  models: number
  prices: number
  usageEvents: number
  usageAlerts: number
  auditEvents: number
  skippedSessions: number
  skippedLoginAttempts: number
  skippedIntakeTokens: number
}

type SqliteRow = Record<string, unknown>
type SourceTable = 'users' | 'projects' | 'project_members' | 'auth_sessions' | 'login_attempts' | 'instances'
  | 'project_invitations'
  | 'audit_log' | 'model_catalog' | 'model_role_access' | 'model_user_access' | 'model_prices'
  | 'model_quotas' | 'model_intake_tokens' | 'model_usage' | 'model_usage_alerts'

function rows(db: Database.Database, table: SourceTable): SqliteRow[] {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)
  if (exists === undefined) throw new Error(`SQLite source schema ${String(SCHEMA_VERSION)} is missing required table ${table}`)
  return db.prepare(`SELECT * FROM ${table}`).all() as SqliteRow[]
}

function epoch(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null
}

function inet(value: unknown): string | null {
  return typeof value === 'string' && isIP(value.replace(/^::ffff:/, '')) !== 0 ? value : null
}

/** Derive a repeatable UUID for a legacy row that has no PostgreSQL UUID. */
function legacyUuid(organizationId: string, table: string, legacyId: unknown): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${table}\0${String(legacyId)}`)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Convert an integer number of millionths into an exact decimal SQL value. */
function micros(value: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(amount)) throw new Error(`legacy monetary value is not a safe integer: ${String(value)}`)
  const sign = amount < 0 ? '-' : ''
  const absolute = Math.abs(amount)
  return `${sign}${String(Math.floor(absolute / 1_000_000))}.${String(absolute % 1_000_000).padStart(6, '0')}`
}

async function idForLegacy(client: PoolClient, table: 'users' | 'projects', organizationId: string, legacyId: unknown): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM harness.${table} WHERE organization_id=$1 AND legacy_id=$2`, [organizationId, legacyId],
  )
  const id = result.rows[0]?.id
  if (id === undefined) throw new Error(`missing imported ${table} legacy id ${String(legacyId)}`)
  return id
}

async function modelId(client: PoolClient, organizationId: string, provider: unknown, model: unknown): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM harness.model_catalog WHERE organization_id=$1 AND provider_key=$2 AND model_key=$3',
    [organizationId, provider, model],
  )
  return result.rows[0]?.id ?? null
}

/**
 * Import the current Gateway SQLite control plane into one PostgreSQL organization.
 * Sessions and login attempts are intentionally not copied: users sign in again,
 * while existing JSONL session logs remain the durable conversation source until
 * the remote persistence phase is enabled.
 */
export async function importSqliteControlPlane(pool: Pool, options: SqliteImportOptions): Promise<SqliteImportReport> {
  const db = new Database(options.sqliteFile, { readonly: true, fileMustExist: true })
  try {
    const sourceVersion = (db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version?: number } | undefined)?.version
    if (sourceVersion !== SCHEMA_VERSION) {
      throw new Error(`SQLite source schema ${String(sourceVersion)} is unsupported; expected ${String(SCHEMA_VERSION)}`)
    }
    return await transaction(pool, async (client) => {
      const slug = options.organizationSlug ?? 'default'
      const organization = await client.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET display_name=excluded.display_name,updated_at=now() RETURNING id`,
      [slug, options.organizationName ?? 'Default Organization'])
      const organizationId = organization.rows[0]!.id
      const node = await client.query<{ id: string }>(`INSERT INTO harness.compute_nodes(organization_id,name)
        VALUES($1,$2) ON CONFLICT(organization_id,name) DO UPDATE SET status='active' RETURNING id`,
      [organizationId, options.nodeName ?? 'local'])
      const nodeId = node.rows[0]!.id

      const sourceUsers = rows(db, 'users')
      for (const row of sourceUsers) {
        const user = await client.query<{ id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path,status,legacy_id,public_id,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)
        ON CONFLICT(organization_id,legacy_id) DO UPDATE SET username=excluded.username,
          display_name=excluded.display_name,home_path=excluded.home_path,status=excluded.status,
          public_id=excluded.public_id,updated_at=excluded.updated_at RETURNING id`,
        [organizationId, row.username, row.display_name, row.home_path, row.status, row.id, epoch(row.created_at), epoch(row.updated_at)])
        const userId = user.rows[0]!.id
        await client.query(`INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password,changed_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,
          must_change_password=excluded.must_change_password,changed_at=excluded.changed_at`,
        [userId, row.password_hash, row.must_change_password === 1, epoch(row.updated_at)])
        await client.query(`INSERT INTO harness.memberships(organization_id,user_id,role,status)
          VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status`,
        [organizationId, userId, row.role === 'admin' ? 'admin' : 'member', row.status])
      }

      const sourceProjects = rows(db, 'projects')
      for (const row of sourceProjects) {
        const createdBy = row.created_by === null ? null : await idForLegacy(client, 'users', organizationId, row.created_by)
        const ownerUserId = row.owner_user_id === null || row.owner_user_id === undefined
          ? null : await idForLegacy(client, 'users', organizationId, row.owner_user_id)
        const origin = row.origin === 'user' ? 'user' : 'admin'
        const project = await client.query<{ id: string }>(`INSERT INTO harness.projects(
          organization_id,name,created_by,origin,owner_user_id,legacy_id,public_id,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) ON CONFLICT(organization_id,legacy_id) DO UPDATE SET
          name=excluded.name,created_by=excluded.created_by,origin=excluded.origin,owner_user_id=excluded.owner_user_id,public_id=excluded.public_id,
          updated_at=excluded.updated_at RETURNING id`,
        [organizationId, row.name, createdBy, origin, ownerUserId, row.id, epoch(row.created_at), epoch(row.updated_at)])
        await client.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
          VALUES($1,$2,$3,$4,$4) ON CONFLICT(project_id,node_id) DO UPDATE SET local_path=excluded.local_path,
          canonical_path=excluded.canonical_path,status='active'`, [organizationId, project.rows[0]!.id, nodeId, row.path])
      }

      const sourceMembers = rows(db, 'project_members')
      for (const row of sourceMembers) {
        await client.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
          VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET access_mode=excluded.access_mode,updated_at=now()`, [
          organizationId, await idForLegacy(client, 'projects', organizationId, row.project_id),
          await idForLegacy(client, 'users', organizationId, row.user_id), row.mode,
        ])
      }
      await client.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        SELECT organization_id,id,created_by,'rw' FROM harness.projects
        WHERE organization_id=$1 AND created_by IS NOT NULL
        ON CONFLICT(project_id,user_id) DO UPDATE SET access_mode='rw',updated_at=now()`, [organizationId])
      await client.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        SELECT organization_id,id,owner_user_id,'rw' FROM harness.projects
        WHERE organization_id=$1 AND owner_user_id IS NOT NULL
        ON CONFLICT(project_id,user_id) DO UPDATE SET access_mode='rw',updated_at=now()`, [organizationId])

      const sourceInvitations = rows(db, 'project_invitations')
      for (const row of sourceInvitations) {
        const invitationId = legacyUuid(organizationId, 'project-invitation', row.id)
        await client.query(`INSERT INTO harness.project_invitations(
          id,organization_id,project_id,invitee_user_id,inviter_user_id,access_mode,status,
          expires_at,created_at,responded_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,
          invitee_user_id=excluded.invitee_user_id,inviter_user_id=excluded.inviter_user_id,
          access_mode=excluded.access_mode,status=excluded.status,expires_at=excluded.expires_at,
          created_at=excluded.created_at,responded_at=excluded.responded_at`, [
          invitationId, organizationId,
          await idForLegacy(client, 'projects', organizationId, row.project_id),
          await idForLegacy(client, 'users', organizationId, row.invitee_user_id),
          await idForLegacy(client, 'users', organizationId, row.inviter_user_id),
          row.mode, row.status, epoch(row.expires_at), epoch(row.created_at), epoch(row.responded_at),
        ])
      }

      const sourceInstances = rows(db, 'instances')
      for (const row of sourceInstances) {
        const userId = await idForLegacy(client, 'users', organizationId, row.user_id)
        await client.query(`INSERT INTO harness.instances(
          organization_id,user_id,assigned_node_id,desired_state,observed_state,port,legacy_user_id,started_at,last_activity_at
        ) VALUES($1,$2,$3,'stopped','stopped',$4,$5,$6,$7)
        ON CONFLICT(organization_id,user_id) WHERE user_id IS NOT NULL DO UPDATE
          SET assigned_node_id=excluded.assigned_node_id,
          desired_state='stopped',observed_state='stopped',port=excluded.port,started_at=excluded.started_at,
          last_activity_at=excluded.last_activity_at,updated_at=now()`,
        [organizationId, userId, nodeId, row.port, row.user_id, epoch(row.started_at), epoch(row.last_activity_at)])
      }

      const sourceModels = rows(db, 'model_catalog')
      for (const row of sourceModels) {
        await client.query(`INSERT INTO harness.model_catalog(
          organization_id,provider_key,model_key,display_name,enabled,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,provider_key,model_key) DO UPDATE SET
          display_name=excluded.display_name,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        [organizationId, row.provider, row.model, row.display_name, row.enabled === 1, epoch(row.created_at), epoch(row.updated_at)])
      }
      for (const row of rows(db, 'model_role_access')) {
        const id = await modelId(client, organizationId, row.provider, row.model)
        if (id === null) throw new Error(`missing imported model ${String(row.provider)}/${String(row.model)}`)
        await client.query(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
          VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [organizationId, row.role === 'user' ? 'member' : row.role, id, row.allowed === 1])
      }
      for (const row of rows(db, 'model_user_access')) {
        const id = await modelId(client, organizationId, row.provider, row.model)
        if (id === null) throw new Error(`missing imported model ${String(row.provider)}/${String(row.model)}`)
        await client.query(`INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed) VALUES($1,$2,$3,$4)
          ON CONFLICT(user_id,model_id) DO UPDATE SET allowed=excluded.allowed`,
        [organizationId, await idForLegacy(client, 'users', organizationId, row.user_id), id, row.allowed === 1])
      }
      let priceCount = 0
      for (const row of rows(db, 'model_prices')) {
        const id = await modelId(client, organizationId, row.provider, row.model)
        if (id === null) throw new Error(`missing imported model ${String(row.provider)}/${String(row.model)}`)
        await client.query(`INSERT INTO harness.model_prices(model_id,effective_at,input_per_million,output_per_million,
          cache_read_per_million,cache_write_per_million) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(model_id,effective_at) DO NOTHING`, [id, epoch(row.effective_at),
          micros(row.input_micros_per_million), micros(row.output_micros_per_million),
          micros(row.cache_read_micros_per_million), micros(row.cache_write_micros_per_million)])
        priceCount++
      }

      for (const row of rows(db, 'model_quotas')) {
        if (row.subject_type === 'role') {
          await client.query(`INSERT INTO harness.role_quotas(organization_id,role,token_limit,company_cost_limit)
            VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role) DO UPDATE SET token_limit=excluded.token_limit,
            company_cost_limit=excluded.company_cost_limit`, [organizationId,
            row.subject_id === 'user' ? 'member' : row.subject_id, row.token_limit, row.company_cost_micros_limit === null ? null : micros(row.company_cost_micros_limit)])
        } else {
          const token = row.token_limit as number | null
          const cost = row.company_cost_micros_limit as number | null
          await client.query(`INSERT INTO harness.user_quotas(user_id,token_mode,token_limit,company_cost_mode,company_cost_limit)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET token_mode=excluded.token_mode,
            token_limit=excluded.token_limit,company_cost_mode=excluded.company_cost_mode,company_cost_limit=excluded.company_cost_limit`, [
            await idForLegacy(client, 'users', organizationId, Number(row.subject_id)),
            token === -1 ? 'inherit' : token === null ? 'unlimited' : 'custom', token === null || token === -1 ? null : token,
            cost === -1 ? 'inherit' : cost === null ? 'unlimited' : 'custom', cost === null || cost === -1 ? null : micros(cost),
          ])
        }
      }

      const sourceUsage = rows(db, 'model_usage')
      for (const row of sourceUsage) {
        await client.query(`INSERT INTO harness.model_usage(event_id,organization_id,user_id,occurred_at,received_at,
          model_id,provider_key,model_key,purpose,session_id,credential_source,credential_class,status,input_tokens,
          output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost,company_cost)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT(organization_id,event_id) DO NOTHING`, [
          row.event_id, organizationId, await idForLegacy(client, 'users', organizationId, row.user_id),
          epoch(row.occurred_at), epoch(row.received_at), await modelId(client, organizationId, row.provider, row.model),
          row.provider, row.model, row.purpose, row.session_id, row.credential_source, row.credential_class, row.status,
          row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens,
          micros(row.estimated_cost_micros), micros(row.company_cost_micros),
        ])
      }
      const sourceAlerts = rows(db, 'model_usage_alerts')
      for (const row of sourceAlerts) {
        await client.query(`INSERT INTO harness.model_usage_alerts(user_id,period_start,metric,threshold,created_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
          await idForLegacy(client, 'users', organizationId, row.user_id), `${String(row.month)}-01`, row.metric,
          row.threshold, epoch(row.created_at),
        ])
      }

      const sourceAudits = rows(db, 'audit_log')
      for (const row of sourceAudits) {
        const actor = row.user_id === null ? null : await idForLegacy(client, 'users', organizationId, row.user_id)
        await client.query(`INSERT INTO harness.audit_events(organization_id,occurred_at,actor_user_id,action,
          resource_type,source_ip,outcome,status_code,detail,legacy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
          ON CONFLICT(organization_id,legacy_id) DO NOTHING`, [organizationId, epoch(row.ts), actor, row.action,
          row.method_path === '' ? null : 'http', inet(row.ip), typeof row.status === 'number' && row.status >= 400 ? 'failure' : 'success',
          row.status, JSON.stringify({ methodPath: row.method_path, legacyDetail: row.detail }), row.id])
      }

      await client.query(`SELECT setval('harness.user_public_id_seq',
        COALESCE((SELECT MAX(public_id) FROM harness.users),1),EXISTS(SELECT 1 FROM harness.users))`)
      await client.query(`SELECT setval('harness.project_public_id_seq',
        COALESCE((SELECT MAX(public_id) FROM harness.projects),1),EXISTS(SELECT 1 FROM harness.projects))`)

      return {
        organizationId, nodeId, users: sourceUsers.length, projects: sourceProjects.length,
        projectMembers: sourceMembers.length, projectInvitations: sourceInvitations.length,
        instances: sourceInstances.length, models: sourceModels.length,
        prices: priceCount, usageEvents: sourceUsage.length, usageAlerts: sourceAlerts.length,
        auditEvents: sourceAudits.length, skippedSessions: rows(db, 'auth_sessions').length,
        skippedLoginAttempts: rows(db, 'login_attempts').length,
        skippedIntakeTokens: rows(db, 'model_intake_tokens').length,
      }
    })
  } finally {
    db.close()
  }
}
