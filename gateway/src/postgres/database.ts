import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'

const MIGRATION_LOCK_KEY = 0x48475750

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HGW_DATABASE_URL !== undefined && env.HGW_DATABASE_URL.trim() !== '') return env.HGW_DATABASE_URL.trim()
  if (env.HGW_DATABASE_URL_FILE !== undefined && env.HGW_DATABASE_URL_FILE.trim() !== '') {
    throw new Error('HGW_DATABASE_URL_FILE must be resolved asynchronously with databaseUrlFromFile')
  }
  throw new Error('HGW_DATABASE_URL or HGW_DATABASE_URL_FILE is required')
}

export async function databaseUrlFromFile(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.HGW_DATABASE_URL !== undefined && env.HGW_DATABASE_URL.trim() !== '') return env.HGW_DATABASE_URL.trim()
  const path = env.HGW_DATABASE_URL_FILE?.trim()
  if (path === undefined || path === '') throw new Error('HGW_DATABASE_URL or HGW_DATABASE_URL_FILE is required')
  const value = (await readFile(path, 'utf8')).trim()
  if (value === '') throw new Error(`database URL file is empty: ${path}`)
  return value
}

export function createPostgresPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ...overrides })
}

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  } finally {
    client.release()
  }
}

interface MigrationFile { version: number; name: string; path: string; checksum: string; sql: string }

async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_-]+\.sql$/.test(name)).sort()
  const versions = new Set<number>()
  const migrations: MigrationFile[] = []
  for (const name of names) {
    const version = Number(name.slice(0, 3))
    if (versions.has(version)) throw new Error(`duplicate PostgreSQL migration version ${String(version)}`)
    versions.add(version)
    const path = resolve(directory, name)
    const sql = await readFile(path, 'utf8')
    migrations.push({ version, name, path, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  if (migrations.length === 0) throw new Error(`no PostgreSQL migrations found in ${directory}`)
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(`PostgreSQL migration sequence expected version ${String(expected)}, found ${String(migration.version)}`)
    }
  }
  return migrations
}

/** Apply immutable SQL migrations under one PostgreSQL advisory lock. */
export async function runMigrations(pool: Pool, directory: string): Promise<{ applied: number[]; current: number }> {
  const migrations = await migrationFiles(directory)
  const client = await pool.connect()
  const applied: number[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query('CREATE SCHEMA IF NOT EXISTS harness')
    await client.query(`CREATE TABLE IF NOT EXISTS harness.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const existing = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM harness.schema_migrations ORDER BY version',
    )
    const byVersion = new Map(existing.rows.map(row => [row.version, row]))
    for (const [index, recorded] of existing.rows.entries()) {
      const expected = index + 1
      if (recorded.version !== expected) {
        throw new Error(`PostgreSQL migration ledger expected version ${String(expected)}, found ${String(recorded.version)}`)
      }
      const migration = migrations[index]
      if (migration === undefined) {
        throw new Error(`database contains unknown PostgreSQL migration version ${String(recorded.version)}`)
      }
      if (recorded.name !== migration.name || recorded.checksum !== migration.checksum) {
        throw new Error(`PostgreSQL migration ${migration.name} differs from the applied checksum`)
      }
    }
    for (const migration of migrations) {
      const recorded = byVersion.get(migration.version)
      if (recorded !== undefined) {
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO harness.schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
          [migration.version, migration.name, migration.checksum],
        )
        await client.query('COMMIT')
        applied.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return { applied, current: migrations.at(-1)?.version ?? 0 }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]) } catch { /* connection close releases it */ }
    client.release()
  }
}
