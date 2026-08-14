# Production deployment runbook

English | [中文](README.zh.md)

Brings the gateway online on a Linux host with systemd kernel confinement and switches the public domain over to it. Layout used throughout: gateway code at `/srv/harness/gateway`, data at `/srv/harness/gateway-data`, user directories under `/srv/harness/users`, the guard plugin at `/srv/harness/plugins/dsh-directory-guard`.

## Prerequisites

- Linux with systemd, root access, `sqlite3`, and Node 25 (`/usr/local/bin/node`; adjust unit paths for nvm layouts).
- The pinned dsh release: `npm install -g @deepseek-ai/dsh@0.1.0-rc.5` (upgrades are a version bump + rolling restarts, never a source checkout). Note: locally uncommitted work in a dev clone (for example UI changes) is not in the npm release until it lands upstream.
- DNS/entry control for the public domain (Nginx or Cloudflare Tunnel).

## Install

1. Copy `gateway/` to `/srv/harness/gateway`; run `npm install && npm rebuild better-sqlite3 argon2` there with the production Node. `public/admin` is gitignored, so also run `npm run build --prefix gateway/admin-ui` (from the repo root, or `npm run build --prefix admin-ui` after the copy) before the SPA is served.
2. Copy `plugins/dsh-directory-guard/` to `/srv/harness/plugins/dsh-directory-guard`; run `npm install --omit=dev && npx tsc -p tsconfig.build.json` (instances load its built `lib/`; the pinned npm dsh runs plain Node, no tsx).
3. Write the company default credentials to `/srv/harness/gateway-data/company.env` (`DEEPSEEK_API_KEY=...`, mode 600). Every instance start copies it to that user's `$DSH_HOME/.env`; personal keys set from Settings live in `.credentials.yaml` and outrank it.
4. Copy `deploy/harness-gateway.service` to `/etc/systemd/system/`, adjust `HGW_PUBLIC_ORIGINS` to the real https origin and the paths if they differ, then `systemctl daemon-reload && systemctl enable --now harness-gateway`.
5. First boot prints the bootstrap admin password to the journal: `journalctl -u harness-gateway | grep 'bootstrap admin'`.

## Per-user provisioning

Create the user in `/admin`, then run `deploy/provision-user.sh <username>` once as root: it creates the `harness-<username>` system account and chowns `/srv/harness/users/<username>/{home,dsh}`. The instance unit is rendered automatically on every start from the user's current grants. Membership and permission writes restart a live instance immediately.

## TLS entry and cutover

Point the public domain at the gateway and close the direct instance port. Nginx server block essentials:

```nginx
server {
  listen 443 ssl;
  server_name harness.example.com;
  location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
```

Cutover checklist: set `HGW_PUBLIC_ORIGINS=https://<domain>` (Secure cookies switch on it), reload the entry to upstream `127.0.0.1:8899`, then **stop the previously exposed single dsh instance** (or rebind it to loopback) — after cutover nothing but the TLS entry may reach the host ports.

## Acceptance

- Gateway behavior: `bash scripts/accept-phase1.sh` (any host, 23 checks, no API key).
- Kernel confinement: log in once as the test user so the unit starts, then `sudo bash scripts/accept-phase2.sh <user> <other-user> [ro-path] [rw-path]` — verifies peer invisibility, own-home writes, `ProtectSystem`, ro/rw grant semantics from inside the mount namespace. Re-run it after switching the session to `danger-full-access`: the kernel boundary must hold unchanged.
- Reboot resilience: `reboot`, then confirm `harness-gateway` is active and a login re-reaches a working instance.

## macOS variant (launchd, tunnel entry)

A macOS host (e.g. an office machine behind a Cloudflare Tunnel) runs the same gateway with `HGW_LAUNCHER=local` and launchd instead of systemd: a `~/Library/LaunchAgents/com.maycran.harness-gateway.plist` (KeepAlive, RunAtLoad) execs `node --import tsx/esm src/index.ts` in the gateway directory with the `HGW_*` variables, and the tunnel config's ingress upstream points at `http://127.0.0.1:8899`. Kernel directory confinement does not exist on macOS — isolation is per-user processes plus the directory-guard plugin only — so treat a macOS deployment as a trusted-team form, not the full Phase 2 boundary. Cutover disables the previous direct-instance LaunchAgent (`launchctl bootout` and rename the plist so RunAtLoad cannot revive it).

## Upgrades and backup

Upgrade dsh: `npm install -g @deepseek-ai/dsh@<next>` on staging, run both acceptance scripts, then roll production instances one by one (`systemctl restart harness-<user>` or let idle instances pick the new binary on next login). Gateway upgrades: replace `/srv/harness/gateway`, `systemctl restart harness-gateway` (instances keep running). Database: install `deploy/backup-sqlite.sh` under cron (daily, 30 archives retained).
