# Agent Note: Keep the absent composer document snapshot stable

Status: implemented

English | [中文](2026-08-14-stable-absent-composer-document-snapshot.zh.md)

## Problem

The session-maybe composer must expose a documents observable even when no session is selected, so its hook order stays identical across session transitions. The empty source returned a new array from `getSnapshot()` on every read. React's `useSyncExternalStore` treated those reads as continuous changes, reached its maximum update depth, and the slot boundary removed the Composer from the page.

## Decision

`ui-conversation` stores one module-level empty documents array and makes the absent source return that same reference. Real sessions continue to use their per-session document stores. The inject test asserts that two absent-source reads return the same array identity.

## Alternatives considered

**Return an inline empty array.** Rejected because a new reference violates the snapshot-store contract even though the value is semantically empty.

**Omit the documents hook without a session.** Rejected because the composer would then change its hook sequence when a session opens, which is less reliable than keeping one inert observable source.

**Hide the failure in a selector equality function.** Rejected because the source itself would still violate `useSyncExternalStore` and other consumers could observe the unstable snapshot.

## Consequences

The Composer remains mounted while the current session is absent and across session selection changes. The shared empty array is never mutated; session-scoped document updates remain isolated to their owning store.

## Testing

The conversation inject tests cover stable identity for the absent document source. The focused conversation test set passes, and the rebuilt production Web bundle was opened against the running local instance with an existing history session: the Composer input is present and the console has no React error 185.
