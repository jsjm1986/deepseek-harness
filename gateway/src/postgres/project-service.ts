import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { GatewayConfig } from '../config.ts'
import {
  isProjectPathIsolated,
  projectPathsOverlap,
  resolveProjectDirectory,
  type EffectiveGrant,
  type GrantMode,
  type ProjectDetail,
  type ProjectRow,
} from '../projects.ts'
import { transaction } from './database.ts'
import {
  internalProjectId,
  internalUserId,
  publicNumber,
  type PostgresRuntimeContext,
} from './runtime-context.ts'

function isCodedError(error: unknown): error is Error & { code: string; constraint?: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch (error) {
    if (isCodedError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/** PostgreSQL-backed project catalog and node-local mounts for one organization. */
export class PostgresProjectService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  async create(input: { name: string; path: string; createdBy: number }): Promise<ProjectRow> {
    const canonical = resolveProjectDirectory(input.path)
    await this.assertNotReserved(canonical)
    try {
      return await transaction(this.context.pool, async (client) => {
        const createdBy = await internalUserId(client, this.context.organizationId, input.createdBy)
        if (createdBy === null) throw new Error(`unknown user ${String(input.createdBy)}`)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
        const project = await client.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
          organization_id,name,created_by
        ) VALUES($1,$2,$3) RETURNING id,public_id::text`, [this.context.organizationId, input.name, createdBy])
        const row = project.rows[0]
        if (row === undefined) throw new Error('project insert returned no row')
        await client.query(`INSERT INTO harness.project_mounts(
          organization_id,project_id,node_id,local_path,canonical_path
        ) VALUES($1,$2,$3,$4,$4)`, [this.context.organizationId, row.id, this.context.nodeId, canonical])
        await client.query(`INSERT INTO harness.project_members(
          organization_id,project_id,user_id,access_mode
        ) VALUES($1,$2,$3,'rw')`, [this.context.organizationId, row.id, createdBy])
        const ports = await client.query<{ port: number | null }>(`SELECT MAX(port) port FROM harness.instances
          WHERE assigned_node_id=$1`, [this.context.nodeId])
        const port = ports.rows[0]?.port === null || ports.rows[0]?.port === undefined
          ? this.cfg.instancePortBase
          : Math.max(this.cfg.instancePortBase, ports.rows[0].port + 1)
        if (port > 65535) throw new Error(`no instance ports remain on node ${this.context.nodeName}`)
        await client.query(`INSERT INTO harness.instances(
          organization_id,project_id,assigned_node_id,port
        ) VALUES($1,$2,$3,$4)`, [this.context.organizationId, row.id, this.context.nodeId, port])
        return { id: publicNumber(row.public_id, 'project'), name: input.name, path: canonical, memberCount: 1 }
      })
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') {
        if (error.constraint === 'projects_organization_id_name_key') {
          throw new Error(`duplicate project name: ${input.name}`)
        }
        if (error.constraint === 'project_mounts_node_id_canonical_path_key') {
          throw new Error(`duplicate project path: ${canonical}`)
        }
        throw new Error(`duplicate project: ${error.message}`)
      }
      throw error
    }
  }

  async list(): Promise<ProjectRow[]> {
    const result = await this.context.pool.query<{
      public_id: string
      name: string
      path: string
      member_count: string
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,COUNT(m.user_id)::text member_count
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.status='active'
      GROUP BY p.id,pm.local_path ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId])
    return result.rows.map(row => ({
      id: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
      memberCount: Number(row.member_count),
    }))
  }

  async getById(id: number): Promise<ProjectDetail | null> {
    const project = await this.context.pool.query<{
      internal_id: string
      public_id: string
      name: string
      path: string
      member_count: string
    }>(`SELECT p.id internal_id,p.public_id::text,p.name::text,pm.local_path path,
      COUNT(m.user_id)::text member_count
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.public_id=$3 AND p.status='active'
      GROUP BY p.id,pm.local_path`, [this.context.organizationId, this.context.nodeId, id])
    const row = project.rows[0]
    if (row === undefined) return null
    const members = await this.context.pool.query<{
      user_id: string
      username: string
      access_mode: GrantMode
    }>(`SELECT u.public_id::text user_id,u.username::text,m.access_mode
      FROM harness.project_members m
      JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.project_id=$2 ORDER BY u.username`,
    [this.context.organizationId, row.internal_id])
    return {
      id: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
      memberCount: Number(row.member_count),
      members: members.rows.map(member => ({
        userId: publicNumber(member.user_id, 'user'),
        username: member.username,
        mode: member.access_mode,
      })),
    }
  }

  async rename(id: number, name: string): Promise<void> {
    try {
      await this.context.pool.query(`UPDATE harness.projects SET name=$3,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND public_id=$2`, [this.context.organizationId, id, name])
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') throw new Error(`duplicate project name: ${name}`)
      throw error
    }
  }

  async remove(id: number): Promise<number[]> {
    return transaction(this.context.pool, async (client) => {
      const projectId = await internalProjectId(client, this.context.organizationId, id)
      if (projectId === null) return []
      const members = await client.query<{ public_id: string }>(`SELECT u.public_id::text
        FROM harness.project_members m
        JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND m.project_id=$2 ORDER BY u.public_id`,
      [this.context.organizationId, projectId])
      await client.query('DELETE FROM harness.projects WHERE organization_id=$1 AND id=$2',
        [this.context.organizationId, projectId])
      return members.rows.map(row => publicNumber(row.public_id, 'user'))
    })
  }

  async setMember(projectId: number, userId: number, mode: GrantMode): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      const user = await internalUserId(client, this.context.organizationId, userId)
      if (project === null) throw new Error(`unknown project ${String(projectId)}`)
      if (user === null) throw new Error(`unknown user ${String(userId)}`)
      await client.query(`INSERT INTO harness.project_members(
        organization_id,project_id,user_id,access_mode
      ) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET
        access_mode=excluded.access_mode,updated_at=now()`, [this.context.organizationId, project, user, mode])
    })
  }

  async removeMember(projectId: number, userId: number): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const membership = await client.query<{ project_id: string; user_id: string }>(`SELECT
        m.project_id,m.user_id
        FROM harness.project_members m
        JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id
        JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND p.public_id=$2 AND u.public_id=$3
        FOR UPDATE OF m`, [this.context.organizationId, projectId, userId])
      const locked = membership.rows[0]
      if (locked === undefined) return
      const privateConversation = await client.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM harness.conversation_sessions c
        WHERE c.organization_id=$1 AND c.project_id=$2 AND c.creator_user_id=$3
          AND c.id=c.root_session_id AND c.visibility='private' AND c.status<>'deleted'
      ) blocked`, [this.context.organizationId, locked.project_id, locked.user_id])
      if (privateConversation.rows[0]?.blocked === true) {
        throw new CollaborationDeniedError('visibility-locked')
      }
      await client.query(`DELETE FROM harness.project_members
        WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`,
      [this.context.organizationId, locked.project_id, locked.user_id])
    })
  }

  async effectiveGrants(userId: number): Promise<EffectiveGrant[]> {
    const home = await this.context.pool.query<{ home_path: string }>(
      'SELECT home_path FROM harness.users WHERE organization_id=$1 AND public_id=$2',
      [this.context.organizationId, userId],
    )
    const grants: EffectiveGrant[] = []
    if (home.rows[0] !== undefined) grants.push({ path: home.rows[0].home_path, mode: 'rw', label: '主目录' })
    const projects = await this.context.pool.query<{ path: string; label: string; mode: GrantMode }>(`SELECT
      pm.local_path path,p.name::text label,m.access_mode mode
      FROM harness.project_members m
      JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$3 AND pm.status='active'
      WHERE m.organization_id=$1 AND u.public_id=$2 AND p.status='active' ORDER BY pm.local_path`,
    [this.context.organizationId, userId, this.context.nodeId])
    for (const row of projects.rows) grants.push({ path: row.path, mode: row.mode, label: row.label })
    return grants
  }

  private async assertNotReserved(canonical: string): Promise<void> {
    if (this.cfg.launcher === 'systemd' && !isProjectPathIsolated(canonical, this.cfg.projectPathRoots)) {
      throw new Error(`project path is outside HGW_PROJECT_PATH_ROOTS: ${canonical}`)
    }
    const reservedPaths = [this.cfg.usersRoot, this.cfg.projectRuntimesRoot]
      .map(path => realpathIfPresent(path) ?? path)
    for (const reserved of reservedPaths) {
      if (canonical === reserved) throw new Error(`project path overlaps reserved path: ${reserved}`)
    }
    if (this.cfg.launcher === 'systemd' && projectPathsOverlap(canonical, this.cfg.gatewayDir)) {
      throw new Error(`project path overlaps gateway directory: ${this.cfg.gatewayDir}`)
    }
    const users = await this.context.pool.query<{ username: string; home_path: string }>(
      'SELECT username::text,home_path FROM harness.users WHERE organization_id=$1',
      [this.context.organizationId],
    )
    for (const user of users.rows) {
      const home = realpathIfPresent(user.home_path) ?? user.home_path
      if (projectPathsOverlap(canonical, home)) {
        throw new Error(`path is a user home: ${canonical}`)
      }
      const dsh = join(this.cfg.usersRoot, user.username, 'dsh')
      const canonicalDsh = realpathIfPresent(dsh) ?? dsh
      if (projectPathsOverlap(canonical, canonicalDsh)) {
        throw new Error(`path is a user dsh home: ${canonical}`)
      }
    }
    for (const reserved of reservedPaths) {
      if (projectPathsOverlap(canonical, reserved)) throw new Error(`project path overlaps reserved path: ${reserved}`)
    }
    const projects = await this.context.pool.query<{ path: string }>(`SELECT pm.canonical_path path
      FROM harness.project_mounts pm
      JOIN harness.projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
      WHERE pm.organization_id=$1 AND pm.node_id=$2 AND pm.status='active' AND p.status='active'`,
    [this.context.organizationId, this.context.nodeId])
    if (projects.rows.some(project => project.path === canonical)) {
      throw new Error(`duplicate project path: ${canonical}`)
    }
    const overlap = projects.rows.find(project => projectPathsOverlap(canonical, project.path))
    if (overlap !== undefined) throw new Error(`project path overlaps existing project: ${overlap.path}`)
  }
}
