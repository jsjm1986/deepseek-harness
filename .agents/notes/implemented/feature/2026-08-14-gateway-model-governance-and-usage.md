# Agent Note: Gateway model governance and usage accounting

Status: implemented

English | [中文](2026-08-14-gateway-model-governance-and-usage.zh.md)

## Problem

The portal gateway isolated users and directories but did not own model entitlement, price history, company-versus-personal cost attribution, or monthly usage visibility. Filtering only the browser model picker would be bypassable by stored selections, direct RPC calls, compaction, title generation, and plugin-originated `llm/stream` calls. Sending usage directly from a provider response to a central database would also lose records on gateway or network interruption and could make an advisory accounting failure break a successful model call.

## Decision

The gateway owns one PostgreSQL-backed governance plane keyed by exact `(provider, model)` routes. The catalog stores enabled state, role defaults for `admin` and ordinary members, per-user allow/deny/inherit exceptions, append-only effective-time prices for input/output/cache token classes, and role/user/project monthly token and company-cost quotas. Per-user quota fields distinguish inherit, unlimited, and a non-negative custom value. A project either inherits both ordinary-member limits or stores an explicit pair whose individual limits may be unlimited or non-negative. Natural months are computed in the configurable IANA `HGW_USAGE_TIME_ZONE` (default `Asia/Shanghai`). User and project quotas create durable idempotent 80% and 100% alerts; they never block execution.

Policy is projected atomically to each personal or shared project runtime as mode-`0600` `$DSH_HOME/model-governance.json`, including a stable subject-bound bearer credential for the loopback intake. Personal policy uses the account role plus any user exception; project policy uses the ordinary-member role and has no per-user exception because one process is shared. A policy edit rewrites the projection, and the running plugin applies a validated replacement without restart under the [live policy reload decision](2026-08-14-gateway-model-governance-live-policy-reload.md). The mandatory tree-external `dsh-model-governance` bundle is mounted independently of the optional directory guard, so `HGW_GUARD_PATCH=off` cannot disable model authorization or accounting. Its built JavaScript has no non-Node runtime imports: it publishes the typed `ctx.modelAccess` face as a plain object instead of loading another Cordis copy from its real filesystem location.

Authorization has three layers over the same `@deepseek-ai/dsh-model-access` Service Definition: `apiproxy` filters forbidden catalog rows, rejects forbidden selection, and refuses a prompt whose current route is forbidden; the instance plugin's `llm/stream` listener remains the final pre-adapter boundary for chat, title, compaction, and direct calls. The listener also rejects an explicit `sessionId` that disagrees with the process-local initiating Agent and fills a missing id from that initiator.

DeepSeek and pi-ai adapters attach only the non-secret credential source label to usage chunks. The governance plugin maps managed-file/project/request sources to personal cost, launch-environment sources to company cost, and unknown sources conservatively to company cost. The intake recomputes and validates this class rather than trusting the submitted class. API keys and prompt/response content never enter the policy, outbox, intake, or ledger.

Every terminal call outcome is first committed as a UUID-named JSON file by same-directory rename in a per-runtime outbox. A background pump posts files to the bearer-authenticated loopback intake and removes them only after success. PostgreSQL scopes UUID idempotency to the organization, so retries do not duplicate user or project usage. Price selection uses the event occurrence time; personal-credential calls retain estimated cost but contribute zero company cost. Missing provider usage becomes an explicit `missing-usage` outcome rather than fabricated token counts. Denials are also written to the gateway audit log.

The admin SPA exposes Models and Usage pages for catalog, role defaults, user exceptions, prices, user quotas, and natural-month summaries. Project detail reuses the same usage presentation for project totals and requires an explicit inherit-versus-independent quota choice before saving. Authenticated users read only their personal summary through `/account/api/usage`; project usage remains an admin view because one total is shared by every member. A client plugin contributes durable personal threshold alerts to `shell.overlay` without recomputing quota policy in the browser.

## Testing

Gateway tests cover policy precedence and global disable, project member policy, price calculation and personal-cost exclusion, user/project UUID deduplication, threshold idempotency, malformed intake rejection, time-zone month boundaries, user quota inherit/unlimited/custom semantics, project inherit-or-explicit semantics, bearer intake authentication and denial audit, subject-bound policy projection/token reuse, and mandatory governance when directory guard is disabled. Plugin tests cover fail-closed policy parsing, final-stream denial and usage capture, attribution conflict, and outbox retry/removal. Host tests cover catalog filtering plus selection/prompt refusal. Adapter tests pin the non-secret source label. Admin tests cover project month selection, usage rendering, and explicit quota-source submission. Type builds cover host, client, admin UI, model-access, the alert bundle, and the tree-external plugin.

## Alternatives considered

**Enforce only in the browser model picker.** Rejected because the browser is an affordance, not an authorization boundary; stale sessions, direct RPCs, and non-chat model calls would bypass it.

**Put every check only in `apiproxy`.** Rejected because title generation, compaction, and plugin/direct `llm/stream` calls need the same final boundary. `apiproxy` remains useful for early, user-visible refusals, while the stream listener is authoritative.

**Send usage synchronously without an outbox.** Rejected because an intake outage would either lose accounting or turn a successful model call into a failure. The local commit plus idempotent intake separates model outcome from accounting availability.

**Trust the client-supplied credential class.** Rejected because it would let an instance suppress company cost. The gateway derives the class again from the non-secret source label and rejects disagreement.

**Bundle a second Cordis copy with the tree-external plugin.** Rejected because service identity and isolation must use the host's Cordis instance. The plugin has zero external runtime imports and publishes the structural service face through the host context.

**Make quotas hard limits.** Rejected for this release because delayed outbox delivery and concurrent calls make a central hard stop surprising and race-prone. Quotas are explicitly advisory at 80% and 100%.

## Consequences

The deployment gains one enforceable model policy across all model call paths, historical price-correct monthly accounting for personal and shared project runtimes, conservative company-cost attribution, durable alerts, and admin/user visibility without storing model content or secrets. Quota enforcement remains advisory, unknown credential sources count as company cost, project policy deliberately cannot vary by participant inside one shared process, and the gateway depends on a mandatory built tree-external plugin plus a private loopback intake port. Production packaging must copy that plugin with its checked-in `lib/` artifacts; disabling directory confinement does not disable governance.
