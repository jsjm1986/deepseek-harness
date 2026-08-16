# Agent Note: PostgreSQL JSONB Gateway baseline

Status: implemented

English | [中文](2026-08-14-postgresql-jsonb-gateway-baseline.zh.md)

## Problem

The original Gateway SQLite schema mixed identity, projects, instance state, governance, usage, and audit in one synchronous connection, while Harness conversations were separate per-user JSONL artifacts. Enterprise operation needs stronger concurrency, versioned migrations, and queryable shared conversation history, but treating Agent data as conventional normalized CRUD or adding a separate document database would duplicate the existing event vocabulary and add unnecessary operations.

## Decision

The migration series uses one pinned PostgreSQL 17 database. Relational control data uses typed columns, organization-consistent composite foreign keys, and organization-scoped idempotency keys. Complete structured Harness conversation events are stored in PostgreSQL `json` beside fixed ordering and query columns; the [full-JSON event decision](../bug-fix/2026-08-15-postgresql-session-event-full-json.md) supersedes the baseline JSONB choice for this column. Large binary files, attachments, generated artifacts, and oversized tool output stay on the local filesystem and are represented by metadata and checksums in PostgreSQL.

This note owns the PostgreSQL schema and migration mechanism. The [PostgreSQL Gateway runtime cutover](2026-08-14-postgresql-gateway-runtime-cutover.md) owns the asynchronous control-plane services and production database selection, while [project collaborative conversations](../feature/2026-08-15-project-collaborative-conversations.md) owns the authenticated project `SessionPersistence` provider. Existing JSONL/Zstd session logs are not imported. The existing [SessionPersistence decision](2026-06-14-session-persistence.md) continues to own online session semantics; personal runtimes keep their configured provider and project runtimes use PostgreSQL through that same interface. The broader [storage-domain proposal](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) remains separate future work; the Gateway schema does not implement its generic log facet.

SQL migrations are immutable numbered files. A migration ledger stores SHA-256 checksums, and a PostgreSQL advisory lock admits only one migrator. Migration 3 adds shared project runtime ownership, root-inherited `project`/`private` visibility, participant projections, atomic approval/question claims, and project quota/usage subjects. Migration 4 changes the complete event column to PostgreSQL `json` and removes the payload expression index. The local Docker deployment pins PostgreSQL by tag and image digest, binds loopback only, uses a named volume, and reads its password from a Compose secret file.

Conversation appends lock the session row, require contiguous sequence numbers, preserve arbitrary string Session IDs, and use globally idempotent batch IDs. Root creation stores the authenticated creator, project, and visibility; descendants copy the locked root ACL. Committed participant message sources update per-root contributor rows, and PostgreSQL uniqueness selects one responder for each shared approval/question. The complete event is PostgreSQL `json`; user, final assistant, and tool-result text is projected into a trigram search table. Continuous provider chunks retain the existing Harness packing behavior rather than becoming one database row per token.

The SQLite importer is one transactional and repeatable control-plane import. It preserves password hashes, users, projects and local mounts, stopped personal instance assignments, governance, price history, user quotas, usage, alerts, and audit. Migration 3 allocates shared runtime rows for active mounted projects and restores each project creator as an `rw` member when necessary. Authentication sessions, login attempts, runtime/intake tokens, and JSONL transcripts are intentionally dropped so credentials and collaborative history start from the PostgreSQL authority after cutover.

## Testing

A real PostgreSQL 17.6 container verifies migrations through version 4, idempotency, checksum and unknown-version rejection, organization isolation, arbitrary string Session IDs, full JSON event round trips including NUL strings, sequence rejection, concurrent retry idempotency, nested tool-result search, root ACL inheritance, participant projection, interaction races, project usage/quota records, and repeatable import of both a complete control-plane fixture and a production SQLite online snapshot. Backup validation uses an owner-only custom-format dump and restores it into a disposable database before accepting the procedure.

## Alternatives considered

**Store conversations in MongoDB.** Rejected because PostgreSQL JSON plus explicit projections handles the evolving event payload while preserving transaction, ordering, authorization, governance, and audit joins in one operational system.

**Normalize every event type into dedicated tables.** Rejected because the Harness event map is extension-oriented; schema migrations for every plugin event would make persistence own domain vocabulary it currently preserves generically.

**Put all attachments and generated files in PostgreSQL.** Rejected because large binary values and workspace files would bloat backups and WAL. The current local filesystem remains the appropriate first-stage medium.

**Switch production as soon as the DDL exists.** Rejected because the live services still synchronously depend on `better-sqlite3`. The baseline must be independently verified before repository replacement and cutover.

## Consequences

The repository includes one live PostgreSQL authority without introducing MongoDB, Redis, object storage, or microservices. Shared project conversation data remains flexible through PostgreSQL JSON, searchable through explicit projections, and protected by relational membership and root ACL checks. Migration, import, backup, and restore behavior are executable rather than prose-only. Existing personal JSONL transcripts remain local and are not imported, and single-host Docker provides durability but not high availability.
