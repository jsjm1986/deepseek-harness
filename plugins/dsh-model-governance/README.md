# dsh-model-governance

English | [中文](README.zh.md)

Tree-external per-instance policy plugin. It loads the gateway-generated `model-governance.json`, publishes a plain `ctx.modelAccess` service, enforces every `llm/stream` call before adapter dispatch, and commits usage to a crash-safe local outbox before reporting it to the bearer-authenticated loopback gateway intake. A running instance watches the policy's parent directory, so the Gateway's atomic replacement is applied without restarting the instance. Missing or malformed policy fails activation at boot; an invalid live replacement enters fail-closed mode until the next valid policy arrives.

The emitted JavaScript has no external runtime imports beyond Node built-ins, so a copied production plugin does not load a second Cordis instance or depend on workspace resolution. `@deepseek-ai/dsh-llm`, `dsh-agent`, and `dsh-model-access` are compile-time contracts supplied by the host runtime.

Policy and usage records contain no API key or prompt/response content. Credential source is a non-secret layer id used only to distinguish company and personal cost. UUID-named outbox files are committed by same-directory rename and removed only after a successful intake response; intake deduplication makes retries safe.

## Model Experience

A forbidden route terminates the stream with `MODEL_FORBIDDEN` before provider dispatch. An initiating Agent whose identity disagrees with an explicit `sessionId` terminates with `MODEL_ATTRIBUTION_CONFLICT`. The plugin adds no prompt content.

#### KV Cache effect

No direct effect.

## Live policy reload

The Gateway writes a complete policy to a temporary file and renames it into place. The plugin watches the parent directory, replaces the immutable authorization snapshot for later requests, and updates the usage intake destination from the same validated document. An `llm/stream` call keeps the snapshot it read at admission, so a policy update cannot change an already-running stream halfway through. A malformed or missing live document denies new model requests and retains the last valid usage-intake destination until a valid document is published.

## Known Limitations and Deferred Work

- **Advisory quotas** — 80%/100% quota crossings notify but never reject an otherwise authorized call.
