# Agent Note: Responsive shell viewport modes and metric tokens

Status: implemented

English | [中文](2026-08-14-responsive-shell-viewport-modes.zh.md)

## Problem

The web GUI was desktop-first: the shell solved three grid columns against a 640px center floor, the only breakpoint was the 1024 sidebar auto-collapse, and phone-width windows rendered an unusable squeezed layout. Feature panels hardcoded five unrelated `@media` cuts (560/680/720/760) and their own px spacing, so every new feature re-invented width behavior. The UI is 20+ `ui-*` plugins rendered into slots that cannot see how wide their container is, which rules out a convention built on per-panel window measurement.

## Decision

`ui-layout` owns a shared width vocabulary (`viewport.ts`): `compact` <768, `medium` 768–1023, `expanded` 1024–1439, `wide` ≥1440, with `SIDEBAR_AUTO_COLLAPSE` re-derived as the medium/expanded boundary. AppFrame stamps the active class on the frame root as `data-viewport` and renders one of three modes: expanded/wide keep the three-column concession chain unchanged; medium keeps the rail-or-squeezed sidebar column and lifts details into a scrim-dismissed right-edge overlay (the chain would otherwise auto-close it); compact renders a single column under a shell topbar whose toggle owns the sidebar drawer, with details edge to edge. Overlays hide by transform so open/close never re-seats mounted slots, compact session navigation and shrinking into compact both drop the drawer override, and the frame follows `--dsw-viewport-height` (published from `visualViewport`, pinch scale folded out) so the composer stays above the on-screen keyboard.

Panels adapt through anonymous container queries at the shared 480/560/720 steps: CSS Modules hash `container-name` per module, so a named cross-package container can never match, and the shell columns deliberately declare no `container-type` because layout containment would re-parent in-tree `position: fixed` surfaces (lightbox, drop overlay, settings). `ui-theme/styles/metrics.css` adds the theme-invariant metric tokens — `--dsw-space-1..8` (4px step), `--dsw-radius-*`, `--dsw-safe-*` over `env(safe-area-inset-*)` under `viewport-fit=cover`, and `--dsw-touch-target` (44px) — and 619 spacing/radius literals across 90 client sheets were rewritten to them value-identically. The touch baseline lives in ui-primitives (bottom-sheet Modal, inline compact submenus, coarse-pointer row heights, 16px Input text against iOS focus zoom, hidden Tooltip bubbles) plus coarse-pointer reveals for the details drag pill and the tool inspect pill; portal surfaces branch with `useMediaQuery` because they never see the frame stamp. The rules are normative in docs/web-styling.md.

## Alternatives considered

- **`@custom-media` shared breakpoint definitions** — rejected: client CSS is compiled by two independent pipelines (Vite for the shell, lightningcss inside tsdown for plugin bundles), and a draft syntax both must be configured to resolve couples the build paths for what a DOM attribute expresses natively.
- **Declaring `container-type` on the shell's three columns** — rejected: layout containment changes the containing block of every in-tree `position: fixed` descendant, and several non-portaled overlays sit inside the columns today. Containers stay panel-owned and anonymous.
- **Drawer behavior for the medium sidebar** — rejected: 768–1023 windows keep the shipped squeeze-open semantics beside the content, which stays clickable during session switches; only compact gets the modal drawer.
- **Raising every Button to 44px on coarse pointers** — rejected: the 36px button rides enough surrounding spacing to stay tappable, and a blanket bump reflows dense desktop-shared layouts; only sub-40px controls (menu rows, dismiss icons) grow.

## Consequences

Crossing a mode boundary re-seats the sidebar and details subtrees (their view state resets on a rotate or window drag across 768/1024), bought so open/close inside one mode never re-seats anything. Compact stacks the shell topbar above the conversation's own session header, spending vertical space twice until the header adapts. The 619-declaration token rewrite is value-identical but makes future density changes single-point; three literal `4px` paddings that cancel `-4px` pulls stay literal and are asserted by the workspace/sidebar spacing specs. The chat-scroll e2e's narrow-viewport scenario moved from 700 to 800px because <768 now means a modal drawer over the content rather than a squeezed column.

## Testing

jsdom specs cover the mode decisions (drawer, scrim, topbar stamp, session-navigation dismissal, medium overlay details, squeeze-to-compact collapse) plus `viewportClassOf`, `collapseNarrow`, `useMediaQuery`, and the visual-viewport variable lifecycle. The keyless `responsive-shell.e2e.ts` walks the assembled application at 390/900/1280/1680 with a compact-drawer ARIA golden, closing the narrow-viewport acceptance gap `dsh-client-web`'s README previously declared; the shell-adjacent e2e set replays green.
