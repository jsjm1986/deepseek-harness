import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { GatewayConfig } from './config.ts'

export type GrantMode = 'ro' | 'rw'

/** Whether a project was provisioned by an administrator or its owner. */
export type ProjectOrigin = 'admin' | 'user'

/** Public identity shown for a project owner or creator. */
export interface ProjectActor {
  id: number
  username: string
  displayName: string
}

/** Lifecycle state of a project invitation. */
export type ProjectInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'

/** One project invitation visible to its sender, recipient, or administrator. */
export interface ProjectInvitation {
  id: string
  projectId: number
  projectName: string
  invitee: ProjectActor
  inviter: ProjectActor
  mode: GrantMode
  status: ProjectInvitationStatus
  expiresAt: string | null
  createdAt: string
  respondedAt: string | null
}

export interface EffectiveGrant {
  path: string
  mode: GrantMode
  label: string
}

export interface ProjectRow {
  id: number
  name: string
  path: string
  memberCount: number
  /** Source metadata is optional for legacy in-process callers; PostgreSQL always supplies it. */
  origin?: ProjectOrigin
  owner?: ProjectActor | null
  createdBy?: ProjectActor | null
}

export interface ProjectDetail extends ProjectRow {
  members: Array<{ userId: number; username: string; mode: GrantMode }>
  invitations?: ProjectInvitation[]
}

/**
 * Normalize a project name used by the project catalog and managed directory root.
 * @param name - administrator-supplied project name
 * @returns trimmed, single-directory-segment project name
 * @throws `project-name-invalid` when the name cannot identify one safe directory segment
 */
export function normalizeProjectName(name: string): string {
  const normalized = name.trim()
  if (
    normalized === ''
    || normalized === '.'
    || normalized === '..'
    || normalized.length > 120
    || /[\\/\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error('project-name-invalid')
  }
  return normalized
}

function isCodedError(error: unknown): error is Error & { code: string } {
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

/** Whether either canonical path contains the other. */
export function projectPathsOverlap(left: string, right: string): boolean {
  const leftRelative = relative(left, right)
  const rightRelative = relative(right, left)
  const contained = (value: string): boolean => value === ''
    || (!value.startsWith('../') && value !== '..' && !isAbsolute(value))
  return contained(leftRelative) || contained(rightRelative)
}

/** Whether a canonical project path is a strict descendant of one configured systemd isolation root. */
export function isProjectPathIsolated(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const nested = relative(root, path)
    return nested !== '' && !nested.startsWith('../') && nested !== '..' && !isAbsolute(nested)
  })
}

function rethrowProjectPathFailure(error: unknown): never {
  if (isCodedError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    throw new Error('project-path-not-found', { cause: error })
  }
  if (isCodedError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    throw new Error('project-path-inaccessible', { cause: error })
  }
  throw error
}

/**
 * Resolve an existing host directory or throw a stable project-path diagnostic.
 * @param path - absolute path supplied by an administrator
 * @returns canonical directory path stored for grants and mounts
 */
export function resolveProjectDirectory(path: string): string {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch (error) {
    rethrowProjectPathFailure(error)
  }

  let isDirectory: boolean
  try {
    isDirectory = statSync(canonical).isDirectory()
  } catch (error) {
    rethrowProjectPathFailure(error)
  }
  if (!isDirectory) throw new Error('project-path-not-directory')
  return canonical
}

/**
 * Create or resolve a project directory below the configured managed root.
 * @param cfg - Gateway configuration containing the managed project root
 * @param name - administrator-supplied project name
 * @returns normalized name and canonical directory path
 * @throws a stable project-name or project-path diagnostic when creation is unsafe or inaccessible
 */
export function ensureManagedProjectDirectory(cfg: GatewayConfig, name: string): { name: string; path: string } {
  const normalized = normalizeProjectName(name)
  const root = resolve(cfg.projectsRoot)
  try {
    if (mkdirSync(root, { recursive: true, mode: 0o770 }) !== undefined) chmodSync(root, 0o770)
  } catch (error) {
    if (isCodedError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
      throw new Error('project-path-inaccessible', { cause: error })
    }
    if (isCodedError(error) && (error.code === 'EEXIST' || error.code === 'ENOTDIR')) {
      throw new Error('project-root-not-directory', { cause: error })
    }
    throw error
  }
  const canonicalRoot = resolveProjectDirectory(root)
  const candidate = join(canonicalRoot, normalized)
  try {
    if (mkdirSync(candidate, { recursive: true, mode: 0o770 }) !== undefined) chmodSync(candidate, 0o770)
  } catch (error) {
    // An existing file is resolved below so callers receive the stable
    // project-path-not-directory diagnostic; existing directories are reusable.
    if (!isCodedError(error) || error.code !== 'EEXIST') {
      if (isCodedError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
        throw new Error('project-path-inaccessible', { cause: error })
      }
      throw error
    }
  }
  const canonical = resolveProjectDirectory(candidate)
  if (canonical === canonicalRoot || canonical !== candidate || dirname(canonical) !== canonicalRoot) {
    throw new Error('project-path-outside-root')
  }
  return { name: normalized, path: canonical }
}

