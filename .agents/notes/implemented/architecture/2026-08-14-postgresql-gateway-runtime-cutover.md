# Agent Note: PostgreSQL Gateway runtime cutover

Status: implemented

English | [中文](2026-08-14-postgresql-gateway-runtime-cutover.zh.md)

## Problem

The [PostgreSQL JSONB baseline](2026-08-14-postgresql-jsonb-gateway-baseline.md) provides the schema, importer, backups, and conversation repository, but the live Gateway services originally called `better-sqlite3` synchronously. Supplying a PostgreSQL URL without replacing authentication, users, projects, instance state, audit, model governance, and usage would leave SQLite authoritative or stop the process during startup.

## Decision

The Gateway entry point requires `HGW_DATABASE_URL` or an owner-readable `HGW_DATABASE_URL_FILE`, applies immutable migrations, and resolves one active `HGW_ORGANIZATION_SLUG` plus `HGW_COMPUTE_NODE_NAME` before listening. `/healthz` verifies that PostgreSQL and both selected records remain active. Startup fails before binding a port when any required database input is absent or invalid.

Gateway consumers use awaitable service interfaces. The existing SQLite classes remain import and focused-test implementations; production constructs PostgreSQL authentication, user, project, collaboration, conversation, audit, model-governance, usage, and personal/project instance repositories. HTTP handlers, WebSocket proxy setup, signed-principal issuance, policy projection, systemd grant rendering, project Session persistence, and usage intake await every operation that can cross the database process boundary.

PostgreSQL UUIDs stay internal. `users.public_id` and `projects.public_id` preserve imported SQLite numbers and allocate numeric IDs for later HTTP API records. Every query is scoped to the selected organization; mounts, ports, personal/project instance state, and idle reaping are additionally scoped to the selected compute node. User creation transactionally inserts the user, password credential, membership, and node-local personal instance assignment; project creation inserts its creator membership, mount, and shared runtime assignment in the same transaction.

The production cutover stops Gateway writes, takes an online SQLite backup, repeats the transactional import, applies all migrations, validates a PostgreSQL dump by restoring it into a disposable database, and then starts the PostgreSQL-only entry point. Authentication sessions, login attempts, runtime credentials, intake tokens, and JSONL transcripts are not imported, so users sign in again, runtime policy files receive new intake tokens, and shared project conversation history begins in PostgreSQL after cutover. The frozen SQLite backup is the rollback source; the PostgreSQL-running process never opens or writes `gateway.sqlite`.

## Verification

A real PostgreSQL 17.6 container covers migrations through version 4, public-ID preservation and allocation, organization isolation, complete SQLite control-plane import, authentication and session revocation, user/project administration, personal/project instance state, shared conversation persistence and ACLs, full JSON session-event round trips, audit queries, model policy, user/project quota inheritance, exact micro-currency conversion, idempotent usage ingestion, and threshold alerts. SQLite unit and assembled HTTP/proxy tests continue to cover shared routing and instance lifecycle behavior. Production acceptance checks local and public health, authenticated admin assets and APIs, personal/project proxying, two-member shared and private conversation behavior, `ro` refusal, the private usage intake, the absence of new SQLite writes, and a post-cutover PostgreSQL restore check.

## Alternatives considered

**Dual-write SQLite and PostgreSQL.** Rejected because two independently mutable authorities require reconciliation for authentication, allocation, audit order, policy changes, and idempotent usage. A stopped-writes final import gives one explicit authority transition.

**Keep synchronous service APIs and hide PostgreSQL behind blocking adapters.** Rejected because Node has no appropriate blocking PostgreSQL client for this server, and blocking would stall unrelated HTTP, proxy, and intake work.

**Expose PostgreSQL UUIDs through the existing HTTP API.** Rejected because admin routes, instance maps, policy subjects, imported audit references, and the existing UI use numeric IDs. Stable public numbers preserve those contracts without weakening internal organization foreign keys.

**Retain SQLite as an automatic runtime fallback.** Rejected because a PostgreSQL outage must fail readiness and startup visibly. Silent fallback would accept writes into a stale database and make recovery ambiguous.

## Consequences

PostgreSQL is the sole live Gateway control-plane database, and availability depends on its loopback container and selected organization/node records. Database operations are asynchronous through the full request path. Shared project runtimes use PostgreSQL as their live `SessionPersistence` provider; existing personal JSONL/Zstd conversations and large files remain on the host filesystem. The single-host Docker deployment has tested logical backup and rollback but does not provide cross-host high availability.
