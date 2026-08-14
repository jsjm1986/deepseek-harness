import type { InstanceRepository } from '../instances.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

/** PostgreSQL instance rows scoped to one organization and compute node. */
export class PostgresInstanceRepository implements InstanceRepository {
  constructor(private readonly context: PostgresRuntimeContext) {}

  async initialize(instancesOutliveGateway: boolean): Promise<void> {
    if (instancesOutliveGateway) return
    await this.context.pool.query(`UPDATE harness.instances SET desired_state='stopped',observed_state='stopped',
      updated_at=now() WHERE organization_id=$1 AND assigned_node_id=$2`,
    [this.context.organizationId, this.context.nodeId])
  }

  async portOf(userId: number): Promise<number> {
    const result = await this.context.pool.query<{ port: number }>(`SELECT i.port FROM harness.instances i
      JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
    const port = result.rows[0]?.port
    if (port === undefined) throw new Error(`no instance row for user ${String(userId)}`)
    return port
  }

  async stateOf(userId: number): Promise<string> {
    const result = await this.context.pool.query<{ observed_state: string }>(`SELECT i.observed_state
      FROM harness.instances i JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
    return result.rows[0]?.observed_state ?? 'stopped'
  }

  async touch(userId: number, at: number): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET last_activity_at=to_timestamp($4/1000.0),updated_at=now()
      FROM harness.users u WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId, at])
  }

  async markStarting(userId: number, at: number): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET desired_state='running',observed_state='starting',
      generation=generation+1,started_at=to_timestamp($4/1000.0),last_activity_at=to_timestamp($4/1000.0),
      updated_at=now() FROM harness.users u
      WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId, at])
  }

  async markReady(userId: number): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET observed_state='ready',
      observed_generation=generation,last_heartbeat_at=now(),updated_at=now() FROM harness.users u
      WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
  }

  async idleUserIds(cutoff: number): Promise<number[]> {
    const result = await this.context.pool.query<{ public_id: string }>(`SELECT u.public_id::text
      FROM harness.instances i JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state='ready'
        AND i.last_activity_at < to_timestamp($3/1000.0) ORDER BY u.public_id`,
    [this.context.organizationId, this.context.nodeId, cutoff])
    return result.rows.map(row => publicNumber(row.public_id, 'user'))
  }

  async markStopping(userId: number): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopping',
      updated_at=now() FROM harness.users u WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
  }

  async markStopped(userId: number): Promise<void> {
    await this.context.pool.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopped',
      last_heartbeat_at=now(),updated_at=now() FROM harness.users u
      WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND i.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
  }

  async owner(userId: number): Promise<{ id: number; username: string; homePath: string } | null> {
    const result = await this.context.pool.query<{
      public_id: string
      username: string
      home_path: string
    }>(`SELECT u.public_id::text,u.username::text,u.home_path
      FROM harness.users u JOIN harness.instances i ON i.user_id=u.id AND i.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3`,
    [this.context.organizationId, this.context.nodeId, userId])
    const row = result.rows[0]
    return row === undefined ? null : {
      id: publicNumber(row.public_id, 'user'),
      username: row.username,
      homePath: row.home_path,
    }
  }
}
