# @deepseek-ai/dsh-gateway-runtime

English | [中文](README.zh.md)

Authenticated request context and private loopback transport for a Harness runtime launched by the Gateway. A launch credential binds the process to one organization, one personal or project runtime identity, and the Gateway key that verifies short-lived browser principals.

## Runtime contract

- The launch credential is read from exactly one of `DSH_GATEWAY_CREDENTIAL_FD` or `DSH_GATEWAY_CREDENTIAL_FILE`. It contains a loopback-only Gateway origin, runtime bearer token, runtime generation, organization, and Ed25519 public key.
- The `connection/request` listener requires `x-dsh-gateway-principal`, verifies its signature, lifetime, organization, scope, runtime identity, and generation, then exposes it through request-local `current()` / `requireCurrent()` access.
- `request()` accepts only absolute `/internal/runtime/` paths on the credential's loopback origin, adds the private bearer token, and forwards a browser principal only when the caller explicitly requests it.
- Credentials and principal assertions fail closed at their parsing and request boundaries. The runtime bearer token is never exposed through the public service fields.

## Model Experience

None, as this package authenticates Host operations and contributes no model input, tools, or transcript rows.

#### KV Cache effect

The package does not assemble model requests or alter an already-reusable prefix.

## Known Limitations and Deferred Work

- **Gateway-launched runtimes only** — loading the plugin without a valid private launch credential fails startup.
- **Request-local principals** — `current()` is unavailable outside an authenticated HTTP or WebSocket operation; Consumers that outlive dispatch must capture the verified principal or a derived authority.
- **Short-lived assertions** — the shipped Gateway defaults `HGW_PRINCIPAL_ASSERTION_TTL_MS` to 30 seconds. A verified principal freezes its project scope mode until `expiresAt`; Session Consumers must use `ctx.collaboration` for current membership and ACL decisions. Host and Typert streams close at expiry, while this package never refreshes an assertion inside an existing connection.
