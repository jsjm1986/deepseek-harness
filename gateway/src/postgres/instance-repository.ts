import type { InstanceRepository, RuntimeTarget } from '../instances.ts'
import { createHash } from 'node:crypto'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

function ownerJoin(target: RuntimeTarget): { join: string; predicate: string; noun: string } {
  return target.kind === 'user'
    ? {
        join: 'JOIN harness.users owner ON owner.id=i.user_id AND owner.organization_id=i.organization_id',
        predicate: 'owner.public_id=$3',
        noun: 'user',
      }
    : {
        join: 'JOIN harness.projects owner ON owner.id=i.project_id AND owner.organization_id=i.organization_id',
        predicate: 'owner.public_id=$3',
        noun: 'project',
      }
}

/** PostgreSQL instance rows scoped to one organization and compute node. */
export class PostgresInstanceRepository implements InstanceRepository {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly instancePortBase: number,
  ) {}

  async initialize(instancesOutliveGateway: boolean): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
      const missing = await client.query<{ project_id: string }>(`SELECT p.id project_id
        FROM harness.projects p
        JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
          AND pm.node_id=$2 AND pm.status='active'
        WHERE p.organization_id=$1 AND p.status='active' AND NOT EXISTS(
          SELECT 1 FROM harness.instances i
          WHERE i.organization_id=p.organization_id AND i.project_id=p.id
        ) ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId])
      const current = await client.query<{ port: number | null }>(
        'SELECT MAX(port) port FROM harness.instances WHERE assigned_node_id=$1',
        [this.context.nodeId],
      )
      let port = current.rows[0]?.port === null || current.rows[0]?.port === undefined
        ? this.instancePortBase
        : Math.max(this.instancePortBase, current.rows[0].port + 1)
      if (missing.rows.length > 0 && port + missing.rows.length - 1 > 65535) {
        throw new Error(`no instance ports remain on node ${this.context.nodeName}`)
      }
      for (const row of missing.rows) {
        await client.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port)
          VALUES($1,$2,$3,$4)`, [this.context.organizationId, row.project_id, this.context.nodeId, port])
        port += 1
      }
      if (!instancesOutliveGateway) {
        await client.query(`UPDATE harness.instances SET desired_state='stopped',observed_state='stopped',
          updated_at=now() WHERE organization_id=$1 AND assigned_node_id=$2`,
        [this.context.organizationId, this.context.nodeId])
      }
    })
  }

  async portOf(target: RuntimeTarget): Promise<number> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ port: number }>(`SELECT i.port FROM harness.instances i
      ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id])
    const port = result.rows[0]?.port
    if (port === undefined) throw new Error(`no instance row for ${owner.noun} ${String(target.id)}`)
    return port
  }

  async stateOf(target: RuntimeTarget): Promise<string> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ observed_state: string }>(`SELECT i.observed_state
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id])
    return result.rows[0]?.observed_state ?? 'stopped'
  }

  async generationOf(target: RuntimeTarget): Promise<number> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ generation: string }>(`SELECT i.generation::text
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id])
    const generation = result.rows[0]?.generation
    if (generation === undefined) throw new Error(`no instance row for ${owner.noun} ${String(target.id)}`)
    return Number(generation)
  }

  async touch(target: RuntimeTarget, at: number): Promise<void> {
    const owner = ownerJoin(target)
    await this.context.pool.query(`UPDATE harness.instances i SET
      last_activity_at=to_timestamp($4/1000.0),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, target.id, at])
  }

  async beginStart(target: RuntimeTarget, at: number, runtimeTokenHash: Buffer): Promise<number> {
    const activeOwner = target.kind === 'user'
      ? `owner.status='active' AND EXISTS(
          SELECT 1 FROM harness.memberships membership
          WHERE membership.organization_id=owner.organization_id AND membership.user_id=owner.id
            AND membership.status='active'
        )`
      : `owner.status='active'`
    const result = await this.context.pool.query<{ generation: string }>(`UPDATE harness.instances i
      SET desired_state='running',observed_state='starting',
      generation=generation+1,started_at=to_timestamp($4/1000.0),last_activity_at=to_timestamp($4/1000.0),
      runtime_token_hash=$5,runtime_token_issued_at=now(),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND ${activeOwner}
      RETURNING i.generation::text`,
    [this.context.organizationId, this.context.nodeId, target.id, at, runtimeTokenHash])
    const generation = result.rows[0]?.generation
    if (generation === undefined) throw new Error(`no instance row for ${target.kind} ${String(target.id)}`)
    return Number(generation)
  }

  async markReady(target: RuntimeTarget, generation: number): Promise<void> {
    const result = await this.context.pool.query(`UPDATE harness.instances i SET observed_state='ready',
      observed_generation=generation,last_heartbeat_at=now(),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND i.generation=$4`,
    [this.context.organizationId, this.context.nodeId, target.id, generation])
    if (result.rowCount !== 1) throw new Error(`stale instance generation for ${target.kind} ${String(target.id)}`)
  }

  async idleTargets(cutoff: number): Promise<RuntimeTarget[]> {
    const result = await this.context.pool.query<{ kind: 'user' | 'project'; public_id: string }>(`SELECT
      CASE WHEN i.user_id IS NOT NULL THEN 'user' ELSE 'project' END kind,
      COALESCE(u.public_id,p.public_id)::text public_id
      FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state='ready'
        AND i.last_activity_at < to_timestamp($3/1000.0)
      ORDER BY kind,public_id`, [this.context.organizationId, this.context.nodeId, cutoff])
    return result.rows.map(row => ({ kind: row.kind, id: publicNumber(row.public_id, row.kind) }))
  }

  async markStopping(target: RuntimeTarget): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopping',
      updated_at=now() FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, target.id])
  }

  async markStopped(target: RuntimeTarget): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopped',
      last_heartbeat_at=now(),runtime_token_hash=NULL,runtime_token_issued_at=NULL,updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, target.id])
  }

  async owner(target: RuntimeTarget): Promise<{
    kind: 'user' | 'project'
    id: number
    username: string
    homePath: string
    name?: string
  } | null> {
    if (target.kind === 'user') {
      const result = await this.context.pool.query<{
        public_id: string
        username: string
        home_path: string
      }>(`SELECT u.public_id::text,u.username::text,u.home_path
        FROM harness.users u JOIN harness.instances i
          ON i.user_id=u.id AND i.organization_id=u.organization_id
        WHERE u.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
      [this.context.organizationId, this.context.nodeId, target.id])
      const row = result.rows[0]
      return row === undefined ? null : {
        kind: 'user',
        id: publicNumber(row.public_id, 'user'),
        username: row.username,
        homePath: row.home_path,
      }
    }
    const result = await this.context.pool.query<{
      public_id: string
      name: string
      local_path: string
    }>(`SELECT p.public_id::text,p.name::text,m.local_path
      FROM harness.projects p
      JOIN harness.instances i ON i.project_id=p.id AND i.organization_id=p.organization_id
      JOIN harness.project_mounts m ON m.project_id=p.id AND m.organization_id=p.organization_id
        AND m.node_id=i.assigned_node_id AND m.status='active'
      WHERE p.organization_id=$1 AND i.assigned_node_id=$2 AND p.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, target.id])
    const row = result.rows[0]
    return row === undefined ? null : {
      kind: 'project',
      id: publicNumber(row.public_id, 'project'),
      username: `project-${row.public_id}`,
      name: row.name,
      homePath: row.local_path,
    }
  }

  /** Resolve a live runtime credential to its current generation and owner ids. */
  async authenticateRuntimeToken(token: string): Promise<{
    organizationId: string
    target: RuntimeTarget
    generation: number
    userInternalId?: string
    projectInternalId?: string
  } | null> {
    const hash = createHash('sha256').update(token).digest()
    const result = await this.context.pool.query<{
      organization_id: string
      generation: string
      user_internal_id: string | null
      user_public_id: string | null
      project_internal_id: string | null
      project_public_id: string | null
    }>(`SELECT i.organization_id,i.generation::text,
      u.id user_internal_id,u.public_id::text user_public_id,
      p.id project_internal_id,p.public_id::text project_public_id
      FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      LEFT JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
      LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.runtime_token_hash=$3
        AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
        AND ((u.id IS NOT NULL AND u.status='active' AND m.status='active')
          OR (p.id IS NOT NULL AND p.status='active'))`,
    [this.context.organizationId, this.context.nodeId, hash])
    const row = result.rows[0]
    if (row === undefined) return null
    if (row.user_internal_id !== null && row.user_public_id !== null) {
      return {
        organizationId: row.organization_id,
        target: { kind: 'user', id: publicNumber(row.user_public_id, 'user') },
        generation: Number(row.generation),
        userInternalId: row.user_internal_id,
      }
    }
    if (row.project_internal_id !== null && row.project_public_id !== null) {
      return {
        organizationId: row.organization_id,
        target: { kind: 'project', id: publicNumber(row.project_public_id, 'project') },
        generation: Number(row.generation),
        projectInternalId: row.project_internal_id,
      }
    }
    throw new Error('runtime credential resolved an ownerless instance')
  }
}
