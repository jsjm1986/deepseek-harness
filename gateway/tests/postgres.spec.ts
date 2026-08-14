import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { openDb, SCHEMA_VERSION } from '../src/db.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { importSqliteControlPlane } from '../src/postgres/sqlite-import.ts'

const DATABASE_URL = process.env.HGW_TEST_DATABASE_URL
const describePg = DATABASE_URL === undefined ? describe.skip : describe
const MIGRATIONS = resolve(import.meta.dirname, '../deploy/postgres/migrations')

async function sqliteFixture(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'hgw-postgres-import-'))
  const file = join(directory, 'gateway.sqlite')
  const db = openDb(file)
  const now = 1_786_698_000_000
  try {
    db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,status,home_path,must_change_password,created_at,updated_at)
      VALUES(1,'admin','hash-admin','Admin','admin','active','/srv/admin',0,?,?)`).run(now, now)
    db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,status,home_path,must_change_password,created_at,updated_at)
      VALUES(2,'member','hash-member','Member','user','active','/srv/member',1,?,?)`).run(now, now)
    db.prepare(`INSERT INTO projects(id,name,path,created_by,created_at,updated_at)
      VALUES(1,'Project','/srv/project',1,?,?)`).run(now, now)
    db.prepare(`INSERT INTO project_members(project_id,user_id,mode) VALUES(1,2,'rw')`).run()
    db.prepare(`INSERT INTO instances(user_id,port,state,pid,started_at,last_activity_at)
      VALUES(1,19001,'ready',1234,?,?)`).run(now, now)
    db.prepare(`INSERT INTO model_catalog(provider,model,display_name,enabled,created_at,updated_at)
      VALUES('deepseek','chat','DeepSeek Chat',1,?,?)`).run(now, now)
    db.prepare(`INSERT INTO model_role_access(role,provider,model,allowed) VALUES('user','deepseek','chat',1)`).run()
    db.prepare(`INSERT INTO model_user_access(user_id,provider,model,allowed) VALUES(2,'deepseek','chat',0)`).run()
    db.prepare(`INSERT INTO model_prices(id,provider,model,effective_at,input_micros_per_million,
      output_micros_per_million,cache_read_micros_per_million,cache_write_micros_per_million)
      VALUES(1,'deepseek','chat',?,1250000,2500000,125000,500000)`).run(now)
    db.prepare(`INSERT INTO model_quotas(subject_type,subject_id,token_limit,company_cost_micros_limit)
      VALUES('role','user',100000,2000000)`).run()
    db.prepare(`INSERT INTO model_quotas(subject_type,subject_id,token_limit,company_cost_micros_limit)
      VALUES('user','2',50000,-1)`).run()
    db.prepare(`INSERT INTO model_usage(event_id,user_id,occurred_at,received_at,provider,model,purpose,session_id,
      credential_source,credential_class,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
      estimated_cost_micros,company_cost_micros)
      VALUES('usage-1',2,?,?,'deepseek','chat','chat','session-1','user-env','company','succeeded',10,20,3,4,123456,100000)`).run(now, now)
    db.prepare(`INSERT INTO model_usage_alerts(user_id,month,metric,threshold,created_at)
      VALUES(2,'2026-08','tokens',80,?)`).run(now)
    db.prepare(`INSERT INTO audit_log(id,ts,user_id,action,method_path,status,ip,detail)
      VALUES(1,?,1,'login','POST /login',200,'127.0.0.1','ok')`).run(now)
    db.prepare(`INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at)
      VALUES(1,1,'session-token',?,?,?,?)`).run(now, now + 1_000, now + 2_000, now)
    db.prepare(`INSERT INTO login_attempts(id,username,ip,ts) VALUES(1,'admin','127.0.0.1',?)`).run(now)
    db.prepare(`INSERT INTO model_intake_tokens(user_id,token_hash,created_at) VALUES(1,'intake-token',?)`).run(now)
  } finally {
    db.close()
  }
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

