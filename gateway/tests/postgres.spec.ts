import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { loadConfig } from '../src/config.ts'
import { writeProjectModelGovernanceFile } from '../src/apply-model-governance.ts'
import { openDb, SCHEMA_VERSION } from '../src/db.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import {
  checkPostgresReadiness,
  resolvePostgresRuntimeContext,
} from '../src/postgres/runtime-context.ts'
import { importSqliteControlPlane } from '../src/postgres/sqlite-import.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'

const DATABASE_URL = process.env.HGW_TEST_DATABASE_URL
const describePg = DATABASE_URL === undefined ? describe.skip : describe
const MIGRATIONS = resolve(import.meta.dirname, '../deploy/postgres/migrations')

type RuntimeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  body: string,
) => Promise<boolean>

async function serveRuntime(handler: RuntimeHandler): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const pathname = new URL(req.url ?? '/', 'http://runtime').pathname
      if (!await handler(req, res, pathname, Buffer.concat(chunks).toString('utf8'))) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not-found"}')
      }
    })().catch((error: unknown) => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error))
      }
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise(resolveClose => server.close(() => { resolveClose() })),
  }
}

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
    db.prepare(`INSERT INTO project_invitations(
      id,project_id,invitee_user_id,inviter_user_id,mode,status,expires_at,created_at,responded_at
    ) VALUES(1,1,2,1,'ro','pending',NULL,?,NULL)`).run(now)
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
    expect(migrated).toEqual({ applied: [1, 2, 3, 4, 5], current: 5 })
    expect(await runMigrations(pool, MIGRATIONS))
      .toEqual({ applied: [], current: 5 })
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
    // SQLite's control-plane version is one behind the PostgreSQL ledger;
    // choose a version beyond both ledgers so this remains genuinely unknown.
    const unknownVersion = SCHEMA_VERSION + 2
    await pool.query(`INSERT INTO harness.schema_migrations(version,name,checksum) VALUES($1,$2,$3)`, [
      unknownVersion, `${String(unknownVersion).padStart(3, '0')}_unknown.sql`, '0'.repeat(64),
    ])
    try {
      await expect(runMigrations(pool, MIGRATIONS)).rejects.toThrow(
        new RegExp(`unknown PostgreSQL migration version ${String(unknownVersion)}`),
      )
    } finally {
      await pool.query('DELETE FROM harness.schema_migrations WHERE version=$1', [unknownVersion])
    }
  })

  it('stores arbitrary session ids, full JSON strings, and searchable nested tool results', async () => {
    const sessions = new ConversationRepository(pool)
    const sessionId = 'session-not-a-uuid'
    await sessions.create({ id: sessionId, organizationId, creatorUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now(), cwd: '/tmp/alice' })
    const batchId = randomUUID()
    const events = [
      { type: 'user/message', seq: 0, time: Date.now(), data: {
        role: 'user', content: [{ type: 'text', text: '企业级 Agent 对话' }],
      } },
      { type: 'tool/result', seq: 1, time: Date.now(), data: { message: { content: [{
        type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '工具执行完成' }],
      }] } } },
      { type: 'session/state', seq: 2, time: Date.now(), data: {
        changes: [{ action: 'set', scope: '.\0virtual-module', path: ['ready'], value: true }],
      } },
    ]
    expect(await sessions.append(sessionId, batchId, events)).toBe('inserted')
    expect(await sessions.append(sessionId, batchId, events)).toBe('duplicate')
    expect(await sessions.readFrom(sessionId, 0)).toEqual(events)
    expect((await sessions.search(organizationId, 'Agent 对话'))[0]).toMatchObject({ sessionId, seq: 0 })
    expect((await sessions.search(organizationId, '工具执行'))[0]).toMatchObject({ sessionId, seq: 1 })
    await expect(sessions.append(sessionId, randomUUID(), [{ ...events[0]!, seq: 4 }]))
      .rejects.toThrow(/expected seq 3/)
  })

  it('serializes concurrent retries of one append batch', async () => {
    const sessions = new ConversationRepository(pool)
    const sessionId = 'concurrent-session'
    await sessions.create({ id: sessionId, organizationId, creatorUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now() })
    const batchId = randomUUID()
    const events = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }]
    expect((await Promise.all([
      sessions.append(sessionId, batchId, events), sessions.append(sessionId, batchId, events),
    ])).sort()).toEqual(['duplicate', 'inserted'])

    const otherSession = 'other-concurrent-session'
    await sessions.create({ id: otherSession, organizationId, creatorUserId: userId,
      sessionFormatVersion: 0, createdAt: Date.now() })
    await expect(sessions.append(otherSession, batchId, events))
      .rejects.toThrow(/batch id reused with different content/)
  })

  it('allocates mounted project runtimes at or above the configured base', async () => {
    const suffix = randomUUID().slice(0, 8)
    const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(
      slug,display_name
    ) VALUES($1,'Project Port Test') RETURNING id`, [`project-port-${suffix}`])
    const isolatedOrganizationId = organization.rows[0]!.id
    const node = await pool.query<{ id: string }>(`INSERT INTO harness.compute_nodes(
      organization_id,name
    ) VALUES($1,$2) RETURNING id`, [isolatedOrganizationId, `project-port-node-${suffix}`])
    const isolatedNodeId = node.rows[0]!.id
    const creator = await pool.query<{ id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,$2,'Project Creator',$3) RETURNING id`,
    [isolatedOrganizationId, `project-port-user-${suffix}`, `/tmp/project-port-user-${suffix}`])
    const project = await pool.query<{ id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by
    ) VALUES($1,'Mounted Project',$2) RETURNING id`, [isolatedOrganizationId, creator.rows[0]!.id])
    await pool.query(`INSERT INTO harness.instances(
      organization_id,user_id,assigned_node_id,port
    ) VALUES($1,$2,$3,46000)`, [isolatedOrganizationId, creator.rows[0]!.id, isolatedNodeId])
    await pool.query(`INSERT INTO harness.project_mounts(
      organization_id,project_id,node_id,local_path,canonical_path
    ) VALUES($1,$2,$3,$4,$4)`,
    [isolatedOrganizationId, project.rows[0]!.id, isolatedNodeId, `/tmp/project-port-${suffix}`])

    const instances = new PostgresInstanceRepository({
      pool,
      organizationId: isolatedOrganizationId,
      organizationSlug: `project-port-${suffix}`,
      nodeId: isolatedNodeId,
      nodeName: `project-port-node-${suffix}`,
    }, 47000)
    await instances.initialize(true)
    await instances.initialize(true)

    const assigned = await pool.query<{ port: number; count: string }>(`SELECT min(port) port,count(*)::text count
      FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2 AND project_id=$3`,
    [isolatedOrganizationId, isolatedNodeId, project.rows[0]!.id])
    expect(assigned.rows[0]).toEqual({ port: 47000, count: '1' })
  })

  it('keeps PostgreSQL user and project allocations at or above the configured base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-postgres-port-base-'))
    const suffix = randomUUID().slice(0, 8)
    try {
      const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(
        slug,display_name
      ) VALUES($1,'Port Base Test') RETURNING id`, [`port-base-${suffix}`])
      const isolatedOrganizationId = organization.rows[0]!.id
      const node = await pool.query<{ id: string }>(`INSERT INTO harness.compute_nodes(
        organization_id,name
      ) VALUES($1,$2) RETURNING id`, [isolatedOrganizationId, `port-base-node-${suffix}`])
      const isolatedNodeId = node.rows[0]!.id
      const creator = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
        organization_id,username,display_name,home_path
      ) VALUES($1,$2,'Legacy Creator',$3) RETURNING id,public_id::text`,
      [isolatedOrganizationId, `port-base-creator-${suffix}`, join(root, 'legacy')])
      await pool.query(`INSERT INTO harness.instances(
        organization_id,user_id,assigned_node_id,port
      ) VALUES($1,$2,$3,46000)`, [isolatedOrganizationId, creator.rows[0]!.id, isolatedNodeId])
      const context = {
        pool,
        organizationId: isolatedOrganizationId,
        organizationSlug: `port-base-${suffix}`,
        nodeId: isolatedNodeId,
        nodeName: `port-base-node-${suffix}`,
      }
      const cfg = loadConfig({
        HGW_USERS_ROOT: join(root, 'users'),
        HGW_INSTANCE_PORT_BASE: '47000',
        HGW_ORGANIZATION_SLUG: context.organizationSlug,
        HGW_COMPUTE_NODE_NAME: context.nodeName,
      })
      const shared = join(root, 'shared')
      await mkdir(shared)
      const projects = new PostgresProjectService(context, cfg)
      const project = await projects.create({
        name: 'Port Base Project', path: shared, createdBy: Number(creator.rows[0]!.public_id),
      })
      const projectPort = await pool.query<{ port: number }>(`SELECT port FROM harness.instances i
        JOIN harness.projects p ON p.id=i.project_id WHERE p.organization_id=$1 AND p.public_id=$2`,
      [isolatedOrganizationId, project.id])
      expect(projectPort.rows[0]?.port).toBe(47000)

      await pool.query(`DELETE FROM harness.instances WHERE project_id=(
        SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2
      )`, [isolatedOrganizationId, project.id])
      const users = new PostgresUserService(context, cfg)
      const user = await users.create({ username: `port-base-user-${suffix}`, password: 'pw-12345678' })
      const userPort = await pool.query<{ port: number }>(`SELECT port FROM harness.instances i
        JOIN harness.users u ON u.id=i.user_id WHERE u.organization_id=$1 AND u.public_id=$2`,
      [isolatedOrganizationId, user.id])
      expect(userPort.rows[0]?.port).toBe(47000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enforces project collaboration through PostgreSQL and the authenticated runtime API', async () => {
    const suffix = randomUUID().slice(0, 8)
    const creator = await pool.query<{ public_id: string }>(
      'SELECT public_id::text FROM harness.users WHERE id=$1', [userId],
    )
    const creatorPublicId = Number(creator.rows[0]!.public_id)
    const member = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,$2,'Bob','/tmp/bob') RETURNING id,public_id::text`,
    [organizationId, `bob-${suffix}`])
    const reader = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,$2,'Reader','/tmp/reader') RETURNING id,public_id::text`,
    [organizationId, `reader-${suffix}`])
    const administrator = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path
    ) VALUES($1,$2,'Administrator','/tmp/administrator') RETURNING id,public_id::text`,
    [organizationId, `administrator-${suffix}`])
    const memberId = member.rows[0]!.id
    const memberPublicId = Number(member.rows[0]!.public_id)
    const readerId = reader.rows[0]!.id
    const readerPublicId = Number(reader.rows[0]!.public_id)
    const administratorId = administrator.rows[0]!.id
    const administratorPublicId = Number(administrator.rows[0]!.public_id)
    await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role)
      VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'member'),($1,$5,'admin')
      ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,status='active'`,
    [organizationId, userId, memberId, readerId, administratorId])
    const node = await pool.query<{ id: string }>(`INSERT INTO harness.compute_nodes(
      organization_id,name
    ) VALUES($1,$2) RETURNING id`, [organizationId, `collaboration-${suffix}`])
    const nodeId = node.rows[0]!.id
    const project = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by
    ) VALUES($1,$2,$3) RETURNING id,public_id::text`,
    [organizationId, `Collaboration ${suffix}`, userId])
    const projectId = project.rows[0]!.id
    const projectPublicId = Number(project.rows[0]!.public_id)
    await pool.query(`INSERT INTO harness.project_mounts(
      organization_id,project_id,node_id,local_path,canonical_path
    ) VALUES($1,$2,$3,$4,$4)`, [organizationId, projectId, nodeId, `/tmp/project-${suffix}`])
    await pool.query(`INSERT INTO harness.project_members(
      organization_id,project_id,user_id,access_mode
    ) VALUES($1,$2,$3,'rw'),($1,$2,$4,'rw'),($1,$2,$5,'ro')`,
    [organizationId, projectId, userId, memberId, readerId])
    await pool.query(`INSERT INTO harness.instances(
      organization_id,project_id,assigned_node_id,port
    ) VALUES($1,$2,$3,46000)`, [organizationId, projectId, nodeId])

    const context = {
      pool,
      organizationId,
      organizationSlug: 'test',
      nodeId,
      nodeName: `collaboration-${suffix}`,
    }
    const sessions = new ConversationRepository(pool)
    const collaboration = new PostgresCollaborationService(context)
    const projectService = new PostgresProjectService(context, loadConfig({
      HGW_USERS_ROOT: `/tmp/collaboration-users-${suffix}`,
      HGW_ORGANIZATION_SLUG: 'test',
      HGW_COMPUTE_NODE_NAME: context.nodeName,
    }))
    const rootId = `collaboration-root-${suffix}`
    const childId = `collaboration-child-${suffix}`
    const privateId = `collaboration-private-${suffix}`
    const rejectedCreatorId = `collaboration-rejected-creator-${suffix}`
    const now = Date.now()
    await expect(sessions.create({
      id: rejectedCreatorId,
      organizationId,
      creatorUserId: readerId,
      projectId,
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: now - 1,
      cwd: `/tmp/project-${suffix}`,
    })).rejects.toThrow(/not an active rw project member/)
    await sessions.create({
      id: rootId,
      organizationId,
      creatorUserId: userId,
      projectId,
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: now,
      cwd: `/tmp/project-${suffix}`,
    })
    await sessions.create({
      id: childId,
      organizationId,
      parentSessionId: rootId,
      sessionFormatVersion: 0,
      createdAt: now + 1,
      cwd: `/tmp/project-${suffix}`,
    })
    await sessions.create({
      id: privateId,
      organizationId,
      creatorUserId: userId,
      projectId,
      visibility: 'private',
      sessionFormatVersion: 0,
      createdAt: now + 2,
      cwd: `/tmp/project-${suffix}`,
    })
    await expect(projectService.removeMember(projectPublicId, creatorPublicId))
      .rejects.toMatchObject({ code: 'visibility-locked' })

    const memberMessage = {
      type: 'user/message',
      seq: 0,
      time: now + 3,
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'shared contribution' }],
        source: {
          kind: 'user',
          participant: {
            userId: memberPublicId,
            username: `bob-${suffix}`,
            displayName: 'Bob',
            role: 'user',
            scope: {
              kind: 'project',
              projectId: projectPublicId,
              projectName: `Collaboration ${suffix}`,
              mode: 'rw',
            },
          },
        },
      },
      surfaceOp: 'append',
    }
    await sessions.append(rootId, randomUUID(), [memberMessage])
    await pool.query('UPDATE harness.conversation_sessions SET updated_at=to_timestamp(1) WHERE id=$1', [rootId])
    await sessions.append(childId, randomUUID(), [{
      type: 'turn/start', seq: 0, time: now + 4, data: { turn: 1 },
    }])

    await expect(collaboration.access(memberPublicId, rootId, 'write')).resolves.toMatchObject({
      rootSessionId: rootId,
      canWrite: true,
      canManage: false,
    })
    await expect(collaboration.access(memberPublicId, childId, 'read')).resolves.toMatchObject({
      sessionId: childId,
      rootSessionId: rootId,
      visibility: 'project',
    })
    await expect(collaboration.access(readerPublicId, rootId, 'read')).resolves.toMatchObject({
      mode: 'ro',
      canWrite: false,
    })
    await expect(collaboration.access(readerPublicId, rootId, 'write'))
      .rejects.toMatchObject({ code: 'forbidden' })
    await projectService.removeMember(projectPublicId, readerPublicId)
    await expect(collaboration.access(readerPublicId, rootId, 'read'))
      .rejects.toMatchObject({ code: 'not-member' })
    await projectService.setMember(projectPublicId, readerPublicId, 'ro')
    await expect(collaboration.access(memberPublicId, privateId, 'read'))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect((await collaboration.readableSessionIds(
      memberPublicId,
      projectPublicId,
      [rootId, childId, privateId],
    )).sort()).toEqual([rootId, childId].sort())
    const listed = await collaboration.listConversations(memberPublicId, projectPublicId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      sessionId: rootId,
      visibility: 'project',
      participants: [{ userId: memberPublicId, displayName: 'Bob', contributionCount: 1 }],
    })
    expect(listed[0]!.updatedAt).toBeGreaterThan(1000)

    expect(await collaboration.projectsForUser(administratorPublicId)).toContainEqual({
      projectId: projectPublicId,
      name: `Collaboration ${suffix}`,
      path: `/tmp/project-${suffix}`,
      mode: 'rw',
    })
    await expect(collaboration.projectForUser(projectPublicId, administratorPublicId)).resolves.toMatchObject({
      mode: 'rw',
      administrator: true,
    })
    await expect(collaboration.access(administratorPublicId, privateId, 'manage')).resolves.toMatchObject({
      visibility: 'private',
      mode: 'rw',
      canRead: true,
      canWrite: true,
      canManage: true,
    })
    expect((await collaboration.readableSessionIds(
      administratorPublicId,
      projectPublicId,
      [rootId, childId, privateId],
    )).sort()).toEqual([rootId, childId, privateId].sort())
    expect(await collaboration.listConversations(administratorPublicId, projectPublicId)).toHaveLength(2)
    await collaboration.setVisibility(administratorPublicId, privateId, 'project')
    await collaboration.setVisibility(administratorPublicId, privateId, 'private')
    await expect(collaboration.claimInteraction(
      administratorPublicId,
      privateId,
      'question',
      `administrator-question-${suffix}`,
      { answer: 'managed' },
    )).resolves.toBe(true)

    await pool.query(`UPDATE harness.memberships SET role='member'
      WHERE organization_id=$1 AND user_id=$2`, [organizationId, administratorId])
    await expect(collaboration.projectForUser(projectPublicId, administratorPublicId)).resolves.toBeNull()
    await expect(collaboration.access(administratorPublicId, privateId, 'read'))
      .rejects.toMatchObject({ code: 'not-member' })
    await pool.query(`UPDATE harness.memberships SET role='admin'
      WHERE organization_id=$1 AND user_id=$2`, [organizationId, administratorId])

    await expect(collaboration.setVisibility(creatorPublicId, rootId, 'private'))
      .rejects.toMatchObject({ code: 'visibility-locked' })
    await collaboration.setVisibility(creatorPublicId, privateId, 'project')
    await collaboration.setVisibility(creatorPublicId, privateId, 'private')

    const visibilityRaceId = `collaboration-visibility-race-${suffix}`
    await sessions.create({
      id: visibilityRaceId,
      organizationId,
      creatorUserId: userId,
      projectId,
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: now + 5,
      cwd: `/tmp/project-${suffix}`,
    })
    const visibilityRace = await Promise.allSettled([
      collaboration.setVisibility(creatorPublicId, visibilityRaceId, 'private'),
      sessions.append(visibilityRaceId, randomUUID(), [{ ...memberMessage, time: now + 6 }]),
    ])
    expect(visibilityRace.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(visibilityRace.filter(result => result.status === 'rejected')).toHaveLength(1)
    const raceState = await pool.query<{ visibility: string; participants: string; event_count: string }>(`SELECT
      r.visibility,count(cp.user_id)::text participants,r.event_count::text
      FROM harness.conversation_sessions r
      LEFT JOIN harness.conversation_participants cp ON cp.conversation_id=r.id
      WHERE r.organization_id=$1 AND r.id=$2 GROUP BY r.id`, [organizationId, visibilityRaceId])
    expect(raceState.rows[0]).toSatisfy((row: { visibility: string; participants: string; event_count: string }) =>
      (row.visibility === 'private' && row.participants === '0' && row.event_count === '0')
      || (row.visibility === 'project' && row.participants === '1' && row.event_count === '1'))

    const claims = await Promise.all([
      collaboration.claimInteraction(creatorPublicId, rootId, 'approval', `approval-${suffix}`, { allow: true }),
      collaboration.claimInteraction(memberPublicId, childId, 'approval', `approval-${suffix}`, { allow: false }),
    ])
    expect(claims.sort()).toEqual([false, true])
    const committedClaim = await pool.query<{ count: string }>(`SELECT count(*)::text count
      FROM harness.conversation_interaction_responses WHERE organization_id=$1 AND interaction_id=$2`,
    [organizationId, `approval-${suffix}`])
    expect(committedClaim.rows[0]!.count).toBe('1')

    const instances = new PostgresInstanceRepository(context, 46000)
    const runtimeToken = `runtime-${randomUUID()}`
    const generation = await instances.beginStart(
      { kind: 'project', id: projectPublicId },
      Date.now(),
      createHash('sha256').update(runtimeToken).digest(),
    )
    const { privateKey } = generateKeyPairSync('ed25519')
    const principals = new GatewayPrincipalSigner(privateKey, 'test', 60_000)
    const runtime = await serveRuntime(createRuntimeApiHandler({
      context,
      instances,
      conversations: sessions,
      collaboration,
      principals,
    }))
    const issue = (input: {
      id: number
      username: string
      displayName: string
      mode: 'ro' | 'rw'
    }): string => principals.issue({
      user: {
        id: input.id,
        username: input.username,
        displayName: input.displayName,
        role: 'user',
        status: 'active',
        mustChangePassword: false,
        homePath: `/tmp/${input.username}`,
      },
      scope: {
        kind: 'project',
        projectId: projectPublicId,
        projectName: `Collaboration ${suffix}`,
        mode: input.mode,
      },
      runtime: { kind: 'project', id: projectPublicId, generation },
      now: Date.now(),
    })
    const creatorAssertion = issue({
      id: creatorPublicId,
      username: 'alice',
      displayName: 'Alice',
      mode: 'rw',
    })
    const memberAssertion = issue({
      id: memberPublicId,
      username: `bob-${suffix}`,
      displayName: 'Bob',
      mode: 'rw',
    })
    const runtimeSessionId = `runtime-private-${suffix}`
    const runtimeBlankId = `runtime-blank-${suffix}`
    const appendBody = {
      sessionId: runtimeSessionId,
      batchId: randomUUID(),
      visibility: 'private',
      header: {
        id: runtimeSessionId,
        version: 0,
        createdAt: now + 5,
        cwd: `/tmp/project-${suffix}`,
      },
      events: [{
        ...memberMessage,
        seq: 0,
        time: now + 5,
        data: {
          ...memberMessage.data,
          source: {
            kind: 'user',
            participant: {
              userId: creatorPublicId,
              username: 'alice',
              displayName: 'Alice',
              role: 'user',
              scope: {
                kind: 'project',
                projectId: projectPublicId,
                projectName: `Collaboration ${suffix}`,
                mode: 'rw',
              },
            },
          },
        },
      }],
    }
    try {
      const denied = await fetch(`${runtime.base}/internal/runtime/session/append`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(appendBody),
      })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'forbidden' })

      const prepare = async (
        sessionId: string,
        visibility: 'project' | 'private',
      ): Promise<string> => {
        const response = await fetch(`${runtime.base}/internal/runtime/session/create`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${runtimeToken}`,
            [PRINCIPAL_HEADER]: creatorAssertion,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            visibility,
            header: {
              id: sessionId,
              version: 0,
              createdAt: now + 5,
              cwd: `/tmp/project-${suffix}`,
            },
          }),
        })
        expect(response.status).toBe(200)
        const value = await response.json() as { authorization: string }
        return value.authorization
      }
      const creationAuthorization = await prepare(runtimeSessionId, 'private')
      const blankAuthorization = await prepare(runtimeBlankId, 'project')
      expect(await sessions.load(runtimeBlankId)).toBeUndefined()

      const blankReadable = await fetch(`${runtime.base}/internal/runtime/collaboration/readable`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          [PRINCIPAL_HEADER]: memberAssertion,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionIds: [runtimeSessionId, runtimeBlankId],
          creationAuthorizations: [
            { sessionId: runtimeSessionId, authorization: creationAuthorization },
            { sessionId: runtimeBlankId, authorization: blankAuthorization },
          ],
        }),
      })
      expect(blankReadable.status).toBe(200)
      expect(await blankReadable.json()).toEqual({ sessionIds: [runtimeBlankId] })

      const blankProjectReadable = await fetch(`${runtime.base}/internal/runtime/collaboration/readable`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          [PRINCIPAL_HEADER]: memberAssertion,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionIds: [runtimeBlankId],
          creationAuthorizations: [{ sessionId: runtimeBlankId, authorization: blankAuthorization }],
        }),
      })
      expect(blankProjectReadable.status).toBe(200)
      expect(await blankProjectReadable.json()).toEqual({ sessionIds: [runtimeBlankId] })

      const forged = await fetch(`${runtime.base}/internal/runtime/session/append`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...appendBody,
          batchId: randomUUID(),
          header: undefined,
          visibility: undefined,
          creationAuthorization: `${creationAuthorization.slice(0, -1)}${creationAuthorization.endsWith('A') ? 'B' : 'A'}`,
        }),
      })
      expect(forged.status).toBe(400)

      const crossGeneration = principals.issueSessionCreation({
        creatorUserId: creatorPublicId,
        runtime: { kind: 'project', id: projectPublicId, generation: generation + 1 },
        header: appendBody.header,
        visibility: 'private',
      })
      const foreign = await fetch(`${runtime.base}/internal/runtime/session/append`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...appendBody,
          batchId: randomUUID(),
          header: undefined,
          visibility: undefined,
          creationAuthorization: crossGeneration,
        }),
      })
      expect(foreign.status).toBe(400)

      const created = await fetch(`${runtime.base}/internal/runtime/session/append`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...appendBody,
          batchId: randomUUID(),
          header: undefined,
          visibility: undefined,
          creationAuthorization,
        }),
      })
      expect(created.status).toBe(200)
      expect(await created.json()).toEqual({ result: 'inserted' })
      expect((await sessions.load(runtimeSessionId))?.header).toMatchObject({
        creatorUserId: userId,
        projectId,
        visibility: 'private',
      })
      await expect(collaboration.access(memberPublicId, runtimeSessionId, 'read'))
        .rejects.toMatchObject({ code: 'forbidden' })

      const readable = await fetch(`${runtime.base}/internal/runtime/collaboration/readable`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          [PRINCIPAL_HEADER]: memberAssertion,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionIds: [rootId, childId, runtimeSessionId],
          creationAuthorizations: [{ sessionId: runtimeSessionId, authorization: creationAuthorization }],
        }),
      })
      expect(readable.status).toBe(200)
      const readableBody = await readable.json() as { sessionIds: string[] }
      expect(readableBody.sessionIds.sort()).toEqual([rootId, childId].sort())
    } finally {
      await runtime.close()
    }
    expect((await projectService.remove(projectPublicId)).sort((left, right) => left - right)).toEqual(
      [creatorPublicId, memberPublicId, readerPublicId].sort((left, right) => left - right),
    )
    expect(await sessions.load(rootId)).toBeUndefined()
    expect(await instances.authenticateRuntimeToken(runtimeToken)).toBeNull()
  }, 60_000)

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
    await pool.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
      VALUES($1,$2,$3,'rw')`, [otherOrganizationId, otherProject.rows[0]!.id, otherUser.rows[0]!.id])
    const model = await pool.query<{ id: string }>(`INSERT INTO harness.model_catalog(
      organization_id,provider_key,model_key,display_name
    ) VALUES($1,'provider','primary','Primary') RETURNING id`, [organizationId])
    const otherModel = await pool.query<{ id: string }>(`INSERT INTO harness.model_catalog(
      organization_id,provider_key,model_key,display_name
    ) VALUES($1,'provider','other','Other') RETURNING id`, [otherOrganizationId])
    const sessions = new ConversationRepository(pool)
    await sessions.create({ id: 'other-organization-session', organizationId: otherOrganizationId,
      creatorUserId: otherUser.rows[0]!.id, projectId: otherProject.rows[0]!.id,
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
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,root_session_id,
      visibility,session_format_version,created_at,updated_at)
      VALUES('wrong-owner',$1,$2,'wrong-owner','personal',0,now(),now())`, [organizationId, otherUser.rows[0]!.id])
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,parent_session_id,
      root_session_id,visibility,session_format_version,created_at,updated_at)
      VALUES('wrong-parent',$1,$2,'other-organization-session','other-organization-session','personal',0,now(),now())`,
    [organizationId, userId])
    await foreignKey(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,project_id,
      root_session_id,visibility,session_format_version,created_at,updated_at)
      VALUES('wrong-project',$1,$2,$3,'wrong-project','project',0,now(),now())`,
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
        projectInvitations: 1,
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
      const creatorMembership = await pool.query<{ access_mode: string }>(`SELECT pm.access_mode
        FROM harness.project_members pm
        JOIN harness.users u ON u.id=pm.user_id AND u.organization_id=pm.organization_id
        WHERE pm.organization_id=$1 AND u.username='admin'`, [first.organizationId])
      expect(creatorMembership.rows).toEqual([{ access_mode: 'rw' }])
      const importedInvitation = await pool.query<{ status: string; access_mode: string; invitee: string }>(
        `SELECT i.status,i.access_mode,u.username invitee
         FROM harness.project_invitations i
         JOIN harness.users u ON u.id=i.invitee_user_id
         WHERE i.organization_id=$1`, [first.organizationId],
      )
      expect(importedInvitation.rows).toEqual([{ status: 'pending', access_mode: 'ro', invitee: 'member' }])

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

  it('runs the complete Gateway control plane against PostgreSQL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-postgres-runtime-'))
    const slug = `runtime-${randomUUID()}`
    try {
      await pool.query(`WITH organization AS (
        INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Runtime') RETURNING id
      ) INSERT INTO harness.compute_nodes(organization_id,name)
        SELECT id,'runtime-node' FROM organization`, [slug])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'runtime-node')
      await checkPostgresReadiness(context)
      const cfg = loadConfig({
        HGW_USERS_ROOT: join(root, 'users'),
        HGW_STATE_ROOT: join(root, 'state'),
        HGW_USER_PROJECTS_ROOT: join(root, 'managed-projects'),
        HGW_INSTANCE_PORT_BASE: '45100',
        HGW_ORGANIZATION_SLUG: slug,
        HGW_COMPUTE_NODE_NAME: 'runtime-node',
      })
      const users = new PostgresUserService(context, cfg)
      const auth = new PostgresAuthService(context, cfg)
      const projects = new PostgresProjectService(context, cfg)
      const instances = new PostgresInstanceRepository(context, cfg.instancePortBase)
      const audit = new PostgresAuditService(context)
      const governance = new PostgresModelGovernanceService(context, 'Asia/Shanghai')

      const admin = await users.create({ username: 'runtime-admin', password: 'pw-12345678', role: 'admin' })
      const member = await users.create({ username: 'runtime-user', password: 'pw-12345678' })
      expect(admin.id).not.toBe(member.id)
      expect((await users.list()).map(user => user.port)).toEqual([45100, 45101])
      await expect(users.setStatus(admin.id, 'disabled')).rejects.toThrow('cannot-remove-last-admin')

      const loggedIn = await auth.login('runtime-user', 'pw-12345678', '127.0.0.1', 'vitest')
      expect(loggedIn).not.toBe('invalid')
      expect(loggedIn).not.toBe('locked')
      if (loggedIn === 'invalid' || loggedIn === 'locked') throw new Error('runtime login failed')
      expect((await auth.validate(loggedIn.token))?.id).toBe(member.id)
      await auth.revoke(loggedIn.token)
      expect(await auth.validate(loggedIn.token)).toBeNull()
      await users.changeOwnPassword(member.id, 'pw-abcdefgh')
      expect((await users.getById(member.id))?.mustChangePassword).toBe(false)

      const shared = join(root, 'shared')
      await mkdir(shared)
      const project = await projects.create({ name: 'Runtime Project', path: shared, createdBy: admin.id })
      await projects.setMember(project.id, member.id, 'rw')
      expect((await projects.getById(project.id))?.members).toEqual([
        { userId: admin.id, username: 'runtime-admin', mode: 'rw' },
        { userId: member.id, username: 'runtime-user', mode: 'rw' },
      ])
      expect(await projects.effectiveGrants(member.id)).toEqual([
        { path: member.homePath, mode: 'rw', label: '主目录' },
        { path: project.path, mode: 'rw', label: 'Runtime Project' },
      ])

      await instances.initialize(false)
      const memberTarget = { kind: 'user' as const, id: member.id }
      expect(await instances.portOf(memberTarget)).toBe(45101)
      const runtimeToken = `member-runtime-${randomUUID()}`
      const generation = await instances.beginStart(
        memberTarget,
        Date.now(),
        createHash('sha256').update(runtimeToken).digest(),
      )
      await instances.markReady(memberTarget, generation)
      expect(await instances.stateOf(memberTarget)).toBe('ready')
      expect(await instances.authenticateRuntimeToken(runtimeToken)).toMatchObject({
        organizationId: context.organizationId,
        target: memberTarget,
        generation,
      })
      await users.setStatus(member.id, 'disabled')
      expect(await instances.authenticateRuntimeToken(runtimeToken)).toBeNull()
      await expect(instances.beginStart(memberTarget, Date.now(), Buffer.alloc(32, 2)))
        .rejects.toThrow(`no instance row for user ${String(member.id)}`)
      await instances.markStopping(memberTarget)
      await instances.markStopped(memberTarget)
      expect(await instances.stateOf(memberTarget)).toBe('stopped')
      await users.setStatus(member.id, 'active')
      const projectTarget = { kind: 'project' as const, id: project.id }
      expect(await instances.portOf(projectTarget)).toBe(45102)

      const ownedProject = await projects.createManaged({
        name: '  Runtime owned project  ', ownerUserId: member.id,
      })
      expect(ownedProject).toMatchObject({
        name: 'Runtime owned project', origin: 'user', owner: { id: member.id },
      })
      expect(ownedProject.path.startsWith(`${await realpath(cfg.userProjectsRoot)}/`)).toBe(true)
      const invitation = await projects.createInvitation({
        projectId: ownedProject.id, inviteeUserId: admin.id, inviterUserId: member.id, mode: 'ro',
      })
      expect(invitation).toMatchObject({ projectId: ownedProject.id, status: 'pending', mode: 'ro' })
      expect((await projects.listInvitations(admin.id)).some(item => item.id === invitation.id)).toBe(true)
      await projects.acceptInvitation(invitation.id, admin.id)
      expect((await projects.getById(ownedProject.id))?.members).toContainEqual({
        userId: admin.id, username: 'runtime-admin', mode: 'ro',
      })

      await governance.upsertModel({
        provider: 'runtime',
        model: 'chat',
        displayName: 'Runtime Chat',
        enabled: true,
        adminAllowed: true,
        userAllowed: true,
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 0,
        cacheReadMicrosPerMillion: 0,
        cacheWriteMicrosPerMillion: 0,
      })
      expect((await governance.listModels())[0]).toMatchObject({
        provider: 'runtime',
        model: 'chat',
        inputMicrosPerMillion: 1_000_000,
        userAllowed: true,
      })
      await governance.setUserAccess(member.id, 'runtime', 'chat', false)
      expect((await governance.policyFor(member)).models[0]?.allowed).toBe(false)
      await governance.setUserAccess(member.id, 'runtime', 'chat', null)
      await governance.setQuota('role', 'user', 10, 100)
      const intakeToken = await governance.issueIntakeToken({ kind: 'user', id: member.id })
      expect(await governance.subjectForIntakeToken(intakeToken)).toEqual({ kind: 'user', id: member.id })
      const usage = {
        eventId: randomUUID(),
        occurredAt: Date.now(),
        provider: 'runtime',
        model: 'chat',
        purpose: 'assistant',
        credentialSource: 'user-env',
        credentialClass: 'company' as const,
        status: 'succeeded' as const,
        usage: { inputTokens: 8, outputTokens: 0 },
      }
      expect(await governance.ingest({ kind: 'user', id: member.id }, usage)).toEqual({ inserted: true, alerts: 1 })
      expect(await governance.ingest({ kind: 'user', id: member.id }, usage)).toEqual({ inserted: false, alerts: 0 })
      expect(await governance.summary({ kind: 'user', id: member.id })).toMatchObject({
        totalTokens: 8,
        estimatedCostMicros: 8,
        companyCostMicros: 8,
        tokenLimit: 10,
        companyCostMicrosLimit: 100,
        alerts: [{ metric: 'tokens', threshold: 80 }],
      })

      expect(await governance.policyForProject(project.id)).toMatchObject({
        defaultAllowed: false,
        models: [{ provider: 'runtime', model: 'chat', allowed: true }],
      })
      const projectPolicyPath = await writeProjectModelGovernanceFile(cfg, governance, {
        kind: 'project',
        id: project.id,
        name: project.name,
        path: project.path,
      })
      const projectPolicy = JSON.parse(await readFile(projectPolicyPath, 'utf8')) as {
        defaultAllowed: boolean
        intakeToken: string
        models: Array<{ allowed: boolean }>
      }
      expect(projectPolicy).toMatchObject({ defaultAllowed: false, models: [{ allowed: true }] })
      expect(await governance.subjectForIntakeToken(projectPolicy.intakeToken))
        .toEqual({ kind: 'project', id: project.id })
      await governance.setQuota('project', String(project.id), 10, 100)
      const projectIntakeToken = await governance.issueIntakeToken({ kind: 'project', id: project.id })
      expect(await governance.subjectForIntakeToken(projectIntakeToken))
        .toEqual({ kind: 'project', id: project.id })
      const projectUsage = { ...usage, eventId: randomUUID(), sessionId: 'shared-runtime-session' }
      expect(await governance.ingest({ kind: 'project', id: project.id }, projectUsage))
        .toEqual({ inserted: true, alerts: 1 })
      expect(await governance.summary({ kind: 'project', id: project.id })).toMatchObject({
        totalTokens: 8,
        estimatedCostMicros: 8,
        companyCostMicros: 8,
        tokenLimit: 10,
        companyCostMicrosLimit: 100,
        alerts: [{ metric: 'tokens', threshold: 80 }],
      })
      await governance.setQuota('project', String(project.id), 'inherit', 'inherit')
      expect(await governance.summary({ kind: 'project', id: project.id })).toMatchObject({
        tokenLimit: 10,
        companyCostMicrosLimit: 100,
      })
      await governance.setQuota('project', String(project.id), null, null)
      expect(await governance.summary({ kind: 'project', id: project.id })).toMatchObject({
        tokenLimit: null,
        companyCostMicrosLimit: null,
      })
      const projectUsageOwner = await pool.query<{ user_id: string | null; project_id: string | null }>(`SELECT
        user_id,project_id FROM harness.model_usage WHERE organization_id=$1 AND event_id=$2`,
      [context.organizationId, projectUsage.eventId])
      expect(projectUsageOwner.rows[0]).toEqual({ user_id: null, project_id: expect.any(String) })
      const projectInternalId = projectUsageOwner.rows[0]!.project_id!
      const projectOwner = await pool.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
        [context.organizationId, admin.id],
      )
      const projectOwnerId = projectOwner.rows[0]?.id
      if (projectOwnerId === undefined) throw new Error('runtime project owner missing')
      await pool.query(`INSERT INTO harness.content_files(
        organization_id,owner_user_id,project_id,kind,local_path,sha256,byte_length,media_type
      ) VALUES($1,$2,$3,'artifact',$4,$5,1,'text/plain')`, [
        context.organizationId,
        projectOwnerId,
        projectInternalId,
        `/tmp/project-artifact-${randomUUID()}`,
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
      ])

      await audit.write({ userId: member.id, action: 'runtime.test', methodPath: 'POST /runtime', status: 201,
        ip: '127.0.0.1', detail: JSON.stringify({ ok: true }) })
      expect((await audit.query({ userId: member.id, action: 'runtime.test' }))[0]).toMatchObject({
        userId: member.id,
        action: 'runtime.test',
        methodPath: 'POST /runtime',
        status: 201,
      })
      expect((await projects.remove(project.id)).sort((left, right) => left - right)).toEqual(
        [admin.id, member.id].sort((left, right) => left - right),
      )
      expect((await projects.remove(ownedProject.id)).sort((left, right) => left - right)).toEqual(
        [admin.id, member.id].sort((left, right) => left - right),
      )
      const projectRemnants = await pool.query<{
        instances: string
        usage: string
        content: string
      }>(`SELECT
        (SELECT count(*) FROM harness.instances WHERE project_id=$1)::text instances,
        (SELECT count(*) FROM harness.model_usage WHERE project_id=$1)::text usage,
        (SELECT count(*) FROM harness.content_files WHERE project_id=$1)::text content`,
      [projectInternalId])
      expect(projectRemnants.rows[0]).toEqual({ instances: '0', usage: '0', content: '0' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

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
