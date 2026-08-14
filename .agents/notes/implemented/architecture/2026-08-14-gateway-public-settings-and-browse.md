# Agent Note: Gateway public settings and in-app directory browse

Status: implemented

English | [中文](2026-08-14-gateway-public-settings-and-browse.zh.md)

## Problem

A browser on the tunneled public origin (`harness.maycran.com`) is the same single-user instance the operator reaches at `127.0.0.1`, but two client checks treated the public hostname as a remote, unauthenticated LAN client. Settings scopes bound `memory` persistence from `connection.isLoopback`, so plugin configuration, theme, locale, models, credentials, and permission rows never called `settings.describe` and rendered blank. Gateway instances bind `127.0.0.1` on a machine with a display, so `directory-picker-auto` mounted the native OS chooser; the gateway rewrites `Host`/`Origin` to the instance loopback, so `host.pickDirectory` succeeded and the Finder dialog opened on the host display, invisible to a browser on another device.

## Decision

`SettingsScopeBinder.bind` always uses Host persistence. A thrown or non-ok `settings.describe` publishes `unavailable` so cards hide instead of hanging on `loading`. The Host `PRIVILEGED_METHODS` fence is unchanged: it still requires a loopback `Host` header. The gateway's existing rewrite is what makes those RPCs succeed for a logged-in public page. `settings.openDocument` and `host.openPath` remain loopback-page actions because they drive the host desktop.

The directory-guard home patch disables `directory-picker-auto` and inserts the browse host/client pair, the same disable+insert used by `apps/web/tests/pin-browse-picker.overlay.yml`. Every gateway-launched instance therefore serves the in-app Select Workspace Directory dialog. A direct `dsh web` without that patch still resolves `-auto` from bind host, SSH, and display.

Related owners: [directory-picker seam](2026-07-28-directory-picker-capability-seam.md), [config-plane boundaries](2026-07-30-config-plane-boundaries.md), [Host-backed web preferences](../bug-fix/2026-08-06-host-backed-web-preferences.md), [product onboarding](../feature/2026-08-13-shared-modal-product-onboarding.md).

## Alternatives considered

**Bind instances on `0.0.0.0`.** Rejected: the tunnel already reaches `127.0.0.1`, and an all-interfaces bind would expose per-user instance ports beside the gateway.

**Treat page hostname as loopback, or add `trustedHosts` to `PRIVILEGED_METHODS`.** Rejected: that would open settings and credentials on a `--trusted-host` process with no login. The Host fence stays; only the client stops refusing to call it.

**Pin browse with an environment variable or a new auto Config field.** Rejected: the seam already documents composing `-browse` directly, and the e2e overlay already uses disable+insert.

**Per-connection native-for-local and browse-for-remote on one process.** Rejected: the seam deleted the wire advertisement that would be required, and a gateway instance has no local desktop operator to serve.

## Consequences

A logged-in public page can configure plugins, theme, locale, models, credentials, and permission presets, and can add a workspace through the in-app directory browser over the instance filesystem (still bounded by grants and, on Linux, the systemd mount namespace). Direct `--trusted-host` without the gateway still 403s privileged methods. Operators must restart each gateway instance so it recopies the home patch. The proxy treats a `ready` row whose tracked child has exited as not live and shows the waiting page while `ensureRunning` respawns; trusting the row alone proxies to a dead port and returns `instance-unreachable`. Opening a produced file or the settings document in a host OS application stays a loopback-page gesture.
