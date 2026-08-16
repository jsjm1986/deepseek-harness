# harness-gateway

English | [中文](README.zh.md)

The public-facing portal gateway for DeepSeek Harness: PostgreSQL-backed login/session handling, user/project/directory grants, HTTP+WS reverse proxy (rewriting Host/Origin to the instance loopback address), personal and shared-project dsh runtime lifecycle, the `/admin` SPA plus `/admin/api` JSON, collaborative conversations, model governance, usage accounting, and auditing. Design and staged plan: [design doc](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md), [Phase 1 plan](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md), [project-centric admin](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md).

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
| `HGW_PROJECT_RUNTIMES_ROOT` | `~/harness-project-runtimes` | Host-owned `$DSH_HOME` roots for shared project runtimes |
| `HGW_PROJECTS_ROOT` | `~/harness-projects` | Managed root for name-only administrator project creation (`<root>/<name>`, mode `0770`; production `/srv/harness/projects/admin`) |
| `HGW_USER_PROJECTS_ROOT` | `<first project-path-root>/user-projects` | Managed folder root for projects created by users; production `/srv/harness/projects/user-projects` |
| `HGW_PROJECT_PATH_ROOTS` | (required for `systemd`) | Comma-separated, non-overlapping absolute Linux roots that contain project directories; `/` is forbidden |
| `HGW_PROJECT_RUNTIME_USER` | `harness-project` | Dedicated Linux account used by project-scoped systemd units |
| `HGW_PRINCIPAL_KEY_DIR` | `~/.harness-gateway/principal-keys` | Owner-private Ed25519 keypair used to sign browser request principals |
| `HGW_PRINCIPAL_ASSERTION_TTL_MS` | 30 s | Lifetime of one signed principal; WebSocket clients reconnect before expiry |
| `HGW_RUNTIME_CREDENTIAL_DIR` | `~/.harness-gateway/runtime-credentials` | Host-private credential files loaded into systemd user/project runtimes |
| `HGW_RUNTIME_API_BODY_LIMIT_BYTES` | 64 MiB | Maximum body size accepted by one authenticated private runtime API request |
| `HGW_DSH_COMMAND` | source entry `apps/cli/src/bin.ts web --port {port}` | Instance launch command; production points at the pinned npm `dsh` bin |
| `HGW_DSH_REPO_ROOT` | repo root | Resolves the source-run entry |
| `HGW_INSTANCE_PORT_BASE` | 42000 | Instance port allocation base |
| `HGW_IDLE_TIMEOUT_MS` | 30 min | Instance idle-sleep threshold |
| `HGW_READINESS_TIMEOUT_MS` | 30 s | Instance readiness wait ceiling |
| `HGW_LAUNCHER` | `local` | Instance launch driver: `local` (macOS dev subprocess) / `systemd` (Linux production per-user units) |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | Unit directory the systemd driver writes per-user unit files into |
| `HGW_GUARD_PATCH` | `<repo>/plugins/dsh-directory-guard/cordis.patch.yml` | directory-guard bundle patch mounted into every instance; its sibling admin overlay restores Full access for administrators; `off` disables |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<repo>/plugins/dsh-model-governance` | Tree-external per-instance authorization and usage plugin linked into each profile |
| `HGW_DEFAULT_ENV_FILE` | (empty) | Company default credentials copied to each instance's `$DSH_HOME/.env` on start |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | Per-instance systemd resource limits |
| `HGW_GATEWAY_DIR` | gateway root | Directory masked from instances (`InaccessiblePaths`) |

Production install, cutover, and acceptance live in [deploy/README.md](deploy/README.md).

## Admin console and project grants

`/admin` serves the Vite SPA built from `gateway/admin-ui` into `gateway/public/admin`; `/admin/api/*` is the gateway JSON API (non-`admin` role 403). Grants are project-centric: an administrator-origin project is created from its name alone, which creates or reuses `<HGW_PROJECTS_ROOT>/<name>` with mode `0770` (the JSON API retains an optional absolute `path` for importing an existing directory), while a user-origin project allocates one directory below `HGW_USER_PROJECTS_ROOT`; both use the same workspace, shared runtime, membership, and conversation model. User-created projects make their creator the `rw` owner and expose invitation lifecycle operations; administrators can inspect both origins through one list and filter by origin. Members have `ro` or `rw`, and each regular user's effective list (private home plus memberships, each with a `label`) is written to `$DSH_HOME/directory-grants.json`. Administrators receive one `rw` grant for the filesystem root and the Full access preset in personal and project scopes. The preset changes dsh's in-app sandbox and approval knobs only; a project runtime remains kernel-confined to its project path. A role change rewrites this projection and restarts a running personal instance. Managed names are trimmed and must form exactly one directory segment, so `.`/`..`, separators, control characters, and symlink-resolved escapes are rejected; missing, non-directory, and inaccessible explicit paths remain in the create dialog with a corrective message. User deletion is logical: it stops the personal instance, revokes sessions, removes project and model access, hides the account from login and admin lists, and retains audit, usage, conversation, and home history; the username stays reserved. Project paths cannot overlap another project, a user home, the users root, or the project-runtime root; the systemd launcher also requires every project to be a strict descendant of one `HGW_PROJECT_PATH_ROOTS` entry and outside the Gateway directory.

The admin console uses one visual system across Users, Projects, Models, Usage, and Audit: a restrained surface palette, shared page and section headers, status badges, explicit loading/empty/error states, keyboard focus rings, and modal forms for mutating operations. Project detail includes membership, instance state, natural-month token/cost/missing-usage totals, and a required quota mode: inherit the ordinary-member quota or submit both project token and company-cost limits. At viewports wider than `840px`, navigation is a fixed sidebar and data tables remain comparison-oriented; at `840px` and below, the sidebar becomes a sticky brand header plus a five-item fixed bottom navigation, and table rows switch to readable cards. At `560px` and below, form grids stack, actions fill the available width, and dialogs use nearly the full viewport with an independently scrollable body. Coarse-pointer controls reserve a `44px` target, while dark color-scheme and reduced-motion preferences are honored. After changing the UI, rebuild the static assets with `npm run build --prefix gateway/admin-ui`; the running gateway serves the generated `gateway/public/admin` files without a database migration.

## Project collaborative conversations

An account runs in either personal scope or one accessible project scope. Personal scope retains its per-user runtime and persistence; every project uses one shared runtime over the project path. The Gateway signs a short-lived request principal for the selected runtime and forwards it on every proxied HTTP/WebSocket operation. The runtime verifies organization, user, scope, runtime id, and generation before Host code can observe the request. Private runtime credentials and collaboration endpoints remain loopback-only. The complete decision is recorded in [project collaborative conversations](../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md).

Project members are `ro` or `rw`. Organization administrators have implicit `rw` authority over every active project and every project conversation, including private roots, without a project-membership row. The administrator-only `danger-full-access` preset is available in every personal or project scope after request identity is verified; ordinary users cannot select it through either `/permission` or a new-session default. In a shared project session, permission events are session-global, so an administrator changing the preset changes the in-app preset seen by all participants until another authorized selection; the systemd project unit still limits host access to the project path. For ordinary members, root conversations choose project-visible or creator-private access, and descendants inherit the root ACL. Host operations authorize reads, writes, management, forks, streams, approvals, and questions; PostgreSQL admits only one response to each shared approval/question. Project runtimes store Session headers and complete events through the Gateway PostgreSQL provider, whose write and read decoders require exact event-envelope fields and surface metadata before data enters a live Session. Durable participant metadata lets the model and transcript distinguish contributors. The Web plugin exposes scope, visibility, creator, participants, and contribution counts, and replaces the complete composer for `ro` members; the browser is not the authorization boundary.

Session ACL checks query current membership on every operation. Scope-only Host operations use the signed mode for at most `HGW_PRINCIPAL_ASSERTION_TTL_MS` (30 seconds by default), and long-lived streams disconnect at principal expiry. Deleting a project stops its shared runtime inside the runtime's serialized operation slot before PostgreSQL cascades project-owned runtime and collaboration records; the project directory remains on disk.

## Model governance and usage accounting

The admin SPA has **Models** and **Usage** pages. Models are identified by exact `(provider, model)` routes. A global enabled flag, role defaults (`admin` / `user`), and per-user `allow` / `deny` / `inherit` exceptions determine the effective policy. A policy change atomically rewrites `$DSH_HOME/model-governance.json` (mode `0600`); a running instance watches that file and applies the validated policy without a restart, while an invalid live document fails closed for new model requests. The instance plugin provides `ctx.modelAccess`; `apiproxy` filters catalogs and rejects selection/prompt RPCs, while the `llm/stream` middleware is the final adapter-dispatch enforcement point for chat, title, compaction, and direct calls.

## PostgreSQL control plane

A pinned PostgreSQL 17 deployment lives in [`deploy/postgres/`](deploy/postgres/README.md). The Gateway entry point applies its immutable migrations and refuses to listen unless the configured active organization and compute node resolve. Authentication, users, projects, personal/project instances, shared project conversations, collaboration claims, audit, model governance, quotas, and usage are PostgreSQL-backed. Internal UUIDs preserve organization foreign keys while numeric public IDs keep the existing HTTP API stable. SQLite remains only as the accepted source of a stopped-writes final import and rollback backup; the running Gateway never opens it.

Every call produces one UUID-keyed usage record in a crash-safe per-runtime outbox. The loopback intake deduplicates UUIDs in PostgreSQL, applies the price version effective at the call timestamp, and attributes company cost from a non-secret credential source label (`file`/`project-env`/`request` are personal; launch environment sources are company; unknown remains company-conservative). No API key, prompt, or response content enters the ledger. Natural months use `HGW_USAGE_TIME_ZONE`; token and company-cost quotas support role defaults, per-user inherit/unlimited/custom overrides, and project inherit-or-explicit limits. Quotas warn at 80% and 100% but do not block calls. Users see durable crossings in the Web shell; admins see per-user and per-project monthly summaries, missing-usage counts, estimated cost, and company cost.

## Layered directory enforcement

The gateway only authenticates and orchestrates; regular-user directory access is enforced by the Linux production systemd mount namespace and the [dsh-directory-guard](../plugins/dsh-directory-guard/README.md) plugin loaded inside every instance. Regular units mask the users root, project-runtime root, and configured project roots before re-binding only the runtime home, `$DSH_HOME`, and authorized project directories; `ProtectSystem=strict`, `ProtectHome=tmpfs`, and removal of `CAP_SYS_ADMIN` apply across the process tree. The home patch also replaces the host OS directory chooser with the in-app browser, which lists grant roots and refuses paths outside them. Administrators retain the same plugin composition but receive a filesystem-root grant and the Full access preset; their systemd unit removes the regular directory masks and read-only system/home settings while retaining the non-root runtime account, `NoNewPrivileges`, the capability restriction, and the Gateway-directory exclusion. Shared project units run under `HGW_PROJECT_RUNTIME_USER`, bind only the project path and their private `$DSH_HOME`, and expose credential settings read-only. The managed user-project root must inherit group access for `HGW_PROJECT_RUNTIME_USER` (for example a setgid `2770` root owned by `harness-project`, or an equivalent default ACL), otherwise a newly allocated directory cannot be opened by its project unit. On macOS there is no systemd mount namespace, so regular-user and shared-project process-wide confinement remains a development limitation.
