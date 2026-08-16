import type { Pool } from 'pg'
import type { Queryable } from './database.ts'

/** Organization and compute-node identity used by one Gateway process. */
export interface PostgresRuntimeContext {
  pool: Pool
  organizationId: string
  organizationSlug: string
  nodeId: string
  nodeName: string
}

/** Resolve an existing active organization and compute node or reject startup. */
export async function resolvePostgresRuntimeContext(
  pool: Pool,
  organizationSlug: string,
  nodeName: string,
): Promise<PostgresRuntimeContext> {
  const result = await pool.query<{
    organization_id: string
    organization_slug: string
    node_id: string
    node_name: string
  }>(`SELECT o.id organization_id,o.slug::text organization_slug,n.id node_id,n.name::text node_name
    FROM harness.organizations o
    JOIN harness.compute_nodes n ON n.organization_id=o.id
    WHERE o.slug=$1 AND o.status='active' AND n.name=$2 AND n.status='active'`,
  [organizationSlug, nodeName])
  const row = result.rows[0]
  if (row === undefined) {
    throw new Error(`active PostgreSQL organization/node not found: ${organizationSlug}/${nodeName}`)
  }
  return {
    pool,
    organizationId: row.organization_id,
    organizationSlug: row.organization_slug,
    nodeId: row.node_id,
    nodeName: row.node_name,
  }
}

/** Verify that PostgreSQL and the configured organization/node remain ready. */
export async function checkPostgresReadiness(context: PostgresRuntimeContext): Promise<void> {
  const result = await context.pool.query(`SELECT 1 FROM harness.organizations o
    JOIN harness.compute_nodes n ON n.organization_id=o.id
    WHERE o.id=$1 AND o.status='active' AND n.id=$2 AND n.status='active'`,
  [context.organizationId, context.nodeId])
  if (result.rowCount !== 1) throw new Error('PostgreSQL organization or compute node is not active')
}

/** Convert a PostgreSQL bigint field used by the HTTP API into a safe JavaScript integer. */
export function publicNumber(value: string | number, subject: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${subject} public id is not a positive safe integer: ${String(value)}`)
  }
  return number
}

/** Resolve an organization-scoped public user id to its internal UUID. */
export async function internalUserId(
  queryable: Queryable,
  organizationId: string,
  publicId: number,
): Promise<string | null> {
  const result = await queryable.query<{ id: string }>(
    'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL',
    [organizationId, publicId],
  )
  return result.rows[0]?.id ?? null
}

/** Resolve an organization-scoped public project id to its internal UUID. */
export async function internalProjectId(
  queryable: Queryable,
  organizationId: string,
  publicId: number,
): Promise<string | null> {
  const result = await queryable.query<{ id: string }>(
    'SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2',
    [organizationId, publicId],
  )
  return result.rows[0]?.id ?? null
}
