import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { GatewayConfig } from '../config.ts'
import {
  ensureManagedProjectDirectory,
  isProjectPathIsolated,
  normalizeProjectName,
  projectPathsOverlap,
  resolveProjectDirectory,
  type EffectiveGrant,
  type GrantMode,
  type ProjectDetail,
  type ProjectInvitation,
  type ProjectInvitationStatus,
  type ProjectOrigin,
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

function managedSlug(name: string): string {
  return normalizeProjectName(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project'
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** PostgreSQL-backed project catalog and node-local mounts for one organization. */
export class PostgresProjectService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  async create(input: { name: string; path?: string; createdBy: number }): Promise<ProjectRow> {
    const requestedPath = input.path?.trim()
    const managed = requestedPath === undefined || requestedPath === ''
      ? ensureManagedProjectDirectory(this.cfg, input.name)
      : undefined
    const canonical = managed !== undefined ? managed.path : resolveProjectDirectory(requestedPath!)
    await this.assertNotReserved(canonical)
    return this.insert({
      name: managed?.name ?? normalizeProjectName(input.name),
      canonical,
      createdBy: input.createdBy,
      origin: 'admin',
      ownerUserId: null,
    })
  }

  /** Allocate and provision a user-owned project below HGW_USER_PROJECTS_ROOT. */
  async createManaged(input: { name: string; ownerUserId: number; createdBy?: number }): Promise<ProjectRow> {
    const name = normalizeProjectName(input.name)
    await mkdir(this.cfg.userProjectsRoot, { recursive: true, mode: 0o770 })
    let canonical: string | undefined
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = join(this.cfg.userProjectsRoot, `${managedSlug(name)}-${randomUUID().slice(0, 12)}`)
      try {
        await mkdir(candidate, { mode: 0o770 })
        canonical = await realpath(candidate)
        break
      } catch (error) {
        if (isCodedError(error) && error.code === 'EEXIST') continue
        throw error
      }
    }
    if (canonical === undefined) throw new Error('managed project directory allocation failed')
    try {
      await this.assertNotReserved(canonical)
      return await this.insert({
        name,
        canonical,
        createdBy: input.createdBy ?? input.ownerUserId,
        origin: 'user',
        ownerUserId: input.ownerUserId,
      })
    } catch (error) {
      await rm(canonical, { recursive: true, force: true })
      throw error
    }
  }

  private async insert(input: {
    name: string
    canonical: string
    createdBy: number
    origin: ProjectOrigin
    ownerUserId: number | null
  }): Promise<ProjectRow> {
    try {
      const publicId = await transaction(this.context.pool, async (client) => {
        const createdBy = await internalUserId(client, this.context.organizationId, input.createdBy)
        if (createdBy === null) throw new Error(`unknown user ${String(input.createdBy)}`)
        const owner = input.ownerUserId === null
          ? null
          : await internalUserId(client, this.context.organizationId, input.ownerUserId)
        if (input.ownerUserId !== null && owner === null) throw new Error(`unknown user ${String(input.ownerUserId)}`)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
        const project = await client.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
          organization_id,name,created_by,origin,owner_user_id
        ) VALUES($1,$2,$3,$4,$5) RETURNING id,public_id::text`, [
          this.context.organizationId, input.name, createdBy, input.origin, owner,
        ])
        const row = project.rows[0]
        if (row === undefined) throw new Error('project insert returned no row')
        await client.query(`INSERT INTO harness.project_mounts(
          organization_id,project_id,node_id,local_path,canonical_path
        ) VALUES($1,$2,$3,$4,$4)`, [this.context.organizationId, row.id, this.context.nodeId, input.canonical])
        await client.query(`INSERT INTO harness.project_members(
          organization_id,project_id,user_id,access_mode
        ) VALUES($1,$2,$3,'rw')`, [this.context.organizationId, row.id, owner ?? createdBy])
        const ports = await client.query<{ port: number | null }>(`SELECT MAX(port) port FROM harness.instances
          WHERE assigned_node_id=$1`, [this.context.nodeId])
        const port = ports.rows[0]?.port === null || ports.rows[0]?.port === undefined
          ? this.cfg.instancePortBase
          : Math.max(this.cfg.instancePortBase, ports.rows[0].port + 1)
        if (port > 65535) throw new Error(`no instance ports remain on node ${this.context.nodeName}`)
        await client.query(`INSERT INTO harness.instances(
          organization_id,project_id,assigned_node_id,port
        ) VALUES($1,$2,$3,$4)`, [this.context.organizationId, row.id, this.context.nodeId, port])
        return publicNumber(row.public_id, 'project')
      })
      const detail = await this.getById(publicId)
      if (detail === null) throw new Error('project insert returned no detail')
      return detail
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') {
        if (error.constraint === 'projects_organization_id_name_key') throw new Error(`duplicate project name: ${input.name}`)
        if (error.constraint === 'project_mounts_node_id_canonical_path_key') throw new Error(`duplicate project path: ${input.canonical}`)
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
      origin: ProjectOrigin
      owner_id: string | null
      owner_public_id: string | null
      owner_username: string | null
      owner_display_name: string | null
      creator_public_id: string | null
      creator_username: string | null
      creator_display_name: string | null
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,COUNT(m.user_id)::text member_count,
      p.origin,
      owner.id owner_id,owner.public_id::text owner_public_id,owner.username::text owner_username,owner.display_name owner_display_name,
      creator.public_id::text creator_public_id,creator.username::text creator_username,creator.display_name creator_display_name
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN harness.users owner ON owner.id=p.owner_user_id AND owner.organization_id=p.organization_id
      LEFT JOIN harness.users creator ON creator.id=p.created_by AND creator.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.status='active'
      GROUP BY p.id,pm.local_path,owner.id,creator.id ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId])
    return result.rows.map(row => ({
      id: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
      memberCount: Number(row.member_count),
      origin: row.origin,
      owner: row.owner_id === null ? null : {
        id: publicNumber(row.owner_public_id!, 'user'), username: row.owner_username!, displayName: row.owner_display_name!,
      },
      createdBy: row.creator_public_id === null ? null : {
        id: publicNumber(row.creator_public_id, 'user'), username: row.creator_username!, displayName: row.creator_display_name!,
      },
    }))
  }

  async getById(id: number): Promise<ProjectDetail | null> {
    const project = await this.context.pool.query<{
      internal_id: string
      public_id: string
      name: string
      path: string
      member_count: string
      origin: ProjectOrigin
      owner_id: string | null
      owner_public_id: string | null
      owner_username: string | null
      owner_display_name: string | null
      creator_public_id: string | null
      creator_username: string | null
      creator_display_name: string | null
    }>(`SELECT p.id internal_id,p.public_id::text,p.name::text,pm.local_path path,
      COUNT(m.user_id)::text member_count,p.origin,
      owner.id owner_id,owner.public_id::text owner_public_id,owner.username::text owner_username,owner.display_name owner_display_name,
      creator.public_id::text creator_public_id,creator.username::text creator_username,creator.display_name creator_display_name
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN harness.users owner ON owner.id=p.owner_user_id AND owner.organization_id=p.organization_id
      LEFT JOIN harness.users creator ON creator.id=p.created_by AND creator.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.public_id=$3 AND p.status='active'
      GROUP BY p.id,pm.local_path,owner.id,creator.id`, [this.context.organizationId, this.context.nodeId, id])
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
      origin: row.origin,
      owner: row.owner_id === null ? null : {
        id: publicNumber(row.owner_public_id!, 'user'), username: row.owner_username!, displayName: row.owner_display_name!,
      },
      createdBy: row.creator_public_id === null ? null : {
        id: publicNumber(row.creator_public_id, 'user'), username: row.creator_username!, displayName: row.creator_display_name!,
      },
      members: members.rows.map(member => ({
        userId: publicNumber(member.user_id, 'user'),
        username: member.username,
        mode: member.access_mode,
      })),
    }
  }

  async rename(id: number, name: string): Promise<void> {
    const normalized = normalizeProjectName(name)
    try {
      await this.context.pool.query(`UPDATE harness.projects SET name=$3,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND public_id=$2`, [this.context.organizationId, id, normalized])
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') throw new Error(`duplicate project name: ${normalized}`)
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
      const owner = await client.query<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.context.organizationId, project],
      )
      if (owner.rows[0]?.owner_user_id === user && mode !== 'rw') throw new Error('owner-must-be-rw')
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
      const owner = await client.query<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.context.organizationId, locked.project_id],
      )
      if (owner.rows[0]?.owner_user_id === locked.user_id) throw new Error('owner-protected')
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

  /** Create a pending invitation for one organization user. */
  async createInvitation(input: {
    projectId: number
    inviteeUserId: number
    inviterUserId: number
    mode: GrantMode
  }): Promise<ProjectInvitation> {
    try {
      const projectId = await internalProjectId(this.context.pool, this.context.organizationId, input.projectId)
      if (projectId === null) throw new Error(`unknown project ${String(input.projectId)}`)
      const inviteeId = await internalUserId(this.context.pool, this.context.organizationId, input.inviteeUserId)
      if (inviteeId === null) throw new Error(`unknown user ${String(input.inviteeUserId)}`)
      const inviterId = await internalUserId(this.context.pool, this.context.organizationId, input.inviterUserId)
      if (inviterId === null) throw new Error(`unknown user ${String(input.inviterUserId)}`)
      const authority = await this.context.pool.query<{ role: 'admin' | 'member'; status: 'active' | 'disabled'; owner_user_id: string | null }>(`SELECT
        m.role,u.status,p.owner_user_id
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.projects p ON p.organization_id=u.organization_id AND p.id=$3
        WHERE u.organization_id=$1 AND u.id=$2`, [this.context.organizationId, inviterId, projectId])
      const authorityRow = authority.rows[0]
      if (authorityRow === undefined || authorityRow.status !== 'active'
        || (authorityRow.role !== 'admin' && authorityRow.owner_user_id !== inviterId)) {
        throw new Error('invitation-forbidden')
      }
      const invitee = await this.context.pool.query<{ status: 'active' | 'disabled' }>(
        'SELECT status FROM harness.users WHERE organization_id=$1 AND id=$2',
        [this.context.organizationId, inviteeId],
      )
      if (invitee.rows[0] === undefined) throw new Error(`unknown user ${String(input.inviteeUserId)}`)
      if (invitee.rows[0].status !== 'active') throw new Error('user-disabled')
      const existing = await this.context.pool.query(`SELECT 1 FROM harness.project_members
        WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`, [this.context.organizationId, projectId, inviteeId])
      if (existing.rowCount !== null && existing.rowCount > 0) throw new Error('invitation-already-member')
      const row = await this.context.pool.query<{ id: string }>(`INSERT INTO harness.project_invitations(
        organization_id,project_id,invitee_user_id,inviter_user_id,access_mode
      ) VALUES($1,$2,$3,$4,$5) RETURNING id::text`, [
        this.context.organizationId,
        projectId, inviteeId, inviterId,
        input.mode,
      ])
      const invitationId = row.rows[0]?.id
      if (invitationId === undefined) throw new Error('invitation insert returned no row')
      return await this.invitationById(invitationId)
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') throw new Error('invitation-already-pending')
      throw error
    }
  }

  async listInvitations(userId: number, projectId?: number): Promise<ProjectInvitation[]> {
    const internalUser = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalUser === null) return []
    const values: unknown[] = [this.context.organizationId, internalUser]
    let projectClause = ''
    if (projectId !== undefined) {
      const internalProject = await internalProjectId(this.context.pool, this.context.organizationId, projectId)
      if (internalProject === null) return []
      values.push(internalProject)
      projectClause = ' AND i.project_id=$3'
    }
    const result = await this.context.pool.query<{ id: string }>(`SELECT i.id::text FROM harness.project_invitations i
      JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND (i.invitee_user_id=$2 OR i.inviter_user_id=$2 OR p.owner_user_id=$2 OR EXISTS (
        SELECT 1 FROM harness.memberships administrator
        WHERE administrator.organization_id=i.organization_id AND administrator.user_id=$2
          AND administrator.role='admin' AND administrator.status='active'
      ))
        ${projectClause} ORDER BY i.created_at DESC`, values)
    return Promise.all(result.rows.map(row => this.invitationById(row.id)))
  }

  async acceptInvitation(invitationId: string, userId: number): Promise<void> {
    if (!isUuid(invitationId)) throw new Error('invitation-not-found')
    const result = await transaction(this.context.pool, async (client) => {
      const internalUser = await internalUserId(client, this.context.organizationId, userId)
      if (internalUser === null) throw new Error(`unknown user ${String(userId)}`)
      const invitation = await client.query<{
        project_id: string; invitee_user_id: string; access_mode: GrantMode; status: ProjectInvitationStatus; expires_at: Date | null
      }>(`SELECT project_id,invitee_user_id,access_mode,status,expires_at FROM harness.project_invitations
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, invitationId])
      const row = invitation.rows[0]
      if (row === undefined) throw new Error('invitation-not-found')
      if (row.invitee_user_id !== internalUser) throw new Error('invitation-forbidden')
      if (row.status !== 'pending') throw new Error('invitation-not-pending')
      if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
        await client.query(`UPDATE harness.project_invitations SET status='expired',responded_at=now()
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, invitationId])
        return 'expired' as const
      }
      await client.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET access_mode=excluded.access_mode,updated_at=now()`, [
        this.context.organizationId, row.project_id, internalUser, row.access_mode,
      ])
      await client.query(`UPDATE harness.project_invitations SET status='accepted',responded_at=now()
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, invitationId])
      return 'accepted' as const
    })
    if (result === 'expired') throw new Error('invitation-expired')
  }

  private async invitationById(id: string): Promise<ProjectInvitation> {
    const result = await this.context.pool.query<{
      project_public_id: string; project_name: string
      invitee_public_id: string; invitee_username: string; invitee_display_name: string
      inviter_public_id: string; inviter_username: string; inviter_display_name: string
      mode: GrantMode; status: ProjectInvitationStatus; expires_at: Date | null; created_at: Date; responded_at: Date | null
    }>(`SELECT p.public_id::text project_public_id,p.name::text project_name,
      iu.public_id::text invitee_public_id,iu.username::text invitee_username,iu.display_name invitee_display_name,
      ru.public_id::text inviter_public_id,ru.username::text inviter_username,ru.display_name inviter_display_name,
      i.access_mode mode,i.status,i.expires_at,i.created_at,i.responded_at
      FROM harness.project_invitations i
      JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      JOIN harness.users iu ON iu.id=i.invitee_user_id AND iu.organization_id=i.organization_id
      JOIN harness.users ru ON ru.id=i.inviter_user_id AND ru.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.id=$2`, [this.context.organizationId, id])
    const row = result.rows[0]
    if (row === undefined) throw new Error('invitation-not-found')
    return {
      id,
      projectId: publicNumber(row.project_public_id, 'project'),
      projectName: row.project_name,
      invitee: { id: publicNumber(row.invitee_public_id, 'user'), username: row.invitee_username, displayName: row.invitee_display_name },
      inviter: { id: publicNumber(row.inviter_public_id, 'user'), username: row.inviter_username, displayName: row.inviter_display_name },
      mode: row.mode,
      status: row.status,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      respondedAt: row.responded_at?.toISOString() ?? null,
    }
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
