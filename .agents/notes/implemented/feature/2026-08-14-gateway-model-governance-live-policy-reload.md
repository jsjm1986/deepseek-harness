# Agent Note: Live model-governance policy reload

Status: implemented

English | [中文](2026-08-14-gateway-model-governance-live-policy-reload.zh.md)

## Problem

The Gateway projects each user's validated model policy into `$DSH_HOME/model-governance.json`. Previously the tree-external `dsh-model-governance` plugin read that file only during activation, so every policy edit stopped and restarted a live user instance, interrupting active sessions and causing a global model edit to restart users serially.

## Decision

The plugin watches the policy file's parent directory with a Node built-in watcher so atomic rename replacement remains observable without adding a runtime dependency. A serialized reloader validates the complete document, replaces one immutable `ctx.modelAccess` snapshot, and updates the usage outbox endpoint only after validation succeeds. A request reads one snapshot at `llm/stream` admission; later policy edits do not change an already-running stream. A missing or malformed live document puts new model requests into fail-closed denial while the last valid intake destination remains usable for queued usage records. The watcher and outbox drain through one Cordis effect, and watcher setup reconciles once after registration to close the initial race.

## Alternatives considered

**Keep restarting the user instance.** Rejected for model governance because policy authorization does not require a process or kernel namespace change, and restarts interrupt live sessions. Directory grants retain restart semantics separately because Linux systemd mount namespaces require a new unit to change the authoritative filesystem boundary.

**Keep the old valid policy after a malformed live replacement.** Rejected because silently continuing to authorize against a stale policy would hide a failed administrative change. Fail-closed preserves the authorization guarantee while allowing recovery on the next valid document.

**Add a file-watcher dependency.** Rejected because the tree-external plugin is intentionally deployable with only Node built-ins; watching the parent directory with `node:fs` handles the Gateway's atomic rename protocol without another runtime package.

## Consequences

Model policy and intake-token changes no longer require restarting a running DSH instance. A malformed live policy temporarily denies new model requests and emits a diagnostic until a valid file is published. The policy file remains the authoritative cross-process handoff, and the Gateway does not need a second control channel. The watcher is process-local and is recreated when the plugin itself is unloaded or the instance restarts.

## Testing

The plugin tests cover valid live replacement, fail-closed invalid replacement followed by recovery, watcher setup races, unrelated directory events, watcher errors, and disposal. Type checking and production build pass for the standalone plugin.
