# Web UI style reference

English | [中文](web-styling.zh.md)

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

## Component rules

- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.

## Responsive layout

The shell stamps its active viewport class on the frame root as `data-viewport`: `compact` below 768px, `medium` below 1024px, `expanded` below 1440px, and `wide` from there up, with the thresholds in [`viewport.ts`](../packages/client/ui-layout/src/client/viewport.ts). Component CSS inside the frame branches on that stamp (`[data-viewport='compact'] &`) instead of measuring windows or hardcoding width breakpoints.

A panel that adapts to its own width rather than the whole frame declares `container-type: inline-size` on its root and queries it anonymously (`@container (max-width: …)`) at the shared step widths 480, 560, and 720. CSS Modules hash `container-name` per module, so cross-module queries stay anonymous; never declare `container-type` on an ancestor of `position: fixed` content it does not own, because layout containment re-parents the fixed element's containing block.

Take spacing and radii from the metric tokens (`--dsw-space-*`, `--dsw-radius-*`) and device insets from `--dsw-safe-*` (metrics.css). On coarse pointers, hover-revealed controls need an always-visible `@media (pointer: coarse)` fallback and interactive targets keep at least `--dsw-touch-target`; hover-only affordances live under `@media (hover: hover)`. Portaled surfaces never see the frame stamp — they branch in JS with ui-primitives' `useMediaQuery` against the same thresholds.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [styling-system Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) records framework rationale.
