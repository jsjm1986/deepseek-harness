import { createPostgresPool, databaseUrlFromFile } from '../src/postgres/database.ts'

const pool = createPostgresPool(await databaseUrlFromFile())
try {
  const result = await pool.query<{ version: number }>('SELECT max(version) AS version FROM harness.schema_migrations')
  const counts = await pool.query<{ users: string; audits: string; conversations: string; events: string }>(`SELECT
    (SELECT count(*) FROM harness.users)::text users,
    (SELECT count(*) FROM harness.audit_events)::text audits,
    (SELECT count(*) FROM harness.conversation_sessions)::text conversations,
    (SELECT count(*) FROM harness.conversation_events)::text events`)
  console.log(JSON.stringify({ migration: result.rows[0]?.version, ...counts.rows[0] }))
} finally {
  await pool.end()
}
