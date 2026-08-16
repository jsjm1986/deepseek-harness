import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type Database from 'better-sqlite3'
import type { GatewayConfig } from './config.ts'

export type GrantMode = 'ro' | 'rw'

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
}

export interface ProjectDetail extends ProjectRow {
  members: Array<{ userId: number; username: string; mode: GrantMode }>
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

export class ProjectService {
  constructor(
    private readonly db: Database.Database,
    private readonly cfg: GatewayConfig,
  ) {}

  create(input: { name: string; path: string; createdBy: number }): ProjectRow {
    const canonical = resolveProjectDirectory(input.path)
    this.assertNotReserved(canonical)
    const now = Date.now()
    try {
      const info = this.db.prepare(
        `INSERT INTO projects(name, path, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`,
      ).run(input.name, canonical, input.createdBy, now, now)
      return { id: Number(info.lastInsertRowid), name: input.name, path: canonical, memberCount: 0 }
    } catch (error) {
      this.rethrowUnique(error, input.name, canonical)
    }
  }

  list(): ProjectRow[] {
    return (this.db.prepare(
      `SELECT p.id, p.name, p.path, COUNT(m.user_id) AS memberCount
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id
       GROUP BY p.id ORDER BY p.id`,
    ).all() as ProjectRow[])
  }

  getById(id: number): ProjectDetail | null {
    const row = this.db.prepare(
      `SELECT p.id, p.name, p.path, COUNT(m.user_id) AS memberCount
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id
       WHERE p.id = ? GROUP BY p.id`,
    ).get(id) as ProjectRow | undefined
    if (row === undefined) return null
    const members = this.db.prepare(
      `SELECT m.user_id AS userId, u.username AS username, m.mode AS mode
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY u.username`,
    ).all(id) as ProjectDetail['members']
    return { ...row, members }
  }

  rename(id: number, name: string): void {
    try {
      this.db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id)
    } catch (error) {
      this.rethrowUnique(error, name)
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
    this.db.prepare(
      `INSERT INTO project_members(project_id, user_id, mode) VALUES(?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET mode = excluded.mode`,
    ).run(projectId, userId, mode)
  }

  removeMember(projectId: number, userId: number): void {
    this.db.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`).run(projectId, userId)
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