export class ProjectService {
  constructor(
    private readonly db: Database.Database,
    private readonly cfg: GatewayConfig,
  ) {}

  create(input: { name: string; path?: string; createdBy: number }): ProjectRow {
    const requestedPath = input.path?.trim()
    const managed = requestedPath === undefined || requestedPath === ''
      ? ensureManagedProjectDirectory(this.cfg, input.name)
      : undefined
    const canonical = managed !== undefined ? managed.path : resolveProjectDirectory(requestedPath!)
    this.assertNotReserved(canonical)
    return this.insert({
      name: managed?.name ?? normalizeProjectName(input.name),
      path: canonical,
      canonical,
      createdBy: input.createdBy,
      origin: 'admin',
      ownerUserId: null,
    })
  }

  /** Create an owned project directory below the configured managed root. */
  createManaged(input: { name: string; ownerUserId: number; createdBy?: number }): ProjectRow {
    const name = normalizeProjectName(input.name)
    const canonical = this.allocateManagedDirectory(name)
    try {
      this.assertNotReserved(canonical)
      return this.insert({
        name,
        path: canonical,
        canonical,
        createdBy: input.createdBy ?? input.ownerUserId,
        origin: 'user',
        ownerUserId: input.ownerUserId,
      })
    } catch (error) {
      // The directory is not a project until the transaction commits.
      try { this.removeManagedDirectory(canonical) } catch { /* preserve insert failure */ }
      throw error
    }
  }

