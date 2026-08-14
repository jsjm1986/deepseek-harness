# Lossless History Wire Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make large Web session histories load through lossless packed responses and complete-message adaptive pages without changing the logical event stream or rendered history.

**Architecture:** `SessionsApi` and `SubagentsApi` continue to return expanded `HistoryEntry[]`; the Fetch carrier alone converts eligible chunk runs to physical records, reduces an oversized response at safe message-group boundaries, and validates/expands records before `AbstractApiClient` returns. The browser connection plugin supplies the response-size target, while persistence and Conversation assembly remain unchanged.

**Tech Stack:** TypeScript 6, Zod 4, Cordis/Schemastery plugin configuration, Vitest, Playwright Web snapshots, existing `@deepseek-ai/dsh-session` chunk-run codec.

## Global Constraints

- Preserve every logical event, fragment boundary, `seq`, timestamp, usage record, retry, interruption, tool view, and projection value.
- Keep the durable session format and `SESSION_FORMAT_VERSION` unchanged.
- Keep direct `SessionsApi` and `SubagentsApi` results expanded; only the Fetch carrier uses `records`.
- Measure the complete `server-response` JSON in UTF-8 bytes, including envelope, projections, views, and metadata.
- Reduce pages only at append-origin message-group boundaries and always return at least one indivisible group or an event-only page.
- Use `historyPageTargetBytes` with a 131,072-byte default; treat it as a target because one indivisible group may exceed it.
- Unknown or extended chunk event fields pass through as ordinary events; malformed packed records fail before runtime state changes.
- Do not modify unrelated dirty workspace files and do not create a Git commit unless the user separately requests one.

---

### Task 1: Expose a browser-safe lossless chunk-row decoder

**Files:**
- Modify: `packages/core/session/src/chunk-rows.ts`
- Modify: `packages/core/session/package.json`
- Modify: `packages/core/session/tests/chunk-rows.spec.ts`

**Interfaces:**
- Produces: `isChunkRow(value: unknown): value is ChunkRow`
- Produces: `decodeChunkRow(value: unknown): SessionEvent[]`
- Produces: browser-safe package export `@deepseek-ai/dsh-session/chunk-rows`
- Preserves: `packChunkRuns()` and `decodeStorageRecord()` behavior

- [x] **Step 1: Add failing decoder/export tests**

Extend `chunk-rows.spec.ts` with a direct packed-row decoder assertion and a non-row rejection:

```ts
const packed = packChunkRuns(textRun(0, ['你', '好', '🙂']))
const row = packed[0]
expect(isChunkRow(row)).toBe(true)
expect(decodeChunkRow(JSON.parse(JSON.stringify(row)))).toStrictEqual(textRun(0, ['你', '好', '🙂']))
expect(() => decodeChunkRow({ type: 'assistant/chunk' })).toThrow(/packed chunk row/)
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/core/session/tests/chunk-rows.spec.ts
```

Expected: FAIL because `isChunkRow` and `decodeChunkRow` are not exported.

- [x] **Step 3: Implement the narrow codec face**

Refactor the existing tag check so storage and wire callers share one validator:

```ts
export function isChunkRow(value: unknown): value is ChunkRow {
  if (!isRecord(value)) return false
  return value.type === 'text-chunks'
    || value.type === 'reasoning-chunks'
    || value.type === 'tool-call-chunks'
}

export function decodeChunkRow(value: unknown): SessionEvent[] {
  if (!isChunkRow(value)) throw new Error('value is not a packed chunk row')
  return expandRow(validateRow(value, value.type))
}

export function decodeStorageRecord(value: unknown): SessionEvent[] {
  return isChunkRow(value) ? decodeChunkRow(value) : [value as SessionEvent]
}
```

Change runtime imports in `chunk-rows.ts` to browser-safe LLM subpaths and use a local exhaustive `assertNever` helper rather than importing the Node-facing LLM package root.

Add this package export:

```json
"./chunk-rows": {
  "types": "./lib/types/chunk-rows.d.ts",
  "default": "./lib/types/chunk-rows.js"
}
```

- [x] **Step 4: Run focused tests and package typecheck**

Run:

```bash
pnpm exec vitest run packages/core/session/tests/chunk-rows.spec.ts
pnpm exec tsc -p packages/core/session/tsconfig.json --noEmit
```

