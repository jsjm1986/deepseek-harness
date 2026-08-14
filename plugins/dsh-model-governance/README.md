# dsh-model-governance

English | [中文](README.zh.md)

Tree-external per-instance policy plugin. It loads the gateway-generated `model-governance.json`, publishes a plain `ctx.modelAccess` service, enforces every `llm/stream` call before adapter dispatch, and commits usage to a crash-safe local outbox before reporting it to the bearer-authenticated loopback gateway intake. Missing or malformed policy fails activation; there is no allow-all fallback.

The emitted JavaScript has no external runtime imports beyond Node built-ins, so a copied production plugin does not load a second Cordis instance or depend on workspace resolution. `@deepseek-ai/dsh-llm`, `dsh-agent`, and `dsh-model-access` are compile-time contracts supplied by the host runtime.

Policy and usage records contain no API key or prompt/response content. Credential source is a non-secret layer id used only to distinguish company and personal cost. UUID-named outbox files are committed by same-directory rename and removed only after a successful intake response; intake deduplication makes retries safe.

## Model Experience

A forbidden route terminates the stream with `MODEL_FORBIDDEN` before provider dispatch. An initiating Agent whose identity disagrees with an explicit `sessionId` terminates with `MODEL_ATTRIBUTION_CONFLICT`. The plugin adds no prompt content.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- **Restart-applied policy** — the gateway rewrites the policy and restarts only a running affected instance; there is no live policy subscription.
- **Advisory quotas** — 80%/100% quota crossings notify but never reject an otherwise authorized call.
