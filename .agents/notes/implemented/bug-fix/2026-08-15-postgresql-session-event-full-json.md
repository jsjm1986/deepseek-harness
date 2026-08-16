# Agent Note: Store PostgreSQL session events as full JSON

Status: implemented

English | [中文](2026-08-15-postgresql-session-event-full-json.zh.md)

## Problem

`SessionEvent.data` may contain any JSON string, including an escaped NUL character. PostgreSQL `jsonb` decodes JSON strings into its text representation and rejects `\u0000` with SQLSTATE `22P05`. A valid session event therefore rolled back the whole append batch after a model round, leaving the client waiting even though the event serialized and replayed correctly in the other SessionPersistence providers.

## Decision

Migration 4 converts `harness.conversation_events.event` from `jsonb` to PostgreSQL `json`, and the Gateway appender casts serialized events to `json`. PostgreSQL continues to validate each complete event as JSON, while its textual JSON representation preserves escaped NUL characters for the Node PostgreSQL driver to parse back into the original JavaScript value.

The migration removes `conversation_events_tool_call`. That expression index parsed arbitrary event payloads through PostgreSQL text conversion and could reproduce the same rejection. Queryable ordering, type, time, search text, ACL, and participant facts remain in dedicated columns and projection tables; runtime code does not query tool call ids through the removed index. This decision supersedes only the JSONB event-column choice in the [PostgreSQL Gateway baseline](../architecture/2026-08-14-postgresql-jsonb-gateway-baseline.md).

## Alternatives considered

**Replace NUL characters before persistence.** Rejected because the stored event would differ from the session log accepted by other providers, so replay and append checksums would no longer describe the original event.

**Add a custom sentinel encoding inside event payloads.** Rejected because every reader and future data tool would need a Gateway-specific codec for otherwise valid JSON.

**Store the event as unconstrained text.** Rejected because PostgreSQL `json` preserves the required string domain while retaining database JSON validation and the driver's normal JSON parser.

**Keep JSONB and extract only selected fields before encoding.** Rejected because persistence would own an evolving transformation for extension-defined event data, and a missed string would restore the same failure.

## Consequences

Complete shared-project events round-trip with their original JSON values, including strings containing NUL. Event payloads are not available for arbitrary JSONB expression indexes; durable queries use the fixed envelope columns and explicit projections instead. PostgreSQL integration coverage appends, reads, and idempotently retries an event containing a real NUL character, and production startup applies migration 4 before accepting traffic.