  private insert(input: {
    name: string
    path: string
    canonical: string
    createdBy: number
    origin: ProjectOrigin
    ownerUserId: number | null
  }): ProjectRow {
    const now = Date.now()
    const insert = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO projects(name, path, created_by, origin, owner_user_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.name, input.canonical, input.createdBy, input.origin, input.ownerUserId, now, now)
      const id = Number(info.lastInsertRowid)
      this.db.prepare(`INSERT INTO project_members(project_id, user_id, mode) VALUES(?, ?, 'rw')`)
        .run(id, input.ownerUserId ?? input.createdBy)
      return {
        id,
        name: input.name,
        path: input.canonical,
        memberCount: 1,
        origin: input.origin,
        owner: input.ownerUserId === null ? null : this.actor(input.ownerUserId),
        createdBy: this.actor(input.createdBy),
      }
    })
    try {
      return insert()
    } catch (error) {
      this.rethrowUnique(error, input.name, input.canonical)
    }
  }

  list(): ProjectRow[] {
    return (this.db.prepare(
      `SELECT p.id, p.name, p.path, p.origin, p.owner_user_id AS ownerUserId,
              p.created_by AS createdById, COUNT(m.user_id) AS memberCount
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id
       GROUP BY p.id ORDER BY p.id`,
    ).all() as Array<ProjectRow & { ownerUserId: number | null; createdById: number | null }>)
      .map(row => ({
        id: row.id, name: row.name, path: row.path, memberCount: Number(row.memberCount),
        origin: row.origin, owner: row.ownerUserId === null ? null : this.actor(row.ownerUserId),
        createdBy: row.createdById === null ? null : this.actor(row.createdById),
      }))
  }

  getById(id: number): ProjectDetail | null {
    const row = this.db.prepare(
      `SELECT p.id, p.name, p.path, p.origin, p.owner_user_id AS ownerUserId,
              p.created_by AS createdById, COUNT(m.user_id) AS memberCount
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id
       WHERE p.id = ? GROUP BY p.id`,
    ).get(id) as (ProjectRow & { ownerUserId: number | null; createdById: number | null }) | undefined
    if (row === undefined) return null
    const members = this.db.prepare(
      `SELECT m.user_id AS userId, u.username AS username, m.mode AS mode
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY u.username`,
    ).all(id) as ProjectDetail['members']
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      memberCount: Number(row.memberCount),
      origin: row.origin,
      owner: row.ownerUserId === null ? null : this.actor(row.ownerUserId),
      createdBy: row.createdById === null ? null : this.actor(row.createdById),
      members,
    }
  }

  rename(id: number, name: string): void {
    const normalized = normalizeProjectName(name)
    try {
      this.db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`).run(normalized, Date.now(), id)
    } catch (error) {
      this.rethrowUnique(error, normalized)
    }
  }

  remove(id: number): number[] {
    const ids = (this.db.prepare(
      `SELECT user_id AS userId FROM project_members WHERE project_id = ?`,
    ).all(id) as Array<{ userId: number }>).map(r => r.userId).sort((a, b) => a - b)
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    return ids
  }

  setMember(projectId: number, userId: number, mode: GrantMode): void {
    const owner = this.db.prepare(`SELECT owner_user_id AS ownerUserId FROM projects WHERE id = ?`)
      .get(projectId) as { ownerUserId: number | null } | undefined
    if (owner?.ownerUserId === userId && mode !== 'rw') throw new Error('owner-must-be-rw')
    this.db.prepare(
      `INSERT INTO project_members(project_id, user_id, mode) VALUES(?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET mode = excluded.mode`,
    ).run(projectId, userId, mode)
  }

  removeMember(projectId: number, userId: number): void {
    const owner = this.db.prepare(`SELECT owner_user_id AS ownerUserId FROM projects WHERE id = ?`)
      .get(projectId) as { ownerUserId: number | null } | undefined
    if (owner?.ownerUserId === userId) throw new Error('owner-protected')
    this.db.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`).run(projectId, userId)
  }

  /** Create a pending invitation for the project owner or an active administrator. */
  createInvitation(input: { projectId: number; inviteeUserId: number; inviterUserId: number; mode: GrantMode }): ProjectInvitation {
    const project = this.db.prepare(`SELECT id FROM projects WHERE id = ?`).get(input.projectId)
    if (project === undefined) throw new Error('project-not-found')
    const inviter = this.db.prepare(`SELECT role,status FROM users WHERE id = ?`).get(input.inviterUserId) as
      { role: 'admin' | 'user'; status: 'active' | 'disabled' } | undefined
    const owner = this.db.prepare(`SELECT owner_user_id AS ownerUserId FROM projects WHERE id = ?`).get(input.projectId) as
      { ownerUserId: number | null } | undefined
    if (inviter === undefined || inviter.status !== 'active'
      || (inviter.role !== 'admin' && owner?.ownerUserId !== input.inviterUserId)) {
      throw new Error('invitation-forbidden')
    }
    const invitee = this.db.prepare(`SELECT status FROM users WHERE id = ?`).get(input.inviteeUserId) as
      { status: 'active' | 'disabled' } | undefined
    if (invitee === undefined) throw new Error('user-not-found')
    if (invitee.status !== 'active') throw new Error('user-disabled')
    const member = this.db.prepare(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(input.projectId, input.inviteeUserId)
    if (member !== undefined) throw new Error('invitation-already-member')
    const now = Date.now()
    try {
      const result = this.db.prepare(`INSERT INTO project_invitations(
        project_id,invitee_user_id,inviter_user_id,mode,status,created_at
      ) VALUES(?,?,?,?, 'pending',?)`).run(input.projectId, input.inviteeUserId, input.inviterUserId, input.mode, now)
      return this.invitation(Number(result.lastInsertRowid))
    } catch (error) {
      if (isCodedError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('invitation-already-pending')
      }
      throw error
    }
  }

  listInvitations(userId: number, projectId?: number): ProjectInvitation[] {
    const rows = this.db.prepare(`SELECT id FROM project_invitations
      WHERE (invitee_user_id = ? OR inviter_user_id = ? OR project_id IN (
        SELECT id FROM projects WHERE owner_user_id = ?
      ) OR EXISTS (
        SELECT 1 FROM users administrator
        WHERE administrator.id = ? AND administrator.role = 'admin' AND administrator.status = 'active'
      )) AND (? IS NULL OR project_id = ?) ORDER BY created_at DESC`)
      .all(userId, userId, userId, userId, projectId ?? null, projectId ?? null) as Array<{ id: number }>
    return rows.map(row => this.invitation(row.id))
  }

  acceptInvitation(id: string, userId: number): void {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('invitation-not-found')
    const invitationId = Number(id)
    if (!Number.isSafeInteger(invitationId)) throw new Error('invitation-not-found')
    const result = this.db.transaction(() => {
      const invitation = this.db.prepare(`SELECT project_id AS projectId, invitee_user_id AS inviteeUserId,
        mode,status,expires_at AS expiresAt FROM project_invitations WHERE id = ?`).get(invitationId) as {
        projectId: number; inviteeUserId: number; mode: GrantMode; status: ProjectInvitationStatus; expiresAt: number | null
      } | undefined
      if (invitation === undefined) throw new Error('invitation-not-found')
      if (invitation.inviteeUserId !== userId) throw new Error('invitation-forbidden')
      if (invitation.status !== 'pending') throw new Error('invitation-not-pending')
      if (invitation.expiresAt !== null && invitation.expiresAt <= Date.now()) {
        this.db.prepare(`UPDATE project_invitations SET status='expired',responded_at=? WHERE id=?`)
          .run(Date.now(), invitationId)
        return 'expired' as const
      }
      this.db.prepare(`INSERT INTO project_members(project_id,user_id,mode) VALUES(?,?,?)
        ON CONFLICT(project_id,user_id) DO UPDATE SET mode=excluded.mode`).run(
        invitation.projectId, userId, invitation.mode,
      )
      this.db.prepare(`UPDATE project_invitations SET status='accepted',responded_at=? WHERE id=?`).run(Date.now(), invitationId)
      return 'accepted' as const
    })()
    if (result === 'expired') throw new Error('invitation-expired')
  }

  private invitation(id: number): ProjectInvitation {
    const row = this.db.prepare(`SELECT i.id,i.project_id AS projectId,p.name AS projectName,
      i.invitee_user_id AS inviteeId,iu.username AS inviteeUsername,iu.display_name AS inviteeDisplayName,
      i.inviter_user_id AS inviterId,ru.username AS inviterUsername,ru.display_name AS inviterDisplayName,
      i.mode,i.status,i.expires_at AS expiresAt,i.created_at AS createdAt,i.responded_at AS respondedAt
      FROM project_invitations i JOIN projects p ON p.id=i.project_id
      JOIN users iu ON iu.id=i.invitee_user_id JOIN users ru ON ru.id=i.inviter_user_id WHERE i.id=?`).get(id) as {
      id: number; projectId: number; projectName: string; inviteeId: number; inviteeUsername: string; inviteeDisplayName: string;
      inviterId: number; inviterUsername: string; inviterDisplayName: string; mode: GrantMode; status: ProjectInvitationStatus;
      expiresAt: number | null; createdAt: number; respondedAt: number | null
    } | undefined
    if (row === undefined) throw new Error('invitation-not-found')
    return {
      id: String(row.id), projectId: row.projectId, projectName: row.projectName,
      invitee: { id: row.inviteeId, username: row.inviteeUsername, displayName: row.inviteeDisplayName },
      inviter: { id: row.inviterId, username: row.inviterUsername, displayName: row.inviterDisplayName },
      mode: row.mode, status: row.status,
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
      respondedAt: row.respondedAt === null ? null : new Date(row.respondedAt).toISOString(),
    }
  }

  private actor(id: number): ProjectActor {
    const row = this.db.prepare(`SELECT id,username,display_name AS displayName FROM users WHERE id=?`).get(id) as ProjectActor | undefined
    if (row === undefined) throw new Error(`unknown user ${String(id)}`)
    return row
  }

  private allocateManagedDirectory(name: string): string {
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.length > 120) throw new Error('invalid project name')
    const slug = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project'
    const root = this.cfg.userProjectsRoot
    mkdirSync(root, { recursive: true, mode: 0o770 })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = join(root, `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      try { mkdirSync(candidate, { mode: 0o770 }); return realpathSync(candidate) } catch (error) {
        if (isCodedError(error) && error.code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('managed project directory allocation failed')
  }

  private removeManagedDirectory(path: string): void {
    // SQLite's synchronous service only creates empty managed directories.
    try { rmSync(path, { recursive: true, force: true }) } catch { /* preserve insert failure */ }
  }

  effectiveGrants(userId: number): EffectiveGrant[] {
    const grants: EffectiveGrant[] = []
    const home = this.db.prepare(`SELECT home_path FROM users WHERE id = ?`).get(userId) as
      { home_path: string } | undefined
    if (home !== undefined) grants.push({ path: home.home_path, mode: 'rw', label: '主目录' })
    const rows = this.db.prepare(
      `SELECT p.path AS path, p.name AS label, m.mode AS mode
       FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = ? ORDER BY p.path`,
    ).all(userId) as Array<{ path: string; label: string; mode: GrantMode }>
    for (const row of rows) grants.push({ path: row.path, mode: row.mode, label: row.label })
    return grants
  }

  private assertNotReserved(canonical: string): void {
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
    const users = this.db.prepare(`SELECT username, home_path FROM users`).all() as
      Array<{ username: string; home_path: string }>
    for (const user of users) {
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
    const projects = this.db.prepare(`SELECT path FROM projects`).all() as Array<{ path: string }>
    if (projects.some(project => project.path === canonical)) {
      throw new Error(`duplicate project path: ${canonical}`)
    }
    const overlap = projects.find(project => projectPathsOverlap(canonical, project.path))
    if (overlap !== undefined) throw new Error(`project path overlaps existing project: ${overlap.path}`)
  }

  private rethrowUnique(error: unknown, name: string, path?: string): never {
    if (isCodedError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      if (error.message.includes('projects.name')) throw new Error(`duplicate project name: ${name}`)
      if (path !== undefined && error.message.includes('projects.path')) {
        throw new Error(`duplicate project path: ${path}`)
      }
      throw new Error(`duplicate project: ${error.message}`)
    }
    throw error
  }
}
