# Agent Note: Gateway logical user deletion

Status: implemented

English | [中文](2026-08-16-gateway-user-logical-deletion.zh.md)

## Problem

The administrator user page could create, disable, and reset accounts but could not remove one. Physical deletion is unsafe because projects, conversations, usage records, content metadata, and audit events retain user references. A disabled account also keeps sessions, project grants, runtime credentials, and model intake credentials unless those resources are revoked explicitly.

## Decision

`DELETE /admin/api/users/:id` performs a logical deletion. The Gateway serializes and stops the user's runtime, marks the account disabled with `users.deleted_at`, revokes authentication sessions, clears runtime and intake credentials, removes project memberships, model-user access, and user-specific quotas, and writes the `admin.users.delete` audit event. Deleted rows are excluded from active counts, lists, username lookup, authentication, public-id resolution, project grants, model access, and intake-token lookup. The home directory, conversations, content metadata, model usage, usage alerts, and audit history remain available for reporting and recovery. The organization-scoped username remains reserved.

The current administrator cannot delete themself. Deleting an active administrator is rejected when it would leave no other active administrator; the same invariant applies to disable and demotion. A repeated delete is reported as not found because deleted users are absent from the normal administrative view. PostgreSQL login rechecks and locks the active user and membership rows before creating a session, so a concurrent deletion cannot create a new session after revocation. Existing sessions also fail validation when the account is marked deleted.

SQLite schema version 5 adds `users.deleted_at` to existing databases. PostgreSQL migration 006 adds the timestamp and active-account lookup index. SQLite import carries the deletion timestamp into PostgreSQL when present, while historical rows remain organization-scoped and foreign-key valid.

## Consequences

Administrators can revoke an account without destroying audit, usage, collaboration, or conversation history. Deleted accounts cannot log in, restart a runtime, receive new model credentials, or be added to a project. Recovery is an explicit future operation rather than silent username reuse, and the retained home directory may require a separate retention policy.

## Alternatives considered

**Physically delete the user and cascade every reference.** Rejected because it destroys audit and usage attribution, removes conversation history, and weakens durable foreign-key guarantees.

**Only mark the account disabled.** Rejected because sessions, memberships, runtime credentials, model access, and intake tokens would remain provisioned and the account would continue to appear in some workflows.

**Allow username reuse after deletion.** Rejected because old audit, conversation, and filesystem records would become ambiguous between two identities.

## Verification

Gateway tests cover logical deletion, retained history, revoked sessions, removed memberships and credentials, stopped instances, hidden users, last-admin rejection, and authentication refusal. Admin API tests cover the DELETE response, audit path, list filtering, and self-delete rejection. Admin UI tests cover the confirmation dialog and DELETE request. PostgreSQL integration tests cover migration 006 and the active-row login check when `HGW_TEST_DATABASE_URL` is configured.
