# Agent Note: dsh-directory-guard — in-instance directory permission gate

Status: implemented

English | [中文](2026-08-14-directory-guard.zh.md)

## Problem

The public-deployment platform (gateway + one dsh instance per user) needs per-user directory permissions enforced inside each instance. The kernel boundary (Linux systemd mount namespaces) covers the whole process tree but is absent on macOS dev, and even where present a model-visible early denial beats a raw EACCES from a confined syscall. dsh core must stay unmodified: the platform pins dsh as an npm dependency and tracks the fast-moving upstream without a fork.

## Decision

An out-of-tree plugin bundle at `plugins/dsh-directory-guard` (its own repository area beside `gateway/`, not under `packages/`). A `tools/pre-execute` waterfall listener denies structured-path fs tool calls (`read`, `write`, `edit`, `str_replace_editor`) whose canonicalized target falls outside the caller's grants — write requires an `rw` grant, read requires any grant; targets resolve against the session cwd and the nearest existing ancestor is realpath-ed so a symlinked directory cannot escape. Grants come from `$DSH_HOME/directory-grants.json`, written by the gateway before every instance start. The bundle's `cordis.patch.yml` re-states the regular-user `permission` preset table without `danger-full-access`, closing the in-app path to switching the dsh sandbox off.

Gateway-managed administrators receive one `rw` grant for the filesystem root and append the bundle's `cordis.admin.patch.yml` after the restricted patch. That overlay restores the shipped `danger-full-access` preset while retaining the guard and browse plugins; the root grant makes the structured-path check non-restricting for the trusted role. On Linux the administrator unit still runs under the user's dedicated non-root account, omits the managed-root masks, and sets `ProtectSystem=off` plus `ProtectHome=no`; it retains `NoNewPrivileges=yes`, excludes `CAP_SYS_ADMIN`, and keeps the Gateway directory inaccessible. A role change rewrites the grants and restarts a live personal runtime, so its patch and loaded grants agree with the durable role. The gateway mounts the bundle by symlinking the package into the instance's `$DSH_HOME/profiles/node_modules` and writing the composed patches to `$DSH_HOME/cordis.patch.yml` — the home-level user layer applies over every profile regardless of launch argv, which the CLI launcher would otherwise constrain (`--patch` must precede app flags) and the pinned-npm production command does not carry. All dsh-typed imports live in one adapter file (`src/dsh-adapter.ts`); `grants.ts`/`guard.ts` are pure Node logic.

## Boundary

For regular users, the check covers structured-path fs tools only. It does not parse `bash` (arbitrary `cd`/subcommands) or the workspace/host API surface; those stay bounded by `ctx.sandbox` and, on Linux production, by the systemd mount namespace, which is the authoritative read+write boundary for the whole process tree. On macOS the plugin is the primary regular-user directory enforcement, while an administrator's root grant plus `danger-full-access` intentionally exposes every path available to the Gateway process account. Linux administrators have the same intentional host visibility under their dedicated runtime account, subject only to fixed unit exclusions, anti-escalation settings, and that account's operating-system permissions.

## Alternatives considered

- **Authentication/multi-tenancy as an in-process plugin replacing `connection`** — rejected: `events.mux`/`events.host` broadcast process-wide, `/api/respond` lets any connection answer any approval, and `$DSH_HOME` is a process-global singleton, so a single shared instance leaks across users regardless of an auth plugin. Process-per-user erases every leak at once and leaves this plugin one job (the platform design doc §14 owns the full survey).
- **Forking dsh to enforce grants in core** — rejected: the platform pins dsh from npm precisely to avoid a merge treadmill against a pre-release upstream that refuses compatibility shims.
- **Mounting via launch argv `--patch`** — rejected after integration: the dsh launcher accepts its own flags only before app flags, and the production npm command has no patch flag; the home-level patch layer expresses the same bundle mount independent of argv shape.
- **Live grant reload inside the instance** — rejected for now: the gateway restarts an instance on any grant change (seconds), so a file watcher would add lifecycle surface for no user-visible gain.
- **Restoring `danger-full-access` for every role** — rejected: a regular user could bypass the dsh sandbox for opaque Bash commands, which is a host-wide escape on macOS where no systemd mount namespace exists.
- **Omitting the directory-guard bundle from administrator instances** — rejected: it would also remove the in-app directory browser composition and create a second runtime tree. The root grant and ordered admin overlay express the trusted exception without changing plugin topology.

## Consequences

Every instance carries the same guard and browse plugin topology. A missing configured guard patch refuses every managed start; a missing admin overlay refuses administrator starts rather than silently presenting a restricted administrator runtime, and `HGW_GUARD_PATCH=off` remains the explicit opt-out. The deny reason is model-visible and pinned by a snapshot spec (`tests/guard.snapshot.spec.ts`), so rewording is a conscious diff. The plugin owns no authentication and no kernel boundary; it is one layer of the defense stack, honest about the Bash gap and the trusted administrator exception. Patch updates and role changes reach a process through restart rather than live config mutation.

## Testing

Pure-logic vitest suites cover grant loading/classification, path canonicalization (symlink and `..` escapes), per-tool read/write mapping, fail-closed malformed arguments, and the pinned deny wording. Gateway tests cover the regular patch, ordered administrator overlay, missing-overlay refusal, root grant projection, role-change rewrite, and the administrator unit's host visibility with its non-root identity and fixed hardening retained. The gateway acceptance script (`gateway/scripts/accept-phase1.sh`, 23 checks green on macOS) verifies a regular-user mount end to end: home patch layer written, package linked, grants file present before start, and the composed tree showing the `directory-guard` row with `danger-full-access` absent (`--dump-config`). Model-driven end-to-end denial (an agent attempting an out-of-grant write) remains in the manual bucket documented in the plugin README — it needs a real API key.