describePg('PostgreSQL baseline', () => {
  let pool: Pool
  let organizationId: string
  let userId: string

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!, { max: 4 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    const migrated = await runMigrations(pool, MIGRATIONS)
    expect(migrated).toEqual({ applied: [1], current: 1 })
    expect(await runMigrations(pool, MIGRATIONS))
      .toEqual({ applied: [], current: 1 })
    const homeColumns = await pool.query<{ table_name: string; is_nullable: string }>(`SELECT table_name,is_nullable
      FROM information_schema.columns WHERE table_schema='harness' AND column_name='home_path' ORDER BY table_name`)
    expect(homeColumns.rows).toEqual([{ table_name: 'users', is_nullable: 'NO' }])
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO harness.organizations(slug,display_name) VALUES('test','Test') RETURNING id`,
    )
    organizationId = organization.rows[0]!.id
    const user = await pool.query<{ id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,'alice','Alice','/tmp/alice') RETURNING id`, [organizationId])
    userId = user.rows[0]!.id
  }, 60_000)

  afterAll(async () => { await pool?.end() })

  it('rejects changed or unknown applied migrations', async () => {
    const original = await pool.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM harness.schema_migrations WHERE version=1',
    )
    await pool.query(`UPDATE harness.schema_migrations SET checksum=$1 WHERE version=1`, ['0'.repeat(64)])
    try {
      await expect(runMigrations(pool, MIGRATIONS)).rejects.toThrow(/differs from the applied checksum/)
    } finally {
      await pool.query(`UPDATE harness.schema_migrations SET checksum=$1 WHERE version=1`, [original.rows[0]!.checksum])
    }
    await pool.query(`INSERT INTO harness.schema_migrations(version,name,checksum) VALUES(2,'002_unknown.sql',$1)`, ['0'.repeat(64)])
    try {
      await expect(runMigrations(pool, MIGRATIONS)).rejects.toThrow(/unknown PostgreSQL migration version 2/)
    } finally {
      await pool.query('DELETE FROM harness.schema_migrations WHERE version=2')
    }
  })

  it('stores arbitrary session ids, JSONB events, and searchable nested tool results', async () => {
    const sessions = new ConversationRepository(pool)
    const sessionId = 'session-not-a-uuid'
    await sessions.create({ id: sessionId, organizationId, ownerUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now(), cwd: '/tmp/alice' })
    const batchId = randomUUID()
    const events = [
      { type: 'user/message', seq: 0, time: Date.now(), data: {
        role: 'user', content: [{ type: 'text', text: '企业级 Agent 对话' }],
      } },
      { type: 'tool/result', seq: 1, time: Date.now(), data: { message: { content: [{
        type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '工具执行完成' }],
      }] } } },
    ]
    expect(await sessions.append(sessionId, batchId, events)).toBe('inserted')
    expect(await sessions.append(sessionId, batchId, events)).toBe('duplicate')
    expect(await sessions.readFrom(sessionId, 0)).toEqual(events)
    expect((await sessions.search(organizationId, 'Agent 对话'))[0]).toMatchObject({ sessionId, seq: 0 })
    expect((await sessions.search(organizationId, '工具执行'))[0]).toMatchObject({ sessionId, seq: 1 })
    await expect(sessions.append(sessionId, randomUUID(), [{ ...events[0]!, seq: 3 }]))
      .rejects.toThrow(/expected seq 2/)
  })

  it('serializes concurrent retries of one append batch', async () => {
    const sessions = new ConversationRepository(pool)
    const sessionId = 'concurrent-session'
    await sessions.create({ id: sessionId, organizationId, ownerUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now() })
    const batchId = randomUUID()
    const events = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }]
    expect((await Promise.all([
      sessions.append(sessionId, batchId, events), sessions.append(sessionId, batchId, events),
    ])).sort()).toEqual(['duplicate', 'inserted'])

    const otherSession = 'other-concurrent-session'
    await sessions.create({ id: otherSession, organizationId, ownerUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now() })
    await expect(sessions.append(otherSession, batchId, events))
      .rejects.toThrow(/batch id reused with different content/)
  })

  it('rejects cross-organization references in organization-scoped tables', async () => {
    const otherOrganization = await pool.query<{ id: string }>(
      `INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Other') RETURNING id`, [`other-${randomUUID()}`],
    )
    const otherOrganizationId = otherOrganization.rows[0]!.id
    const node = await pool.query<{ id: string }>(
      `INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'primary') RETURNING id`, [organizationId],
    )
    const otherNode = await pool.query<{ id: string }>(
      `INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other') RETURNING id`, [otherOrganizationId],
    )
    const otherUser = await pool.query<{ id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,'other','Other','/tmp/other') RETURNING id`, [otherOrganizationId])
    const project = await pool.query<{ id: string }>(
      `INSERT INTO harness.projects(organization_id,name,created_by) VALUES($1,'Primary',$2) RETURNING id`,
      [organizationId, userId],
    )
    const otherProject = await pool.query<{ id: string }>(
      `INSERT INTO harness.projects(organization_id,name,created_by) VALUES($1,'Other',$2) RETURNING id`,
      [otherOrganizationId, otherUser.rows[0]!.id],
    )
    const model = await pool.query<{ id: string }>(`INSERT INTO harness.model_catalog(
      organization_id,provider_key,model_key,display_name
    ) VALUES($1,'provider','primary','Primary') RETURNING id`, [organizationId])
    const otherModel = await pool.query<{ id: string }>(`INSERT INTO harness.model_catalog(
      organization_id,provider_key,model_key,display_name
    ) VALUES($1,'provider','other','Other') RETURNING id`, [otherOrganizationId])
    const sessions = new ConversationRepository(pool)
    await sessions.create({ id: 'other-organization-session', organizationId: otherOrganizationId,
      ownerUserId: otherUser.rows[0]!.id, projectId: otherProject.rows[0]!.id,
      sessionFormatVersion: 0, createdAt: Date.now() })

    const foreignKey = async (sql: string, values: unknown[]): Promise<void> => {
      await expect(pool.query(sql, values)).rejects.toMatchObject({ code: '23503' })
    }
    await foreignKey(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')`,
      [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.auth_sessions(organization_id,user_id,token_hash,created_at,expires_at,
      absolute_expires_at,last_seen_at) VALUES($1,$2,decode('00','hex'),now(),now(),now(),now())`,
    [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.projects(organization_id,name,created_by) VALUES($1,'Wrong owner',$2)`,
      [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,$3,'/tmp/wrong-node','/tmp/wrong-node')`, [organizationId, project.rows[0]!.id, otherNode.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
      VALUES($1,$2,$3,'rw')`, [organizationId, project.rows[0]!.id, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,19002)`, [organizationId, userId, otherNode.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.model_role_access(organization_id,role,model_id,allowed)
      VALUES($1,'member',$2,true)`, [organizationId, otherModel.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed)
      VALUES($1,$2,$3,true)`, [organizationId, userId, otherModel.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.model_usage(organization_id,event_id,user_id,occurred_at,model_id,
      provider_key,model_key,purpose,credential_source,credential_class,status)
      VALUES($1,'wrong-user',$2,now(),$3,'provider','primary','chat','user-env','company','succeeded')`,
    [organizationId, otherUser.rows[0]!.id, model.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.model_usage(organization_id,event_id,user_id,occurred_at,model_id,
      provider_key,model_key,purpose,credential_source,credential_class,status)
      VALUES($1,'wrong-model',$2,now(),$3,'provider','other','chat','user-env','company','succeeded')`,
    [organizationId, userId, otherModel.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action)
      VALUES($1,$2,'wrong-actor')`, [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,owner_user_id,session_format_version,
      created_at,updated_at) VALUES('wrong-owner',$1,$2,0,now(),now())`, [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,owner_user_id,parent_session_id,
      session_format_version,created_at,updated_at) VALUES('wrong-parent',$1,$2,'other-organization-session',0,now(),now())`,
    [organizationId, userId])
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,owner_user_id,project_id,
      session_format_version,created_at,updated_at) VALUES('wrong-project',$1,$2,$3,0,now(),now())`,
    [organizationId, userId, otherProject.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.content_files(organization_id,owner_user_id,kind,local_path,sha256,byte_length,media_type)
      VALUES($1,$2,'attachment','/tmp/file',$3,1,'text/plain')`,
    [organizationId, otherUser.rows[0]!.id, '0'.repeat(64)])
    await foreignKey(`INSERT INTO harness.content_files(organization_id,owner_user_id,session_id,kind,local_path,
      sha256,byte_length,media_type) VALUES($1,$2,'other-organization-session','attachment','/tmp/file',$3,1,'text/plain')`,
    [organizationId, userId, '0'.repeat(64)])
    await pool.query(`INSERT INTO harness.content_files(organization_id,owner_user_id,kind,local_path,sha256,byte_length,media_type)
      VALUES($1,$2,'attachment','/tmp/duplicate-a',$3,1,'text/plain'),
        ($1,$2,'attachment','/tmp/duplicate-b',$3,1,'text/plain')`, [organizationId, userId, '1'.repeat(64)])
    const duplicateFiles = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM harness.content_files WHERE organization_id=$1 AND sha256=$2`,
      [organizationId, '1'.repeat(64)],
    )
    expect(duplicateFiles.rows[0]!.count).toBe('2')
    expect(node.rows[0]!.id).not.toBe(otherNode.rows[0]!.id)
  })

  it('imports every SQLite control-plane domain and scopes event ids by organization', async () => {
    const fixture = await sqliteFixture()
    try {
      const first = await importSqliteControlPlane(pool, { sqliteFile: fixture.file,
        organizationSlug: `fixture-${randomUUID()}`, organizationName: 'Fixture', nodeName: 'fixture-node' })
      expect(first).toMatchObject({ users: 2, projects: 1, projectMembers: 1, instances: 1,
        models: 1, prices: 1, usageEvents: 1, usageAlerts: 1, auditEvents: 1,
        skippedSessions: 1, skippedLoginAttempts: 1, skippedIntakeTokens: 1 })
      const imported = await pool.query<{
        password_hash: string; role: string; access_mode: string; desired_state: string; model_allowed: boolean
        input_price: string; token_mode: string; cost_mode: string; estimated_cost: string; alert_count: string
      }>(`SELECT pc.password_hash,m.role,pm.access_mode,i.desired_state,mua.allowed model_allowed,
        mp.input_per_million::text input_price,uq.token_mode,uq.company_cost_mode cost_mode,
        mu.estimated_cost::text estimated_cost,
        (SELECT count(*) FROM harness.model_usage_alerts a WHERE a.user_id=u.id)::text alert_count
        FROM harness.users u
        JOIN harness.password_credentials pc ON pc.user_id=u.id
        JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
        JOIN harness.project_members pm ON pm.user_id=u.id AND pm.organization_id=u.organization_id
        JOIN harness.user_quotas uq ON uq.user_id=u.id
        JOIN harness.model_user_access mua ON mua.user_id=u.id AND mua.organization_id=u.organization_id
        JOIN harness.model_prices mp ON mp.model_id=mua.model_id
        JOIN harness.model_usage mu ON mu.user_id=u.id AND mu.organization_id=u.organization_id
        JOIN harness.instances i ON i.organization_id=u.organization_id
        WHERE u.organization_id=$1 AND u.username='member'`, [first.organizationId])
      expect(imported.rows[0]).toMatchObject({ password_hash: 'hash-member', role: 'member', access_mode: 'rw',
        desired_state: 'stopped', model_allowed: false, input_price: '1.250000000', token_mode: 'custom',
        cost_mode: 'inherit', estimated_cost: '0.123456000', alert_count: '1' })

      const second = await importSqliteControlPlane(pool, { sqliteFile: fixture.file,
        organizationSlug: `fixture-${randomUUID()}`, organizationName: 'Fixture 2', nodeName: 'fixture-node' })
      const usageCopies = await pool.query<{ count: string }>(
        `SELECT count(*)::text count FROM harness.model_usage WHERE event_id='usage-1'
          AND organization_id IN ($1,$2)`, [first.organizationId, second.organizationId],
      )
      expect(usageCopies.rows[0]!.count).toBe('2')
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects a versioned SQLite source with a missing required table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hgw-postgres-invalid-'))
    const file = join(directory, 'gateway.sqlite')
    const db = new Database(file)
    db.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(${String(SCHEMA_VERSION)});`)
    db.close()
    try {
      await expect(importSqliteControlPlane(pool, { sqliteFile: file,
        organizationSlug: `invalid-${randomUUID()}` })).rejects.toThrow(/missing required table users/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('imports a current Gateway SQLite snapshot idempotently when supplied', async () => {
    const sqlite = process.env.HGW_TEST_SQLITE_FILE
    if (sqlite === undefined) return
    await access(sqlite)
    const slug = `import-${randomUUID()}`
    const first = await importSqliteControlPlane(pool, { sqliteFile: sqlite,
      organizationSlug: slug, organizationName: 'Imported', nodeName: 'mac-mini' })
    const second = await importSqliteControlPlane(pool, { sqliteFile: sqlite,
      organizationSlug: slug, organizationName: 'Imported', nodeName: 'mac-mini' })
    expect(second).toMatchObject(first)
    const counts = await pool.query<{ users: string; audits: string; instances: string }>(`SELECT
      (SELECT count(*) FROM harness.users WHERE organization_id=$1)::text users,
      (SELECT count(*) FROM harness.audit_events WHERE organization_id=$1)::text audits,
      (SELECT count(*) FROM harness.instances WHERE organization_id=$1)::text instances`, [first.organizationId])
    expect(Number(counts.rows[0]!.users)).toBe(first.users)
    expect(Number(counts.rows[0]!.audits)).toBe(first.auditEvents)
    expect(Number(counts.rows[0]!.instances)).toBe(first.instances)

    // Legacy ids are scoped to the imported organization, so the same source
    // can be rehearsed beside a future cutover import without collisions.
    const parallel = await importSqliteControlPlane(pool, { sqliteFile: sqlite,
      organizationSlug: `${slug}-parallel`, organizationName: 'Parallel import', nodeName: 'mac-mini' })
    expect(parallel.auditEvents).toBe(first.auditEvents)
    expect(parallel.organizationId).not.toBe(first.organizationId)
  }, 60_000)
})
