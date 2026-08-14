# Agent Note: PostgreSQL JSONB Gateway baseline

Status: implemented

English | [中文](2026-08-14-postgresql-jsonb-gateway-baseline.zh.md)

## Problem

The Gateway SQLite schema mixes identity, projects, instance state, governance, usage, and audit in one synchronous connection, while Harness conversations remain separate per-user JSONL artifacts. Enterprise growth needs stronger concurrency, versioned migrations, and queryable conversation history, but treating Agent data as conventional normalized CRUD or adding a separate document database would duplicate the existing event vocabulary and add unnecessary operations.

## Decision

The first migration baseline uses one pinned PostgreSQL 17 database. Relational control data uses typed columns, organization-consistent composite foreign keys, and organization-scoped idempotency keys. Complete structured Harness conversation events are stored in JSONB beside fixed ordering and query columns. Large binary files, attachments, generated artifacts, and oversized tool output stay on the local filesystem and are represented by metadata and checksums in PostgreSQL.

The baseline ships independently of the live Gateway storage selection. Production continues to use `gateway.sqlite` until asynchronous repositories replace each synchronous service and a separately approved cutover is rehearsed. Existing JSONL/Zstd session logs are not imported in this phase. The existing [SessionPersistence decision](2026-06-14-session-persistence.md) continues to own online session semantics; this Gateway repository is a migration target rather than a second live persistence path. The broader [storage-domain proposal](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) remains separate future work; the baseline does not implement its log facet.

SQL migrations are immutable numbered files. A migration ledger stores SHA-256 checksums, and a PostgreSQL advisory lock admits only one migrator. The local Docker deployment pins PostgreSQL by tag and image digest, binds loopback only, uses a named volume, and reads its password from a Compose secret file.

Conversation appends lock the session row, require contiguous sequence numbers, preserve arbitrary string Session IDs, and use globally idempotent batch IDs. The complete event is JSONB; user, final assistant, and tool-result text is projected into a trigram search table. Continuous provider chunks retain the existing Harness packing behavior rather than becoming one database row per token.

The SQLite importer is one transactional and repeatable control-plane import. It preserves password hashes, users, projects and local mounts, stopped instance assignments, governance, price history, quotas, usage, alerts, and audit. Authentication sessions, login attempts, and intake tokens are intentionally dropped so credentials are re-established after cutover.

## Testing

A real PostgreSQL 17.6 container verifies migration application and idempotency, checksum and unknown-version rejection, organization isolation, arbitrary string Session IDs, JSONB event round trips, sequence rejection, concurrent retry idempotency, nested tool-result search, and repeatable import of both a complete control-plane fixture and a production SQLite online snapshot. Backup validation uses an owner-only custom-format dump and restores it into a disposable database before accepting the procedure.

## Alternatives considered

**Store conversations in MongoDB.** Rejected because PostgreSQL JSONB already handles the evolving event payload while preserving transaction, ordering, authorization, governance, and audit joins in one operational system.

**Normalize every event type into dedicated tables.** Rejected because the Harness event map is extension-oriented; schema migrations for every plugin event would make persistence own domain vocabulary it currently preserves generically.

**Put all attachments and generated files in PostgreSQL.** Rejected because large binary values and workspace files would bloat backups and WAL. The current local filesystem remains the appropriate first-stage medium.

**Switch production as soon as the DDL exists.** Rejected because the live services still synchronously depend on `better-sqlite3`. The baseline must be independently verified before repository replacement and cutover.

## Consequences

The repository includes a concrete, runnable PostgreSQL target without introducing MongoDB, Redis, object storage, or microservices. Conversation data remains flexible through JSONB and searchable through PostgreSQL. Migration, import, backup, and restore behavior are executable rather than prose-only. The cost is an intentional transition period in which PostgreSQL is not yet the live Gateway database, existing conversation logs remain local JSONL, and single-host Docker provides durability but not high availability.
