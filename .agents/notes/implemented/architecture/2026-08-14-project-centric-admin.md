# Agent Note: Project-centric admin browse roots and unauthorized workspace open

Status: implemented

English | [中文](2026-08-14-project-centric-admin.zh.md)

## Problem

Gateway users add workspaces through the in-app directory browser over the instance filesystem. Without a grants-aware default listing, that dialog started at the OS home and walked the whole disk. After an admin removed project membership, the workspace menu still offered the old path and `onPick` opened it, so a revoked project remained a current workspace until something else failed.

The grants file already carried optional `label` for display; [directory-guard](../feature/2026-08-14-directory-guard.md) ignores unknown fields and enforces `path`/`mode` only. Standalone `dsh web` has no grants file and must keep listing from the OS home.

## Decision

The browse backend (`BrowseDirectoryPicker`) loads `$DSH_DIRECTORY_GRANTS` or `$DSH_HOME/directory-grants.json` once at construction, the same path directory-guard uses. `loadGrantRoots()` parses the JSON array, keeps `label` for the listing row name, ignores other unknown fields, `realpath`s each `path`, and skips entries whose directory is gone. When at least one root remains, `list()` with no path returns `{ path, home }` of the first root, `crumbs: []`, and `entries` of every root (`name = label || basename(path)`). `list(path)` and `createDirectory` throw `directory-unreadable` / `directory-create-failed` when `classify` is `none` (segment-aware prefix, identical to guard `contains`). Crumbs for a path inside a root start at that grant root. An absent file, non-array JSON, or empty valid list keeps OS-home listing.

`WorkspacePickFlow.handleSelect` for an existing workspace calls optional `listDirectory()` with no path. Empty crumbs mean a grant-root listing: if `workspace.path` is not a root or a descendant, the flow sets `menu.workspaceUnauthorized` on the folder-error dialog and does not `onPick`. Missing `listDirectory`, `DirectoryBrowseError` with `directory-picker-unavailable` (native Host; production still injects the callback), or a listing that still has ancestry crumbs (OS home), skips the check so standalone dsh web does not refuse workspaces. Concurrent picks increment a generation; a stale unauthorized result does not open the dialog after a later authorized `onPick`. The optional callback is an inject member, not a SlotMap change. `ui-workspace` registers `menu.workspaceUnauthorized` in zh and en.

Related owners: [directory-picker seam](2026-07-28-directory-picker-capability-seam.md), [directory-guard](../feature/2026-08-14-directory-guard.md), [gateway public settings and browse](2026-08-14-gateway-public-settings-and-browse.md).

## Alternatives considered

**A new Host RPC that returns `{ path, mode, label }[]`.** Rejected: `list()` with no path already reaches the client, and a second grants channel would drift from the listing the dialog shows.

**A `BrowseDirectoryPicker.Config` browse-root list.** Rejected: the gateway already writes the grants file; a second Config copy would desynchronize on restart.

**Widening the directory-flow SlotMap** with authorized roots. Rejected: the check is a pick-menu concern, not part of the occupant conversation (`open`/`onPicked`).

**Always fencing picker selection against `list()` entries.** Rejected: a standalone OS-home listing's entries are children of home, which would refuse a workspace at home itself or outside home — a regression the grants-file absence must not cause. Empty `crumbs` is the browse contract that distinguishes grant-root listings.

**Importing `loadGrants` from `dsh-directory-guard`.** Rejected: the plugin is out-of-tree and not a workspace dependency of the host package; browse must keep `label` for display while guard drops it.

## Consequences

Selecting a workspace from the conversation picker issues `host.listDirectory` with no path when the inject is present; grant-root listings are a handful of rows, OS-home listings can be large and are then ignored for the fence. Native `directory-picker-unavailable` fail-opens to `onPick`. `workspace.create` still accepts arbitrary paths — the browse and picker checks are UX scoping; directory-guard and the systemd mount namespace remain the security boundary. Browse duplicates a small contains/classify pair rather than depending on the out-of-tree plugin.

## Testing

Browse `service.spec.ts` writes a temp grants file with `label`, junk entries, and a missing directory; `list()` is exactly those two roots, `list('/etc')` and `createDirectory('/etc', …)` throw, crumbs stay at the grant root, and missing/non-array files still list `homedir()`. directory-guard `grants.spec.ts` loads a labeled fixture and still classifies an outside path as `none`. ui-workspace picker specs: `/revoked` against grant-root entries does not `onPick` and shows `menu.workspaceUnauthorized`; a descendant of a root does `onPick`; an OS-home listing with crumbs skips the check; omitted `listDirectory` and injected `directory-picker-unavailable` skip the fence and `onPick`; a stale unauthorized listing after a later authorized pick does not open the dialog.
