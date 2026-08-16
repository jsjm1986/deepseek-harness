import { resolve } from 'node:path'
import { createPostgresPool, databaseUrlFromFile, runMigrations } from '../src/postgres/database.ts'

const pool = createPostgresPool(await databaseUrlFromFile())
try {
  const result = await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  console.log(JSON.stringify(result))
} finally {
  await pool.end()
}
