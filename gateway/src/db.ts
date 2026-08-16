import { mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import Database from 'better-sqlite3'

export const SCHEMA_VERSION = 5

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  home_path TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  origin TEXT NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin','user')),
  owner_user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((origin = 'user' AND owner_user_id IS NOT NULL) OR (origin = 'admin'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_invitations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invitee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_invitations_pending
  ON project_invitations(project_id, invitee_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_project_invitations_invitee ON project_invitations(invitee_user_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, ip, ts);
CREATE TABLE IF NOT EXISTS instances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  port INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped','starting','ready','stopping')),
  pid INTEGER,
  started_at INTEGER,
  last_activity_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  method_path TEXT NOT NULL DEFAULT '',
  status INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE TABLE IF NOT EXISTS model_catalog (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS model_role_access (
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  PRIMARY KEY (role, provider, model),
  FOREIGN KEY (provider, model) REFERENCES model_catalog(provider, model) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS model_user_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  PRIMARY KEY (user_id, provider, model),
  FOREIGN KEY (provider, model) REFERENCES model_catalog(provider, model) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  input_micros_per_million INTEGER NOT NULL,
  output_micros_per_million INTEGER NOT NULL,
  cache_read_micros_per_million INTEGER NOT NULL,
  cache_write_micros_per_million INTEGER NOT NULL,
  UNIQUE(provider, model, effective_at),
  FOREIGN KEY (provider, model) REFERENCES model_catalog(provider, model) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS model_quotas (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role','user')),
  subject_id TEXT NOT NULL,
  token_limit INTEGER,
  company_cost_micros_limit INTEGER,
  PRIMARY KEY (subject_type, subject_id)
);
CREATE TABLE IF NOT EXISTS model_intake_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_usage (
  event_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  session_id TEXT,
  credential_source TEXT NOT NULL,
  credential_class TEXT NOT NULL CHECK (credential_class IN ('company','personal','unknown')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled','missing-usage','denied')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  company_cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_model_usage_user_time ON model_usage(user_id, occurred_at);
CREATE TABLE IF NOT EXISTS model_usage_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('tokens','company-cost')),
  threshold INTEGER NOT NULL CHECK (threshold IN (80,100)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, month, metric, threshold)
);
`

type ProjectMode = 'ro' | 'rw'

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map(r => r.name),
  )
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
}

function uniqueProjectName(db: Database.Database, baseName: string): string {
  let name = baseName
  let suffix = 2
  while (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name)) {
    name = `${baseName}-${suffix}`
    suffix++
  }
  return name
}

function migrateLegacyGrants(db: Database.Database): void {
  const now = Date.now()
  const paths = db.prepare(`SELECT DISTINCT path FROM dir_grants`).all() as Array<{ path: string }>
  const pathToProjectId = new Map<string, number>()

  for (const { path } of paths) {
    const name = uniqueProjectName(db, basename(path))
    const result = db.prepare(
      `INSERT INTO projects (name, path, created_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    ).run(name, path, now, now)
    pathToProjectId.set(path, Number(result.lastInsertRowid))
  }

  const members = new Map<number, Map<number, ProjectMode>>()

  function addMember(projectId: number, userId: number, mode: ProjectMode): void {
    let userModes = members.get(projectId)
    if (!userModes) {
      userModes = new Map()
      members.set(projectId, userModes)
    }
    const existing = userModes.get(userId)
    if (!existing || (mode === 'rw' && existing === 'ro')) {
      userModes.set(userId, mode)
    }
  }

  const grants = db.prepare(`SELECT subject_type, subject_id, path, mode FROM dir_grants`).all() as Array<{
    subject_type: string
    subject_id: number
    path: string
    mode: ProjectMode
  }>

  for (const grant of grants) {
    const projectId = pathToProjectId.get(grant.path)
    if (!projectId) continue

    if (grant.subject_type === 'user') {
      addMember(projectId, grant.subject_id, grant.mode)
    } else if (grant.subject_type === 'group') {
      const groupMembers = db.prepare(
        `SELECT user_id FROM group_members WHERE group_id = ?`,
      ).all(grant.subject_id) as Array<{ user_id: number }>
      for (const { user_id } of groupMembers) {
        addMember(projectId, user_id, grant.mode)
      }
    }
  }

  const insertMember = db.prepare(
    `INSERT INTO project_members (project_id, user_id, mode) VALUES (?, ?, ?)`,
  )
  for (const [projectId, userModes] of members) {
    for (const [userId, mode] of userModes) {
      insertMember.run(projectId, userId, mode)
    }
  }
}

function migrate(db: Database.Database): void {
  // Copy, drops, and the version stamp commit together so a failed upgrade retries from the original tables.
  const upgrade = db.transaction(() => {
    const names = tableNames(db)
    const hasLegacy = names.has('groups') || names.has('dir_grants')

    if (hasLegacy) {
      if (names.has('dir_grants')) {
        migrateLegacyGrants(db)
      }
      db.exec(`
        DROP TABLE IF EXISTS group_members;
        DROP TABLE IF EXISTS groups;
        DROP TABLE IF EXISTS dir_grants;
      `)
    }

    const projectColumns = columnNames(db, 'projects')
    if (!projectColumns.has('origin')) {
      db.exec(`ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin'
        CHECK (origin IN ('admin','user'))`)
    }
    if (!projectColumns.has('owner_user_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN owner_user_id INTEGER REFERENCES users(id)')
    }
    if (!names.has('project_invitations')) {
      db.exec(`CREATE TABLE project_invitations (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        invitee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        responded_at INTEGER
      );
      CREATE UNIQUE INDEX idx_project_invitations_pending
        ON project_invitations(project_id, invitee_user_id) WHERE status = 'pending';
      CREATE INDEX idx_project_invitations_invitee ON project_invitations(invitee_user_id, status, created_at DESC);`)
    }

    const userColumns = columnNames(db, 'users')
    if (!userColumns.has('deleted_at')) {
      db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER')
    }

    db.exec('DELETE FROM schema_meta')
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
  })
  upgrade()
}

export function openDb(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}
