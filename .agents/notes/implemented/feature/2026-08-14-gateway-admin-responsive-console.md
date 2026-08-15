# Agent Note: Responsive gateway admin console

Status: implemented

English | [中文](2026-08-14-gateway-admin-responsive-console.zh.md)

## Problem

The gateway admin SPA exposed the right management operations but presented them as an unstructured set of headings, native controls, and wide tables. The desktop layout did not establish navigation or hierarchy, and the same tables became difficult to scan or operate on phone-width screens. Mutating actions also lacked a shared loading, error, confirmation, and focus model, so each page could drift while the underlying admin API stayed consistent.

## Decision

`gateway/admin-ui` owns a small shared presentation layer (`PageHeader`, `Section`, `Button`, `IconButton`, `StatusBadge`, `Field`, `Dialog`, `ConfirmDialog`, `LoadingState`, `EmptyState`, and `ErrorBanner`) and a single token set in `index.css`. Users, Projects, Models, Usage, and Audit use those primitives for the same hierarchy, status tones, form spacing, keyboard focus, and asynchronous states. Lucide icons identify navigation and compact actions; icon-only controls carry an accessible label and tooltip.

The shell has a fixed `224px` desktop sidebar and a constrained content column. At viewports up to `840px`, it switches to a sticky brand header and a five-item fixed bottom navigation, and each data table has a mobile card representation that preserves the same fields and actions. At viewports up to `560px`, form grids become single-column, action groups fill the available width, and dialogs use nearly the viewport with a scrollable body. Coarse-pointer controls reserve a `44px` target. The stylesheet honors dark color-scheme and reduced-motion preferences and keeps the content padded clear of the fixed mobile navigation and safe-area insets.

The page behavior remains API-driven: loading, empty, and error states are explicit; destructive actions use confirmation dialogs; create and edit forms close only after a successful request; and model, quota, membership, instance, audit-filter, and pagination controls retain their existing API semantics. Project-directory validation converts host filesystem failures into stable API diagnostics, and the create dialog translates those diagnostics without discarding the entered name or path. The Vite build writes `gateway/public/admin`, which the gateway serves directly.

## Alternatives considered

**Keep native controls and wide tables.** Rejected because the existing API contract does not require a desktop-only presentation, and wide tables force horizontal scrolling or clipped actions on phones.

**Reuse the main Web application's shell packages.** Rejected because the gateway admin is a standalone Vite SPA with a separate deployment artifact and no Cordis client-plugin runtime; a local primitive layer keeps the admin build independent while matching the product's restrained visual language.

**Use only a hamburger drawer on mobile.** Rejected because a persistent five-item bottom navigation keeps the five admin areas one tap away and leaves the current page context visible without a second overlay state.

**Keep one DOM table and shrink its columns.** Rejected because column compression hides paths, statuses, and action labels; dedicated mobile cards preserve readable field/value grouping and make touch actions explicit.

## Consequences

Desktop users gain stable navigation and denser comparison views, while phone users get a single-column workflow with touch-sized controls and no horizontal overflow. The mobile card markup duplicates the table presentation, so every admin row change must update both render paths; shared row data and focused browser checks keep the two views aligned. Static asset deployment is a build step, not a database or session migration, and a running gateway can serve the new bundle without restarting active user instances.

## Testing

The admin UI Vitest suite covers navigation, API request contracts, user confirmation and create flows, project path failures, and shared app rendering. Gateway tests pin the stable missing-directory diagnostic. TypeScript and Vite builds pass. An authenticated production browser check covers all five routes at `1440x900` and `390x844`, verifies the sidebar/bottom-navigation mode, confirms `scrollWidth` does not exceed the viewport, and captures the rendered pages for visual review.
