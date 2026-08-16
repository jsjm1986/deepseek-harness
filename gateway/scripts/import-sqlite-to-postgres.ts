import { resolve } from 'node:path'
import { createPostgresPool, databaseUrlFromFile } from '../src/postgres/database.ts'
import { importSqliteControlPlane } from '../src/postgres/sqlite-import.ts'

const sqliteFile = process.argv[2]
if (sqliteFile === undefined) throw new Error('usage: npm run pg:import-sqlite -- /absolute/path/gateway.sqlite')
const pool = createPostgresPool(await databaseUrlFromFile())
try {
  const report = await importSqliteControlPlane(pool, {
    sqliteFile: resolve(sqliteFile),
    organizationSlug: process.env.HGW_ORGANIZATION_SLUG ?? 'default',
    organizationName: process.env.HGW_ORGANIZATION_NAME ?? 'Default Organization',
    nodeName: process.env.HGW_COMPUTE_NODE_NAME ?? 'local',
  })
  console.log(JSON.stringify(report))
} finally {
  await pool.end()
}
