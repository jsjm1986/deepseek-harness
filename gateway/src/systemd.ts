/**
 * Phase 2 (Linux production): render the per-user systemd unit that confines a
 * dsh instance to the user's granted directories via the kernel mount
 * namespace. This is the AUTHORITATIVE directory boundary — it governs reads
 * and writes across the whole process tree (bash, fs tools, MCP servers), so it
 * holds even if a session switches the in-app dsh sandbox off. The in-dsh
 * `dsh-directory-guard` plugin is the defense-in-depth layer above it (and the
 * only layer on macOS dev, where systemd is absent).
 *
 * Pure string generation: no filesystem or systemctl side effects, so the
 * grant→confinement mapping is fully unit-tested off a Linux host.
 */

export interface SystemdOptions {
  /** Parent of all per-user directories, masked read-only then selectively re-bound. */
  usersRoot: string
  /** ExecStart command line; `{port}` is replaced with the instance port. */
  execStart: string
  /** Gateway code/data directory made inaccessible to instances. */
  gatewayDir: string
  /** systemd `MemoryMax` value, e.g. `1G`. */
  memoryMax: string
  /** systemd `CPUQuota` value, e.g. `100%`. */
  cpuQuota: string
}

export interface SystemdUser {
  username: string
  port: number
  /** Absolute writable home (also the instance cwd / workspace root). */
  homePath: string
  /** Absolute `$DSH_HOME` for this instance. */
  dshHome: string
}

export interface GrantEntry {
  path: string
  mode: 'ro' | 'rw'
}

const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/

/** Reject values that would break a systemd unit line or the `src:dst` bind grammar. */
function assertSafePath(path: string): void {
  if (path.includes('\n') || path.includes('\r')) throw new Error(`unsafe path (newline): ${JSON.stringify(path)}`)
  if (path.includes(':')) throw new Error(`unsafe path (colon breaks bind grammar): ${path}`)
  if (path.trim() === '' || !path.startsWith('/')) throw new Error(`path must be absolute: ${path}`)
}

/** The per-user unit file name. */
export function unitName(username: string): string {
  if (!USERNAME_RE.test(username)) throw new Error(`invalid username: ${username}`)
  return `harness-${username}.service`
}

/**
 * Render the complete per-user systemd service unit. A full per-user unit
 * (rather than a shared template + drop-in) keeps every confinement directive
 * explicit and avoids systemd's ExecStart-override pitfalls.
 */
export function renderUserUnit(user: SystemdUser, grants: readonly GrantEntry[], opts: SystemdOptions): string {
  if (!USERNAME_RE.test(user.username)) throw new Error(`invalid username: ${user.username}`)
  for (const path of [user.homePath, user.dshHome, opts.usersRoot, opts.gatewayDir]) assertSafePath(path)

  const binds: string[] = []
  const seen = new Set<string>()
  for (const grant of grants) {
    assertSafePath(grant.path)
    if (seen.has(grant.path)) continue
    seen.add(grant.path)
    binds.push(grant.mode === 'rw' ? `BindPaths=${grant.path}` : `BindReadOnlyPaths=${grant.path}`)
  }
  // The user home is always writable even if the caller omitted it from grants.
  if (!seen.has(user.homePath)) binds.unshift(`BindPaths=${user.homePath}`)

  return `[Unit]
Description=DeepSeek Harness instance for ${user.username}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=harness-${user.username}
WorkingDirectory=${user.homePath}
Environment=HOME=${user.homePath}
Environment=DSH_HOME=${user.dshHome}
Environment=DSH_DIRECTORY_GRANTS=${user.dshHome}/directory-grants.json
ExecStart=${opts.execStart.replaceAll('{port}', String(user.port))}
Restart=on-failure
RestartSec=5

# ── kernel confinement (authoritative directory boundary) ──
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
# Mask every user directory, then re-bind only this user's home and grants.
TemporaryFileSystem=${opts.usersRoot}:ro
${binds.join('\n')}
# Never expose the gateway's own code/state to an instance.
InaccessiblePaths=-${opts.gatewayDir}

# ── resource limits ──
MemoryMax=${opts.memoryMax}
CPUQuota=${opts.cpuQuota}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`
}
