/**
 * Phase 2 (Linux production): render the per-user systemd unit that confines a
 * dsh instance to the user's granted directories via the kernel mount
 * namespace. For regular and project runtimes this is the authoritative
 * directory boundary across the whole process tree (bash, fs tools, MCP
 * servers), even if a session switches the in-app dsh sandbox off.
 * Administrators deliberately retain host visibility under their non-root
 * runtime account. The in-dsh `dsh-directory-guard` plugin is the
 * defense-in-depth layer above it (and the only layer on macOS, where systemd
 * is absent).
 *
 * Pure string generation: no filesystem or systemctl side effects, so the
 * grant→confinement mapping is fully unit-tested off a Linux host.
 */

import { posix } from 'node:path'

export interface SystemdOptions {
  /** Parent of all per-user directories, masked for non-privileged units then selectively re-bound. */
  usersRoot: string
  /** Parent of all host-owned project runtime homes. */
  projectRuntimesRoot: string
  /** Host roots containing every project directory exposed through grants. */
  projectPathRoots: readonly string[]
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
  kind?: 'user' | 'project'
  ownerId?: number
  username: string
  /** Unit identity when it differs from the human username. */
  runtimeKey?: string
  /** Exact Linux account; defaults to `harness-${username}`. */
  systemUser?: string
  /** Administrator policy removes managed-root masks and read-only system/home protection. */
  privileged?: boolean
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

function containsPath(root: string, path: string): boolean {
  const nested = posix.relative(root, path)
  return nested === '' || (!nested.startsWith('../') && nested !== '..' && !posix.isAbsolute(nested))
}

function strictlyContainsPath(root: string, path: string): boolean {
  return root !== path && containsPath(root, path)
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
export function renderUserUnit(
  user: SystemdUser,
  grants: readonly GrantEntry[],
  opts: SystemdOptions,
  gatewayCredentialPath?: string,
): string {
  const runtimeKey = user.runtimeKey ?? user.username
  if (!USERNAME_RE.test(runtimeKey)) throw new Error(`invalid runtime key: ${runtimeKey}`)
  const systemUser = user.systemUser ?? `harness-${user.username}`
  if (!USERNAME_RE.test(systemUser) || systemUser === 'root') throw new Error(`invalid system user: ${systemUser}`)
  for (const path of [
    user.homePath,
    user.dshHome,
    opts.usersRoot,
    opts.projectRuntimesRoot,
    ...opts.projectPathRoots,
    opts.gatewayDir,
  ]) assertSafePath(path)
  if (gatewayCredentialPath !== undefined) assertSafePath(gatewayCredentialPath)
  const privileged = user.kind !== 'project' && user.privileged === true
  if (user.kind === 'project') {
    if (!strictlyContainsPath(opts.projectRuntimesRoot, user.dshHome)) {
      throw new Error(`project dsh home is outside projectRuntimesRoot: ${user.dshHome}`)
    }
    if (!opts.projectPathRoots.some(root => strictlyContainsPath(root, user.homePath))) {
      throw new Error(`project home is outside projectPathRoots: ${user.homePath}`)
    }
  } else if (!strictlyContainsPath(opts.usersRoot, user.homePath)
    || !strictlyContainsPath(opts.usersRoot, user.dshHome)) {
    throw new Error(`user runtime paths are outside usersRoot: ${user.username}`)
  }

  const binds: string[] = []
  const seen = new Set<string>()
  for (const grant of grants) {
    assertSafePath(grant.path)
    const runtimeOwned = containsPath(user.homePath, grant.path) || containsPath(user.dshHome, grant.path)
    const projectPath = opts.projectPathRoots.some(root => strictlyContainsPath(root, grant.path))
    if (!privileged && !runtimeOwned && !projectPath) {
      throw new Error(`grant is outside managed roots: ${grant.path}`)
    }
    if (seen.has(grant.path)) continue
    seen.add(grant.path)
    binds.push(grant.mode === 'rw' ? `BindPaths=${grant.path}` : `BindReadOnlyPaths=${grant.path}`)
  }
  // The user home is always writable even if the caller omitted it from grants.
  if (!seen.has(user.homePath)) binds.unshift(`BindPaths=${user.homePath}`)
  const masks = privileged
    ? []
    : [...new Set([opts.usersRoot, opts.projectRuntimesRoot, ...opts.projectPathRoots])]
      .map(path => `TemporaryFileSystem=${path}:ro`)

  return `[Unit]
Description=DeepSeek Harness instance for ${runtimeKey}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${systemUser}
WorkingDirectory=${user.homePath}
Environment=HOME=${user.homePath}
Environment=DSH_HOME=${user.dshHome}
Environment=DSH_DIRECTORY_GRANTS=${user.dshHome}/directory-grants.json
${gatewayCredentialPath === undefined ? '' : `Environment=DSH_GATEWAY_CREDENTIAL_FILE=%d/dsh-gateway
LoadCredential=dsh-gateway:${gatewayCredentialPath}
`}ExecStart=${opts.execStart.replaceAll('{port}', String(user.port))}
Restart=on-failure
RestartSec=5

# ── kernel confinement (authoritative directory boundary) ──
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=${privileged ? 'off' : 'strict'}
ProtectHome=${privileged ? 'no' : 'tmpfs'}
CapabilityBoundingSet=~CAP_SYS_ADMIN
# Hide managed user, project-runtime, and project-data roots, then re-bind only this runtime's paths.
${masks.join('\n')}
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
