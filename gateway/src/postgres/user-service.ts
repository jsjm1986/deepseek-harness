import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { UserRow } from '../auth.ts'
import type { GatewayConfig } from '../config.ts'
import { hashPassword } from '../password.ts'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/

interface PostgresUserRow {
  internal_id: string
  public_id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  user_status: 'active' | 'disabled'
  deleted_at: Date | null
  membership_status: 'active' | 'disabled'
  home_path: string
  must_change_password: boolean
  port: number
  instance_state: string
}

function isPostgresError(error: unknown): error is Error & { code: string; constraint?: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function toUser(row: PostgresUserRow): UserRow {
  return {
    id: publicNumber(row.public_id, 'user'),
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.user_status === 'active' && row.membership_status === 'active' ? 'active' : 'disabled',
    homePath: row.home_path,
    mustChangePassword: row.must_change_password,
  }
}

/** PostgreSQL-backed user administration for one organization and compute node. */
export class PostgresUserService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  private selectUsers(where = ''): string {
    return `SELECT u.id internal_id,u.public_id::text,u.username::text,u.display_name,
      u.status user_status,u.deleted_at,u.home_path,m.role,m.status membership_status,c.must_change_password,
      i.port,i.observed_state instance_state
      FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.password_credentials c ON c.user_id=u.id
      JOIN harness.instances i ON i.organization_id=u.organization_id AND i.user_id=u.id AND i.assigned_node_id=$2
      WHERE u.organization_id=$1 AND u.deleted_at IS NULL ${where}`
  }

  async count(): Promise<number> {
    const result = await this.context.pool.query<{ n: string }>(
      'SELECT COUNT(*)::text n FROM harness.users WHERE organization_id=$1 AND deleted_at IS NULL',
      [this.context.organizationId],
    )
    return Number(result.rows[0]?.n ?? 0)
  }

  async create(input: {
    username: string
    password: string
    role?: 'admin' | 'user'
    displayName?: string
  }): Promise<UserRow> {
    if (!USERNAME_RE.test(input.username)) throw new Error(`invalid username: ${input.username}`)
    const homePath = join(this.cfg.usersRoot, input.username, 'home')
    mkdirSync(homePath, { recursive: true })
    mkdirSync(join(this.cfg.usersRoot, input.username, 'dsh'), { recursive: true })
    const passwordHash = await hashPassword(input.password)
    let publicId: number
    try {
      publicId = await transaction(this.context.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
        const user = await client.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path
        ) VALUES($1,$2,$3,$4) RETURNING id,public_id::text`, [this.context.organizationId, input.username,
          input.displayName ?? input.username, homePath])
        const row = user.rows[0]
        if (row === undefined) throw new Error('user insert returned no row')
        await client.query(`INSERT INTO harness.password_credentials(user_id,password_hash)
          VALUES($1,$2)`, [row.id, passwordHash])
        await client.query(`INSERT INTO harness.memberships(organization_id,user_id,role)
          VALUES($1,$2,$3)`, [this.context.organizationId, row.id, input.role === 'admin' ? 'admin' : 'member'])
        const ports = await client.query<{ port: number | null }>(`SELECT MAX(port) port FROM harness.instances
          WHERE assigned_node_id=$1`, [this.context.nodeId])
        const port = ports.rows[0]?.port === null || ports.rows[0]?.port === undefined
          ? this.cfg.instancePortBase
          : Math.max(this.cfg.instancePortBase, ports.rows[0].port + 1)
        if (port > 65535) throw new Error(`no instance ports remain on node ${this.context.nodeName}`)
        await client.query(`INSERT INTO harness.instances(
          organization_id,user_id,assigned_node_id,port
        ) VALUES($1,$2,$3,$4)`, [this.context.organizationId, row.id, this.context.nodeId, port])
        return publicNumber(row.public_id, 'user')
      })
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') {
        throw new Error(`duplicate username: ${input.username}`)
      }
      throw error
    }
    const created = await this.getById(publicId)
    if (created === null) throw new Error('user row missing after insert')
    return created
  }

  async list(): Promise<Array<UserRow & { port: number; instanceState: string }>> {
    const result = await this.context.pool.query<PostgresUserRow>(
      `${this.selectUsers()} ORDER BY u.public_id`, [this.context.organizationId, this.context.nodeId],
    )
    return result.rows.map(row => ({ ...toUser(row), port: row.port, instanceState: row.instance_state }))
  }

  async getById(id: number): Promise<UserRow | null> {
    const result = await this.context.pool.query<PostgresUserRow>(
      `${this.selectUsers('AND u.public_id=$3')} LIMIT 1`,
      [this.context.organizationId, this.context.nodeId, id],
    )
    return result.rows[0] === undefined ? null : toUser(result.rows[0])
  }

  async getByUsername(username: string): Promise<UserRow | null> {
    const result = await this.context.pool.query<PostgresUserRow>(
      `${this.selectUsers('AND u.username=$3')} LIMIT 1`,
      [this.context.organizationId, this.context.nodeId, username],
    )
    return result.rows[0] === undefined ? null : toUser(result.rows[0])
  }

  private async mutateAdmin(
    id: number,
    next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled' },
  ): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      const target = await client.query<{
        id: string
        role: 'admin' | 'member'
        user_status: 'active' | 'disabled'
        membership_status: 'active' | 'disabled'
      }>(`SELECT u.id,m.role,u.status user_status,m.status membership_status
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF u,m`,
      [this.context.organizationId, id])
      const row = target.rows[0]
      if (row === undefined) return
      const losesAdmin = row.role === 'admin' && row.user_status === 'active' && row.membership_status === 'active'
        && (next.role === 'user' || next.status === 'disabled')
      if (losesAdmin) {
        const others = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.users u JOIN harness.memberships m
            ON m.organization_id=u.organization_id AND m.user_id=u.id
          WHERE u.organization_id=$1 AND u.id<>$2 AND u.deleted_at IS NULL AND u.status='active'
            AND m.status='active' AND m.role='admin'`, [this.context.organizationId, row.id])
        if (Number(others.rows[0]?.n ?? 0) === 0) throw new Error('cannot-remove-last-admin')
      }
      if (next.role !== undefined) {
        await client.query(`UPDATE harness.memberships SET role=$3
          WHERE organization_id=$1 AND user_id=$2`,
        [this.context.organizationId, row.id, next.role === 'admin' ? 'admin' : 'member'])
      }
      if (next.status !== undefined) {
        await client.query('UPDATE harness.users SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2',
          [this.context.organizationId, row.id, next.status])
        await client.query('UPDATE harness.memberships SET status=$3 WHERE organization_id=$1 AND user_id=$2',
          [this.context.organizationId, row.id, next.status])
        if (next.status === 'disabled') {
          await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='user-disabled'
            WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, row.id])
        }
      }
    })
  }

  async setStatus(id: number, status: 'active' | 'disabled'): Promise<void> {
    await this.mutateAdmin(id, { status })
  }

  async setRole(id: number, role: 'admin' | 'user'): Promise<void> {
    await this.mutateAdmin(id, { role })
  }

  async setDisplayName(id: number, name: string): Promise<void> {
    await this.context.pool.query(`UPDATE harness.users SET display_name=$3,updated_at=now()
      WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL`, [this.context.organizationId, id, name])
  }

  /** Mark a user deleted while retaining history that still references the account. */
  async remove(id: number): Promise<boolean> {
    return transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      const target = await client.query<{
        id: string
        role: 'admin' | 'member'
        user_status: 'active' | 'disabled'
        membership_status: 'active' | 'disabled'
      }>(`SELECT u.id,m.role,u.status user_status,m.status membership_status
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL
        FOR UPDATE OF u,m`, [this.context.organizationId, id])
      const row = target.rows[0]
      if (row === undefined) return false
      const losesAdmin = row.role === 'admin' && row.user_status === 'active' && row.membership_status === 'active'
      if (losesAdmin) {
        const others = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.users u JOIN harness.memberships m
            ON m.organization_id=u.organization_id AND m.user_id=u.id
          WHERE u.organization_id=$1 AND u.id<>$2 AND u.deleted_at IS NULL
            AND u.status='active' AND m.status='active' AND m.role='admin'`,
        [this.context.organizationId, row.id])
        if (Number(others.rows[0]?.n ?? 0) === 0) throw new Error('cannot-remove-last-admin')
      }
      await client.query(`UPDATE harness.users SET status='disabled',deleted_at=now(),updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, row.id])
      await client.query(`UPDATE harness.memberships SET status='disabled'
        WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, row.id])
      await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='user-deleted'
        WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, row.id])
      await client.query(`UPDATE harness.instances SET desired_state='stopped',observed_state='stopped',
        runtime_token_hash=NULL,runtime_token_issued_at=NULL,updated_at=now()
        WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, row.id])
      await client.query(`DELETE FROM harness.login_attempts
        WHERE organization_id=$1 AND username=(SELECT username FROM harness.users WHERE id=$2)`,
      [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND user_id=$2',
        [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.project_invitations WHERE invitee_user_id=$1 OR inviter_user_id=$1',
        [row.id])
      await client.query('DELETE FROM harness.model_user_access WHERE organization_id=$1 AND user_id=$2',
        [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.model_intake_tokens WHERE user_id=$1', [row.id])
      await client.query('DELETE FROM harness.user_quotas WHERE user_id=$1', [row.id])
      return true
    })
  }

  async resetPassword(id: number, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword)
    await transaction(this.context.pool, async (client) => {
      const user = await client.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL',
        [this.context.organizationId, id],
      )
      const userId = user.rows[0]?.id
      if (userId === undefined) return
      await client.query(`UPDATE harness.password_credentials SET password_hash=$2,
        password_version=password_version+1,must_change_password=true,changed_at=now() WHERE user_id=$1`,
      [userId, passwordHash])
      await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='password-reset'
        WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, userId])
    })
  }

  async changeOwnPassword(id: number, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword)
    await this.context.pool.query(`UPDATE harness.password_credentials c SET password_hash=$3,
      password_version=password_version+1,must_change_password=false,changed_at=now()
      FROM harness.users u WHERE u.id=c.user_id AND u.organization_id=$1 AND u.public_id=$2`,
    [this.context.organizationId, id, passwordHash])
  }
}