Expected: PASS.

### Task 2: Build the physical history-record codec and adaptive byte target

**Files:**
- Create: `packages/host/apiproxy/src/fetch/history-wire.ts`
- Create: `packages/host/apiproxy/tests/history-wire.spec.ts`

**Interfaces:**
- Consumes: `HistoryEntry[]`, `ChunkRow`, `packChunkRuns()`, `decodeChunkRow()`
- Produces: `DEFAULT_HISTORY_PAGE_TARGET_BYTES = 128 * 1024`
- Produces: `encodeHistoryServerResponse(rpcId, value, targetBytes): ServerResponse`
- Produces: `historyWireValueSchema: z.ZodType<Wire<HistoryValue>>`
- Physical record union: `HistoryEntry | { chunks: ChunkRow }`

- [x] **Step 1: Write failing pure wire-codec tests**

Create fixtures containing several append-origin message groups, Unicode delta runs, tool views, projections, a compaction replacement, an in-flight tail, and an event-only page. Assert:

```ts
const encoded = encodeHistoryServerResponse(RpcId('r1'), value, targetBytes)
const decoded = historyWireValueSchema.parse(encoded.result.ok ? encoded.result.value : undefined)
expect(decoded.events).toStrictEqual(expectedEntries)
expect(decoded.projections).toStrictEqual(value.projections)
```

Add exact byte-target cases using `new TextEncoder().encode(JSON.stringify(response)).byteLength`: exact fit keeps the larger page; one byte below selects the next complete-message suffix. Add an oversized single group that is returned whole with `hasMore: true`, an event-only page that remains whole, malformed `{ chunks: ... }` rejection, and unknown chunk-field pass-through.

- [x] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm exec vitest run packages/host/apiproxy/tests/history-wire.spec.ts
```

Expected: FAIL because `history-wire.ts` does not exist.

- [x] **Step 3: Implement physical records and exact reconstruction**

Define the internal transport records:

```ts
type HistoryWireRecord =
  | HistoryEntry
  | { chunks: ChunkRow }

