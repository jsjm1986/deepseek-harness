import { resolve } from 'node:path'
import { createPostgresPool, databaseUrlFromEnv, runMigrations } from '../src/postgres/database.ts'

const pool = createPostgresPool(databaseUrlFromEnv())
try {
  const database = await pool.query<{ name: string }>('SELECT current_database() name')
  const name = database.rows[0]?.name ?? ''
  if (!/(?:_test|_accept|_acceptance)$/.test(name)) {
    throw new Error(`acceptance database name must end in _test, _accept, or _acceptance: ${name}`)
  }
  await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
  await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
    VALUES('acceptance','Gateway Acceptance') RETURNING id`)
  await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name)
    VALUES($1,'local')`, [organization.rows[0]!.id])
  console.log(`[accept] prepared disposable PostgreSQL database ${name}`)
} finally {
  await pool.end()
}
