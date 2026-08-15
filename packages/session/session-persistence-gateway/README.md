# @deepseek-ai/dsh-session-persistence-gateway

English | [中文](README.zh.md)

Gateway PostgreSQL `SessionPersistence` provider for shared project runtimes. The provider keeps the standard `PersistenceCoordinator` lifecycle and moves stored headers/events, revisions, idempotent append batches, and crash-repair commits through the authenticated internal Gateway API.

## Persistence contract

- Project runtime composition disables `session-persistence-jsonl` and mounts this provider. Personal runtimes retain their ordinary persistence provider.
- New root creation captures the request principal and the `project` or `private` visibility supplied by `dsh-collaboration`; the first materializing append sends both with the session header. Descendants are registered against the stored root by the Gateway repository.
- Append and repair batch ids are deterministic hashes of operation kind, session id, and payload. Gateway/PostgreSQL deduplication makes a retry idempotent without suppressing a different batch.
- Every response is validated before it enters the Session store. The provider supports full load, non-mutating inspect, revision checks, tail reads, snapshots, batched append, flush, and recovery through the shared coordinator.
- `locate()` returns `undefined` and `supportsRawArtifacts` is false because PostgreSQL owns no independent local transcript file.

## Configuration

- `preparedSessionCacheSize` — positive number of cold preparations retained by the coordinator; default `5`.
- `writeBatchMaxDelayMs` — positive fixed batching window; default `200`, bounded by the shared maximum timer delay.
- `requestTimeoutMs` — positive deadline for one internal Gateway request; default `30000`.

## Model Experience

### Resumed shared conversation history

#### What the model sees

The provider contributes no live prompt text. A loaded project conversation reconstructs the same durable `SessionEvent` history and crash-repair results as other persistence providers, including participant attribution already stored in the log.

#### Token effect

Zero live-request tokens beyond the retained history and any shared persistence recovery results.

#### KV Cache effect

The provider does not rewrite valid history. Resume can reuse provider cache when the reconstructed prefix, current envelope, and route match; newly committed events append to the suffix.

## Known Limitations and Deferred Work

- **Gateway dependency** — cold reads, writes, flushes, and recovery require the loopback Gateway and PostgreSQL; there is no local fallback.
- **No raw artifact path** — callers cannot open or export a per-session file through `locate()`.
- **Bounded request lifetime** — an internal call exceeding `requestTimeoutMs` fails; the coordinator retains its ordinary retry/recovery responsibility rather than treating a timed-out write as absent.
