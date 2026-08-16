# Local PostgreSQL control plane

English | [中文](README.zh.md)

This directory runs the Gateway PostgreSQL control plane. It uses one PostgreSQL 17 database: ordinary columns for control data, PostgreSQL JSON for append-only conversation events, and host paths for large local files. It does not add MongoDB, Redis, object storage, or a second service tier. The Gateway entry point requires this database and never opens SQLite.

## Start locally

```bash
cd gateway/deploy/postgres
mkdir -p secrets "$HOME/harness-postgres-backups"
openssl rand -hex 32 > secrets/postgres_password
chmod 600 secrets/postgres_password
cp .env.example .env
set -a; . ./.env; set +a

docker compose up -d --wait
PASSWORD="$(cat secrets/postgres_password)"
ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PASSWORD")"
mkdir -p "$HOME/.config/harness-gateway"
printf 'postgresql://harness_owner:%s@127.0.0.1:%s/harness\n' "$ENCODED" "${HGW_POSTGRES_PORT:-5432}" \
  > "$HOME/.config/harness-gateway/database-url"
chmod 600 "$HOME/.config/harness-gateway/database-url"
export HGW_DATABASE_URL_FILE="$HOME/.config/harness-gateway/database-url"
cd ../..
npm run pg:migrate
npm run pg:check
```

Adjust the host backup directory and port in `.env` before sourcing it.

The image is pinned by tag and digest. PostgreSQL binds to loopback only and stores its data in the `harness_postgres_data` Docker named volume. `secrets/postgres_password` and `.env` are ignored by Git.

## Schema and conversation data

`migrations/001_initial.sql` creates one `harness` schema containing identity, projects, instances, model governance, usage, audit, and conversation tables. `002_gateway_public_ids.sql` preserves imported SQLite user/project numbers and allocates numeric public IDs while UUIDs remain internal. `003_project_collaboration.sql` adds shared project runtime ownership, root-inherited conversation visibility, participant projections, atomic approval/question claims, and project usage/quota subjects. `004_conversation_event_json.sql` changes the complete event column to PostgreSQL `json`, which preserves every valid JSON string including escaped NUL, and removes the payload expression index. `005_user_owned_projects.sql` adds project origin/owner metadata and transactional invitations, so account-created workspaces and administrator-registered directories share one control-plane model. `006_user_deletion.sql` adds the `users.deleted_at` timestamp and a partial index over active accounts for logical user deletion. Composite foreign keys prevent organization-scoped records from referencing another organization. Conversation envelopes keep queryable columns (`session_id`, `seq`, event type and time); the complete structured Harness event is stored in `conversation_events.event`, while searchable text uses its dedicated projection table. Continuous chunks remain packed by the existing Harness persistence path rather than becoming one SQL row per token.

Images, archives, generated files, and oversized tool output remain on the local filesystem. `content_files` stores user or project ownership, local path, SHA-256, byte length, and media type. The SQLite importer migrates only the Gateway control plane and never imports existing JSONL session logs. Personal runtimes retain their configured local persistence; new shared project runtimes use the authenticated Gateway `SessionPersistence` provider and store complete Session headers/events in these PostgreSQL conversation tables.

## Import a Gateway SQLite snapshot

Always import an online SQLite backup, not a copied live WAL database:

```bash
sqlite3 "$HOME/harness-gateway-data/gateway.sqlite" \
  ".backup '/tmp/gateway-before-postgres.sqlite'"

HGW_ORGANIZATION_SLUG=internal \
HGW_ORGANIZATION_NAME='Internal Harness' \
HGW_COMPUTE_NODE_NAME=mac-mini \
  npm run pg:import-sqlite -- /tmp/gateway-before-postgres.sqlite
npm run pg:check
```

The importer is transactional and repeatable for one organization. It preserves password hashes, users, projects, origin/owner metadata, mounts, stopped personal instance assignments, memberships, pending and completed project invitations, model policy, prices, quotas, usage, alerts, and audit rows. Imported invitation UUIDs are derived from the organization and legacy SQLite invitation id, so a repeated import updates the same row. Migration 3 makes each existing project creator an `rw` member when needed; administrator-origin legacy projects remain administrator-origin unless the SQLite row explicitly carries user ownership. Gateway startup serializes port allocation with a node-scoped PostgreSQL advisory lock and creates missing runtime rows for active mounted projects from `HGW_INSTANCE_PORT_BASE`; schema SQL never embeds deployment port numbers. Login sessions, lockout attempts, runtime/intake tokens, and existing JSONL/Zstd conversations are deliberately not migrated; users sign in again, credentials are reissued, personal transcripts stay in their current session directories, and collaborative PostgreSQL history begins with project-scope conversations created after cutover.

## Gateway runtime and cutover

The running process needs `HGW_DATABASE_URL_FILE`, `HGW_ORGANIZATION_SLUG`, and `HGW_COMPUTE_NODE_NAME`. The organization and node must already exist and remain active. Startup applies pending migrations before binding the HTTP port, and `/healthz` returns `503` when PostgreSQL or either selected record is unavailable.

For a SQLite production migration, stop the Gateway first, create a final online SQLite backup, run the importer against that frozen file, then apply migrations and create and restore-check a PostgreSQL dump. Start the new Gateway only after those commands succeed. Verify a new login, `/admin` assets and APIs, user/project/model/usage/audit views, personal and project runtime proxying, project scope/visibility/participant behavior, `ro` denial, project quota/usage updates, and the private intake port. Confirm the frozen SQLite file's modification time does not advance.

Rollback stops the PostgreSQL Gateway, restores the pre-cutover Gateway artifact that still uses SQLite, and restores the frozen standalone SQLite backup at its configured data path before starting that artifact. Never run both artifacts against user traffic, and never import PostgreSQL writes backward into SQLite. Investigate or preserve the PostgreSQL database separately before another cutover attempt.

## Backup and restore check

```bash
npm run pg:backup
npm run pg:restore-check -- "$HOME/harness-postgres-backups/harness-YYYYMMDD-HHMMSS.dump"
```

`pg:backup` writes a PostgreSQL custom-format dump with owner-only permissions from its first byte, validates its catalog, publishes it atomically, and retains the newest 30 dumps by default. `pg:restore-check` restores one dump into a disposable database and verifies the migration ledger before deleting that disposable database.

The named volume and host backup directory are on the same machine. This protects against logical mistakes and a broken container, not whole-host or disk loss. Copy successful dumps to a second machine or NAS before treating this as an enterprise backup.

## Tests

`HGW_TEST_DATABASE_URL` explicitly enables the integration suite:

```bash
HGW_TEST_DATABASE_URL="$HGW_DATABASE_URL" \
HGW_TEST_SQLITE_FILE=/tmp/gateway-before-postgres.sqlite \
  npm run test:postgres
```

It drops only the `harness` schema in the supplied test database. Never point it at production. Coverage includes immutable migrations through version 6, rejection of an unknown migration ledger, organization isolation, arbitrary string session IDs, full JSON round trips including NUL strings, contiguous sequence enforcement, concurrent batch idempotency, nested tool-result search, repeatable SQLite import including project invitations, root-inherited collaboration ACLs, contribution projections, interaction races, shared project runtime allocation from a configured empty-node port base, project credentials/quotas/usage, and the live authentication, user, project, node-instance, audit, and model-governance services.
