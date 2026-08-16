# @deepseek-ai/dsh-directory-guard

English | [中文](README.zh.md)

An out-of-tree dsh plugin bundle that enforces per-user directory permissions **inside** a dsh instance, as the philosophy-native counterpart to the gateway's OS-level (systemd) enforcement. See the platform design doc §7 and §14.

## What it does

- Registers a `tools/pre-execute` listener (the documented "permission gate" extension point — no change to the agent loop) that **denies** filesystem tool calls resolving outside the caller's granted directories.
- Re-states the regular-user `permission` preset table **without `danger-full-access`** (`cordis.patch.yml`). Gateway-managed administrators append `cordis.admin.patch.yml`, which restores the shipped Full access preset after the restricted table.
- Disables `directory-picker-auto` and mounts the browse host/client pair, so a public-domain browser gets the in-app Select Workspace Directory dialog instead of an OS chooser on the host display.

## Enforcement rule

Grants are `{ path, mode: 'ro' | 'rw' }` entries and may also carry a `label` (display name for the browse root list). Enforcement reads only `path` and `mode`; extra fields are ignored. A regular user's home is always `rw`; a gateway-managed administrator receives one `rw` grant for the filesystem root. For each tool call with a known path argument:

| Tool | Path arg | Operation |
|---|---|---|
| `read` | `file_path` | read |
| `write`, `edit` | `file_path` | write |
| `str_replace_editor` | `path` | `view` = read; `create`/`str_replace`/`insert` = write |

- **write** to a target not inside an `rw` grant → denied.
- **read** of a target outside every grant → denied.
- Paths are resolved against the session cwd (falling back to the process cwd), then the nearest existing ancestor is `realpath`-ed to defeat symlink escapes.

## Boundary (honest limits)

This gate covers the **structured-path fs tools** above. It intentionally does **not** parse `bash` (arbitrary `cd`/commands) or the workspace/host API surface (`workspace.create`, `host.listDirectory`). Those are bounded by:

- the dsh `ctx.sandbox` layer, and
- **on Linux production, the systemd mount-namespace** confinement per instance (the authoritative read+write boundary).

On macOS dev (no systemd) this plugin is the primary directory enforcement for regular users. An administrator's root grant and Full access selection intentionally expose every path available to the Gateway process account.

## Grants handoff

The gateway writes the user's role-aware grants to the instance's `$DSH_HOME/directory-grants.json` before every start. The plugin reads `$DSH_DIRECTORY_GRANTS` (or `$DSH_HOME/directory-grants.json`) once at load; the gateway restarts the instance on any grant or role change, so a live process always reflects current grants.

## Upstream coupling (sync strategy)

All dsh-internal type imports (`Context`, `ToolExecution`, `PreToolDecision`) live in the single file [`src/dsh-adapter.ts`](src/dsh-adapter.ts). An upstream rename touches that one file. `src/grants.ts` and `src/guard.ts` are pure Node logic with no dsh dependency and carry the full unit-test suite.

## Mounting

- **Dev (source workspace):** make the package resolvable (link it into the profile / workspace `node_modules`), then boot with the patch: `pnpm dsh web --patch plugins/dsh-directory-guard/cordis.patch.yml`.
- **Production (pinned npm dsh):** `dsh plugin --profile <name> add <this package>`, which installs it into the profile and activates its `dsh.bundle` patch.

Inspect the composed tree without booting: the regular `cordis.patch.yml` should show a `directory-guard` row and a `permission` table without `danger-full-access`; appending `cordis.admin.patch.yml` should restore that preset while retaining the guard and browse rows.

## Tests

`npm test` runs the pure-logic suites (`grants`, `guard`) plus the deny-wording snapshot (`guard.snapshot.spec.ts`) that pins the model-visible denial text. `npm run typecheck` verifies the dsh-typed wiring against the built dsh declarations.

## Remaining verification (manual, needs a model/API key)

Boot a real instance with the plugin mounted and drive a denied tool call end to end (agent attempts a write outside its grants → gate returns the deny result). This is the same manual bucket as the gateway's two-user e2e.
