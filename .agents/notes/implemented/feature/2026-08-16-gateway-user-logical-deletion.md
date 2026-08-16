# Agent Note: Gateway logical user deletion

Status: implemented

English | [中文](2026-08-16-gateway-user-logical-deletion.zh.md)

## Problem

The admin user page could create, disable, and reset accounts, but it had no deletion operation. Physical deletion is unsafe because projects, conversations, content files, usage records, and audit events retain foreign-key references to users. Leaving a disabled account fully provisioned also leaves sessions, project grants, runtime credentials, and model intake credentials available for accidental reuse.

## Decision

`DELETE /admin/api/users/:id` performs a logical deletion. The Gateway first holds the user's serialized instance-operation slot and stops the personal runtime, then marks the account disabled with `users.deleted_at`, revokes sessions, clears runtime token fields, removes project memberships, model-user access, intake tokens, and user-specific quotas, and records `admin.users.delete`. Active user counts, lists, username lookup, authentication, internal public-id resolution, directory grants, model summaries, and intake-token resolution exclude deleted rows. The home directory, conversations, content metadata, model usage, usage alerts, and audit rows remain available for historical reporting; the unique username remains reserved and cannot be recreated.

The current administrator cannot delete themself. An active administrator cannot be deleted when it would leave no other active administrator. The same last-admin rule remains in force for disable and demotion. A deleted account is never returned by the admin API, so later mutations receive `404`; a repeated delete is idempotently treated as not found.

SQLite schema version 5 adds `users.deleted_at` to existing databases. PostgreSQL migration 006 adds the timestamp and an active-account lookup index. SQLite import carries the deletion timestamp into PostgreSQL. The PostgreSQL login transaction rechecks and locks the active user row before creating a session, so a concurrent deletion cannot create a fresh session after revocation.

## Consequences

Administrators can remove access without destroying records needed for audit, usage, collaboration history, or local recovery. Deleted accounts disappear from normal account workflows and cannot restart a runtime or receive new model credentials. Their local home and username remain reserved, so restoring an account requires an explicit future recovery workflow rather than silently creating a new identity with the same name.

## Verification

Focused Gateway tests cover SQLite logical deletion, retained audit rows, removed project memberships, stopped instances, last-admin rejection, API self-delete rejection, runtime stopping, session invalidation, hidden users, and delete auditing. Admin UI tests cover the DELETE request and confirmation dialog. Gateway typecheck and the admin UI production build pass. PostgreSQL integration coverage exercises migration 6 when `HGW_TEST_DATABASE_URL` is configured.

## Alternatives considered

**Physically delete the user and cascade every reference.** Rejected because it destroys audit and usage attribution, removes conversation history, and requires weakening or rewriting durable foreign keys.

**Only mark the account disabled.** Rejected because project memberships, runtime credentials, model access, and intake tokens would remain provisioned and the account would still appear in administrative workflows.

**Allow username reuse after deletion.** Rejected because old audit, conversation, and filesystem records would become ambiguous between two identities; the existing organization-scoped unique username is intentionally retained.
