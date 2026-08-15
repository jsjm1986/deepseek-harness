# harness-gateway

English | [中文](README.zh.md)

The public-facing portal gateway for DeepSeek Harness: PostgreSQL-backed login/session handling, user/project/directory grants, HTTP+WS reverse proxy (rewriting Host/Origin to the instance loopback address), per-user dsh instance lifecycle, the `/admin` SPA plus `/admin/api` JSON, model governance, usage accounting, and auditing. Design and staged plan: [design doc](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md), [Phase 1 plan](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md), [project-centric admin](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md).

## Toolchain

- **Node 25** (`.nvmrc`; the dsh repository's engines `^22.19 || >=24` accept it). `better-sqlite3` and `argon2` are native modules whose ABI binds to the Node major that installed them — after switching Node, run `npm rebuild better-sqlite3 argon2`, otherwise they fail with a `NODE_MODULE_VERSION` mismatch.
- Commands: `npm run dev` (tsx entry), `npm test` (vitest), `npm run typecheck`.

## Configuration (environment variables, see src/config.ts)

| Variable | Default | Meaning |
|---|---|---|
| `HGW_PORT` | 8899 | Gateway listen port |
| `HGW_DATABASE_URL` | (required unless file is set) | PostgreSQL connection URL; prefer the file form in production |
| `HGW_DATABASE_URL_FILE` | (required unless URL is set) | Mode-`0600` file containing the PostgreSQL connection URL |
| `HGW_ORGANIZATION_SLUG` | `default` | Existing active PostgreSQL organization selected by this process |
| `HGW_COMPUTE_NODE_NAME` | `local` | Existing active compute node owning mounts, ports, and instance state |
| `HGW_INTAKE_PORT` | `HGW_PORT + 1` | Loopback-only, bearer-authenticated usage intake port |
| `HGW_USAGE_TIME_ZONE` | `Asia/Shanghai` | IANA time zone defining natural-month usage boundaries |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | Comma-separated public Origin allowlist (CSRF check; https marks cookies Secure) |
| `HGW_USERS_ROOT` | `~/harness-users` | Users root (production `/srv/harness/users`) |
| `HGW_DSH_COMMAND` | source entry `apps/cli/src/bin.ts web --port {port}` | Instance launch command; production points at the pinned npm `dsh` bin |
| `HGW_DSH_REPO_ROOT` | repo root | Resolves the source-run entry |
| `HGW_INSTANCE_PORT_BASE` | 42000 | Instance port allocation base |
| `HGW_IDLE_TIMEOUT_MS` | 30 min | Instance idle-sleep threshold |
| `HGW_READINESS_TIMEOUT_MS` | 30 s | Instance readiness wait ceiling |
| `HGW_LAUNCHER` | `local` | Instance launch driver: `local` (macOS dev subprocess) / `systemd` (Linux production per-user units) |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | Unit directory the systemd driver writes per-user unit files into |
| `HGW_GUARD_PATCH` | `<repo>/plugins/dsh-directory-guard/cordis.patch.yml` | directory-guard bundle patch mounted into every instance; `off` disables |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<repo>/plugins/dsh-model-governance` | Tree-external per-instance authorization and usage plugin linked into each profile |
| `HGW_DEFAULT_ENV_FILE` | (empty) | Company default credentials copied to each instance's `$DSH_HOME/.env` on start |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | Per-instance systemd resource limits |
| `HGW_GATEWAY_DIR` | gateway root | Directory masked from instances (`InaccessiblePaths`) |

Production install, cutover, and acceptance live in [deploy/README.md](deploy/README.md).

## Admin console and project grants

`/admin` serves the Vite SPA built from `gateway/admin-ui` into `gateway/public/admin`; `/admin/api/*` is the gateway JSON API (non-`admin` role 403). Grants are project-centric: a project is an existing absolute directory, members have `ro` or `rw`, and each user's effective list (private home plus memberships, each with a `label`) is written to `$DSH_HOME/directory-grants.json`. Project creation never creates the host directory; missing, non-directory, and inaccessible paths remain in the create dialog with a corrective message.

The admin console uses one visual system across Users, Projects, Models, Usage, and Audit: a restrained surface palette, shared page and section headers, status badges, explicit loading/empty/error states, keyboard focus rings, and modal forms for mutating operations. At viewports wider than `840px`, navigation is a fixed sidebar and data tables remain comparison-oriented; at `840px` and below, the sidebar becomes a sticky brand header plus a five-item fixed bottom navigation, and table rows switch to readable cards. At `560px` and below, form grids stack, actions fill the available width, and dialogs use nearly the full viewport with an independently scrollable body. Coarse-pointer controls reserve a `44px` target, while dark color-scheme and reduced-motion preferences are honored. After changing the UI, rebuild the static assets with `npm run build --prefix gateway/admin-ui`; the running gateway serves the generated `gateway/public/admin` files without a database migration.

## Model governance and usage accounting

The admin SPA has **Models** and **Usage** pages. Models are identified by exact `(provider, model)` routes. A global enabled flag, role defaults (`admin` / `user`), and per-user `allow` / `deny` / `inherit` exceptions determine the effective policy. A policy change atomically rewrites `$DSH_HOME/model-governance.json` (mode `0600`); a running instance watches that file and applies the validated policy without a restart, while an invalid live document fails closed for new model requests. The instance plugin provides `ctx.modelAccess`; `apiproxy` filters catalogs and rejects selection/prompt RPCs, while the `llm/stream` middleware is the final adapter-dispatch enforcement point for chat, title, compaction, and direct calls.

## PostgreSQL control plane

A pinned PostgreSQL 17 deployment lives in [`deploy/postgres/`](deploy/postgres/README.md). The Gateway entry point applies its immutable migrations and refuses to listen unless the configured active organization and compute node resolve. Authentication, users, projects, node-local instances, audit, model governance, quotas, and usage are PostgreSQL-backed. Internal UUIDs preserve organization foreign keys while numeric public IDs keep the existing HTTP API stable. SQLite remains only as the accepted source of a stopped-writes final import and rollback backup; the running Gateway never opens it.

Every call produces one UUID-keyed usage record in a crash-safe per-instance outbox. The loopback intake deduplicates UUIDs in PostgreSQL, applies the price version effective at the call timestamp, and attributes company cost from a non-secret credential source label (`file`/`project-env`/`request` are personal; launch environment sources are company; unknown remains company-conservative). No API key, prompt, or response content enters the ledger. Natural months use `HGW_USAGE_TIME_ZONE`; token and company-cost quotas support role defaults and per-user inherit/unlimited/custom overrides. Quotas warn at 80% and 100% but do not block calls. Users see durable crossings in the Web shell; admins see per-user monthly summaries, missing-usage counts, estimated cost, and company cost.

## Layered directory enforcement

The gateway only authenticates and orchestrates; directory boundaries are enforced by two layers: the Linux production systemd mount namespace (kernel level, read and write, covering the whole process tree), plus the [dsh-directory-guard](../plugins/dsh-directory-guard/README.md) plugin loaded inside every instance (a `tools/pre-execute` gate over structured-path tool arguments). The same home patch disables `directory-picker-auto` and mounts the in-app browse pair, so a public-domain browser selects workspace directories in the page instead of opening an OS chooser on the host display. When the grants file has at least one valid path, that browse backend lists those roots and refuses paths outside them. macOS dev has no systemd, so the plugin layer is the only enforcement there — development use only.
