# harness-gateway

English | [中文](README.zh.md)

The public-facing portal gateway for DeepSeek Harness: login/session handling, user/project/directory grants (SQLite), HTTP+WS reverse proxy (rewriting Host/Origin to the instance loopback address), per-user dsh instance lifecycle, the `/admin` SPA plus `/admin/api` JSON, and auditing. Design and staged plan: [design doc](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md), [Phase 1 plan](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md), [project-centric admin](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md).

## Toolchain

- **Node 25** (`.nvmrc`; the dsh repository's engines `^22.19 || >=24` accept it). `better-sqlite3` and `argon2` are native modules whose ABI binds to the Node major that installed them — after switching Node, run `npm rebuild better-sqlite3 argon2`, otherwise they fail with a `NODE_MODULE_VERSION` mismatch.
- Commands: `npm run dev` (tsx entry), `npm test` (vitest), `npm run typecheck`.

## Configuration (environment variables, see src/config.ts)

| Variable | Default | Meaning |
|---|---|---|
| `HGW_PORT` | 8899 | Gateway listen port |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | Comma-separated public Origin allowlist (CSRF check; https marks cookies Secure) |
| `HGW_DATA_DIR` | `gateway/data` | SQLite and runtime data directory |
| `HGW_USERS_ROOT` | `~/harness-users` | Users root (production `/srv/harness/users`) |
| `HGW_DSH_COMMAND` | source entry `apps/cli/src/bin.ts web --port {port}` | Instance launch command; production points at the pinned npm `dsh` bin |
| `HGW_DSH_REPO_ROOT` | repo root | Resolves the source-run entry |
| `HGW_INSTANCE_PORT_BASE` | 42000 | Instance port allocation base |
| `HGW_IDLE_TIMEOUT_MS` | 30 min | Instance idle-sleep threshold |
| `HGW_READINESS_TIMEOUT_MS` | 30 s | Instance readiness wait ceiling |
| `HGW_LAUNCHER` | `local` | Instance launch driver: `local` (macOS dev subprocess) / `systemd` (Linux production per-user units) |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | Unit directory the systemd driver writes per-user unit files into |
| `HGW_GUARD_PATCH` | `<repo>/plugins/dsh-directory-guard/cordis.patch.yml` | directory-guard bundle patch mounted into every instance; `off` disables |
| `HGW_DEFAULT_ENV_FILE` | (empty) | Company default credentials copied to each instance's `$DSH_HOME/.env` on start |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | Per-instance systemd resource limits |
| `HGW_GATEWAY_DIR` | gateway root | Directory masked from instances (`InaccessiblePaths`) |

Production install, cutover, and acceptance live in [deploy/README.md](deploy/README.md).

## Admin console and project grants

`/admin` serves the Vite SPA built from `gateway/admin-ui` into `gateway/public/admin`; `/admin/api/*` is the gateway JSON API (non-`admin` role 403). Grants are project-centric: a project is an existing absolute directory, members have `ro` or `rw`, and each user's effective list (private home plus memberships, each with a `label`) is written to `$DSH_HOME/directory-grants.json`.

## Layered directory enforcement

The gateway only authenticates and orchestrates; directory boundaries are enforced by two layers: the Linux production systemd mount namespace (kernel level, read and write, covering the whole process tree), plus the [dsh-directory-guard](../plugins/dsh-directory-guard/README.md) plugin loaded inside every instance (a `tools/pre-execute` gate over structured-path tool arguments). The same home patch disables `directory-picker-auto` and mounts the in-app browse pair, so a public-domain browser selects workspace directories in the page instead of opening an OS chooser on the host display. When the grants file has at least one valid path, that browse backend lists those roots and refuses paths outside them. macOS dev has no systemd, so the plugin layer is the only enforcement there — development use only.