interface HistoryWireValue {
  records: HistoryWireRecord[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
}
```

Pack logical entries by retaining views by event sequence and replacing only `ChunkRow` outputs:

```ts
function packEntries(entries: readonly HistoryEntry[]): HistoryWireRecord[] {
  const views = new Map(entries.flatMap(({ event, view }) => view === undefined ? [] : [[event.seq, view]]))
  return packChunkRuns(entries.map(entry => entry.event)).map(record =>
    isChunkRow(record)
      ? { chunks: record }
      : { event: record, ...(views.get(record.seq) === undefined ? {} : { view: views.get(record.seq) }) })
}
```

Build candidate cuts from append-origin `user/message` and `assistant/message` entries, using the minimum of the message sequence and its `sourceEventSeqs`. Encode the full candidate first; if it exceeds the target, test progressively larger suffixes from the newest group until the next group exceeds the target. Always return the one-group candidate when it alone exceeds the target. Set `hasMore` when the physical encoder omits any logical prefix.

Construct and measure the complete envelope for every candidate:

```ts
const body: ServerResponse = {
  type: 'server-response',
  rpcId,
  result: { ok: true, value: wireValue },
}
const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
```

Implement `historyWireValueSchema` as a Zod transform from `records` to expanded `events`; packed records call `decodeChunkRow()` and ordinary records retain their optional views.

- [x] **Step 4: Run pure codec tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/host/apiproxy/tests/history-wire.spec.ts
```

Expected: PASS.

### Task 3: Integrate the codec at the Fetch carrier boundary

**Files:**
- Modify: `packages/host/apiproxy/src/fetch/handler.ts`
- Modify: `packages/host/apiproxy/src/fetch/client.ts`
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts`
- Modify: `packages/host/apiproxy/src/api/subagents.schema.ts`
- Modify: `packages/host/apiproxy/tests/fetch-carrier.spec.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`

**Interfaces:**
- Consumes: `encodeHistoryServerResponse()` and `historyWireValueSchema`
- Produces: `toFetchHandler(api, { historyPageTargetBytes? })`
- Preserves: `IApiClient.sessions.history()` and `IApiClient.subagents.history()` return expanded logical values

- [x] **Step 1: Add failing carrier round-trip tests**

Make the scripted API return a high-chunk logical page with a tool view and projections. Call the handler directly and assert the JSON success value contains `records`, includes at least one `{ chunks: ... }`, and does not expose a logical `events` array.

Call the same handler through `InProcessApiClient` and assert:

```ts
expect(clientResponse.result).toEqual({
  ok: true,
  value: {
    events: originalEntries,
    hasMore: expectedHasMore,
    projections,
  },
})
```

Repeat the logical round trip for `subagent.history`. Add schema tests proving malformed packed records reject and ordinary unknown event types still pass.

- [x] **Step 2: Run carrier/schema tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  packages/host/apiproxy/tests/fetch-carrier.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts
```

Expected: FAIL because the handler still emits `events` and client schemas do not decode records.

- [x] **Step 3: Wire server encoding and client decoding**

Extend `toFetchHandler`:

```ts
export interface FetchHandlerOptions {
  historyPageTargetBytes?: number
}

export function toFetchHandler(api: ApiProxy, options: FetchHandlerOptions = {}): { fetch: typeof fetch }
```

Resolve `historyPageTargetBytes` once when the handler is constructed. In `handleUnary`, route successful `session.history` and `subagent.history` results through `encodeHistoryServerResponse`; business errors and every other method retain `fullResponse`.

Replace the client value-schema rows for both history methods with `historyWireValueSchema`. Remove the former duplicated logical history value schemas from session/subagent schema modules while retaining request schemas and reusable event/view schemas.

- [x] **Step 4: Run codec, carrier, and schema tests**

Run:

```bash
pnpm exec vitest run \
  packages/core/session/tests/chunk-rows.spec.ts \
  packages/host/apiproxy/tests/history-wire.spec.ts \
  packages/host/apiproxy/tests/fetch-carrier.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts
```

Expected: PASS.

### Task 4: Make the page target deployment-configurable

**Files:**
- Modify: `packages/client/connection/src/index.ts`
- Modify: `packages/client/connection/tests/node-half.host.spec.ts`
- Modify: `packages/client/connection/README.md`
- Modify: `packages/client/connection/README.zh.md`
- Regenerate: `packages/client/connection/README.i18n.yaml`
- Regenerate: `docs/config-catalog.md`
- Regenerate: `docs/config-catalog.zh.md`

**Interfaces:**
- Consumes: `DEFAULT_HISTORY_PAGE_TARGET_BYTES`
- Produces: `ConnectionConfig.historyPageTargetBytes?: number`
- Passes: `{ historyPageTargetBytes }` to `toFetchHandler`

- [x] **Step 1: Add a failing host-plugin integration test**

Allow the test mount helper to accept an API and full `ConnectionConfig`. Mount with a deliberately small `historyPageTargetBytes`, issue a trusted `session.history` POST through the registered `/api` route, and assert the physical response selects fewer complete message groups and reports `hasMore: true`.

- [x] **Step 2: Run the connection test and verify RED**

Run:

```bash
pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts
```

Expected: FAIL because the configuration field is absent or ignored.

- [x] **Step 3: Add and propagate the validated configuration**

Extend the interface and schema:

```ts
export interface ConnectionConfig {
  trustedHosts?: string[]
  maxRequestBodyBytes?: number
  historyPageTargetBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  historyPageTargetBytes: z.natural().min(1).default(DEFAULT_HISTORY_PAGE_TARGET_BYTES),
})
```

Resolve the value once in `apply()` and pass it to `toFetchHandler(apiProxy, { historyPageTargetBytes })`.

- [x] **Step 4: Document and regenerate configuration references**

Document that the target measures the complete uncompressed history RPC response and may be exceeded by one indivisible message group. Update both README languages minimally, then run:

```bash
pnpm run verify-translation-pairing --write packages/client/connection/README.md
pnpm run gen-config-catalog
```

- [x] **Step 5: Run connection and config tests**

Run:

```bash
pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts
pnpm run verify-config-catalog
```

Expected: PASS.

### Task 5: Prove assembled-Web fidelity and record the architecture decision

**Files:**
- Create: `apps/web/tests/lossless-history-wire.e2e.ts`
- Create: `apps/web/tests/snapshots/lossless-history-wire/initial.expected.md`
- Create: `apps/web/tests/snapshots/lossless-history-wire/expanded.expected.md`
- Modify: `packages/host/apiproxy/README.md`
- Modify: `packages/host/apiproxy/README.zh.md`
- Regenerate: `packages/host/apiproxy/README.i18n.yaml`
- Create: `.agents/notes/implemented/architecture/2026-08-14-lossless-history-wire-pagination.md`
- Create: `.agents/notes/implemented/architecture/2026-08-14-lossless-history-wire-pagination.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-14-lossless-history-wire-pagination.i18n.yaml`

**Interfaces:**
- Consumes: real Loader/Web composition and the production Fetch carrier
- Proves: identical Chat/Trajectory/tool/timing output after expansion and contiguous load-older behavior

- [x] **Step 1: Add the keyless assembled-Web scenario**

Generate a deterministic persisted session with several complete messages, thousands of Unicode text/reasoning delta events, usage chunks, a tool call/result view, and an interrupted final step. Open the session through the real Web scaffold.

Before loading older history, assert the newest settled and interrupted content, whole-session projection stats, first-token timing, usage, and tool presentation. Capture `initial.expected.md`. Repeatedly activate “Load earlier” until the oldest marker appears, then assert all message markers exactly once, unchanged stats/timing/tool output, and capture `expanded.expected.md`.

- [x] **Step 2: Run the assembled Web acceptance test**

Run:

```bash
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/lossless-history-wire.e2e.ts
```

Expected: PASS. Tasks 1–4 already carry the failing unit and carrier tests that establish the TDD red phase; this scenario verifies the assembled product path.

- [x] **Step 3: Document the shipped package behavior**

Update the API Proxy README pair to state that direct APIs remain expanded while the Fetch carrier losslessly packs and byte-targets history responses. Re-record the pair:

```bash
pnpm run verify-translation-pairing --write packages/host/apiproxy/README.md
```

- [x] **Step 4: Add the implemented Agent Note**

Record the measured problem, the physical/logical representation split, complete-envelope byte targeting, safe message-group cuts, oversized-group progress rule, alternatives rejected, verification, and consequences. Use present tense and the required `Problem`, `Decision`, `Alternatives considered`, and `Consequences` sections, then record the bilingual sidecar:

```bash
pnpm run verify-translation-pairing --write \
  .agents/notes/implemented/architecture/2026-08-14-lossless-history-wire-pagination.md
```

- [x] **Step 5: Run the assembled test and documentation gates**

Run:

```bash
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/lossless-history-wire.e2e.ts
pnpm run doc-sync
```

Expected: PASS.

### Task 6: Cross-package verification and live regression measurement

**Files:**
- Verify only; no planned source additions

**Interfaces:**
- Verifies: host/client compiler faces, browser bundle, focused behavior, generated docs, and the reported public-session regression

- [x] **Step 1: Run all focused unit and integration tests**

Run:

```bash
pnpm exec vitest run \
  packages/core/session/tests/chunk-rows.spec.ts \
  packages/host/apiproxy/tests/history-wire.spec.ts \
  packages/host/apiproxy/tests/fetch-carrier.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts \
  packages/client/connection/tests/node-half.host.spec.ts
```

- [x] **Step 2: Run compiler, lint, build, and documentation checks**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run doc-sync
git diff --check
```

- [x] **Step 3: Restart the local Web source process after confirming no active turn**

Stop the existing `dsh web --trusted-host harness.maycran.com` process, start the same command from the updated workspace, and confirm port 3080 is healthy before measuring. Do not start a duplicate process.

- [x] **Step 4: Measure the exact reported session locally and through the public URL**

POST `session.history` for `session-004c886f-73b2-4e61-8926-110f4df4726d` with `maxMessages: 50`. Record:

- HTTP status and total time;
- physical response bytes and record count;
- packed chunk-run count;
- client-expanded event count;
- equality of the expanded entries against the direct logical API result;
- local and `https://harness.maycran.com` timings.

Acceptance: the initial physical response contains the newest complete groups, reports `hasMore: true`, remains near the configured 131,072-byte target unless one indivisible group exceeds it, and expands to the exact original events for that page.

- [x] **Step 5: Inspect the final diff**

Confirm only intended source, test, generated documentation, spec, plan, and Agent Note files changed. Report the checks actually run and any pre-existing dirty files separately; do not commit.
