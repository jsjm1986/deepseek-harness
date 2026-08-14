# Lossless history wire pagination

## Goal

Opening a large session must not block on transferring every raw streaming event selected by the message-count page. The optimization must preserve the complete logical `SessionEvent` stream, every tool presentation view, projection baseline, message boundary, sequence number, timestamp, token fragment, usage record, retry, and interruption fact.

## Current failure

`session.history` selects at most 50 append-origin messages, but returns every raw event in the selected contiguous range. A short conversation with long model streams can therefore contain fewer than 50 messages while carrying tens of thousands of `assistant/chunk` events. The measured session returned 28,187 events and 6.19 MB of JSON; 27,849 entries were chunks. The local handler completed in about 84 ms, while the public Cloudflare path took 17.8–48.5 seconds.

## Design

The authoritative log, persistence formats, `SessionsApi`, `SubagentsApi`, and client conversation assembly continue to use expanded `HistoryEntry[]`. Only the Fetch carrier uses a packed physical representation.

Before serializing a successful ordinary-session or subagent history response, the carrier replaces the logical `events` array with a physical `records` array and applies the existing lossless chunk-run codec to consecutive eligible `assistant/chunk` delta events. Ordinary records retain `{ event, view? }`; a packed record is `{ chunks: ChunkRow }`. Non-chunk events, unknown or extended chunk structures, and tool presentation views remain ordinary history entries. A packed run contains every member fragment, sequence number anchor, timestamp anchor, and timestamp gap required to reconstruct the exact original events.

The client wire parser validates each packed run and expands it before returning from `AbstractApiClient`. Runtime consumers therefore continue to receive the same `HistoryEntry[]` type and do not learn the physical representation.

### Adaptive page size

The existing `maxMessages` remains an upper bound. The Fetch carrier also applies a configurable uncompressed JSON target to the complete server response, including the RPC envelope, projections, presentation views, and metadata.

When the packed response exceeds the target, the carrier selects progressively smaller suffixes only at append-origin message-group boundaries. It never cuts inside a message's cited source events, a completed chunk stream, an in-flight tail, or a compaction replacement group. A reduced page reports `hasMore: true`; the next request continues with the first reconstructed event sequence exactly as today.

At least the newest complete message group and any in-flight tail are returned even when that indivisible value exceeds the target. A page without append-origin messages remains whole. The target is therefore a latency target, not a truncation limit.

The browser connection plugin owns `historyPageTargetBytes` and supplies its default of 128 KiB to the Fetch carrier. Ordinary short histories remain at their current message count. On the measured session, this target selects the newest five messages and produces about 100 KiB of uncompressed packed JSON, approximately 17 KiB under Brotli.

## Data flow

1. `session.history` or `subagent.history` produces the existing logical page with complete `HistoryEntry[]`.
2. The Fetch handler packs eligible chunk runs and measures the complete serialized response in UTF-8 bytes.
3. If required, it selects the largest complete-message suffix that fits the target, or the smallest indivisible suffix when none fits.
4. HTTP compression and the external proxy operate on the reduced physical response.
5. The client Zod parser validates and expands packed runs into exact `HistoryEntry[]`.
6. `Session.installWindow`, `ConversationNodeAssembler`, Chat, Trajectory, and load-older handling receive their existing input.

## Failure behavior

Packing uses an exact field allowlist. An event with an unknown field or future chunk variant passes through unchanged instead of losing data.

A malformed packed run is rejected at the wire parser before runtime state changes. Business-error responses are not packed. A physical page reduction changes `hasMore` to true but does not alter projections for the unchanged tail sequence.

## Compatibility

No session-format version or persistence migration is required because the durable log remains unchanged. The public in-process API remains expanded. Client and host ship together and the Fetch protocol has no independent version, so the carrier may replace the physical history array while retaining the logical `IApiClient` result.

The change stays concentrated in the existing session chunk codec, API Fetch carrier, and browser connection configuration. It does not modify the agent loop or conversation business definitions.

## Verification

Focused codec and carrier tests prove packed-to-expanded event equality, including Unicode fragments, exact sequence and time reconstruction, tool views, projections, unknown chunk pass-through, malformed-run rejection, and both ordinary-session and subagent history.

Page tests cover complete-response UTF-8 measurement, a response exactly at the target, one byte below it, multibyte content, compaction and chunk source groups, an oversized indivisible message, an event-only page, `hasMore`, and adjacent-page sequence continuity.

The assembled Web history scenario proves that initial open and load-older render the same Chat, Trajectory, tool, timing, usage, retry, and interruption output after transport expansion. A deterministic high-chunk fixture asserts that the initial physical response does not grow with one JSON envelope per chunk.

## Rejected alternatives

**Drop completed chunks and keep only `assistant/message`.** This reduces more bytes but removes token boundaries and per-chunk timestamps used by diagnostics and first-token timing.

**Always request five messages.** This is simple but changes ordinary short-session behavior and does not adapt to one unusually large message.

**Rely only on gzip or Brotli.** The public path already compresses responses and still spends tens of seconds transferring the oversized page.

**Stream the existing JSON incrementally.** This can show partial progress but retains the total byte cost and complicates atomic window installation, cancellation, and page continuity.
