import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface GatewayConfig {
  port: number
  publicOrigins: string[]
  dataDir: string
  usersRoot: string
  dshCommand: string[]
  dshRepoRoot: string
  instancePortBase: number
  idleTimeoutMs: number
  readinessTimeoutMs: number
  sessionTtlMs: number
  sessionAbsoluteTtlMs: number
  secureCookies: boolean
  /** Instance launch backend: `local` child process (dev) or `systemd` (Linux prod). */
  launcher: 'local' | 'systemd'
  /** systemd MemoryMax per instance (systemd launcher only). */
  memoryMax: string
  /** systemd CPUQuota per instance (systemd launcher only). */
  cpuQuota: string
  /** Gateway install/data dir made inaccessible to instances (systemd launcher only). */
  gatewayDir: string
  /** Unit directory the systemd launcher writes per-user unit files into. */
  systemdUnitDir: string
  /**
   * Absolute path of the dsh-directory-guard bundle patch mounted into every
   * instance's home patch layer, or '' to disable (HGW_GUARD_PATCH=off). The
   * plugin package is expected beside the patch file; the instance manager
   * links it into the instance's profile node_modules so the loader can
   * resolve it.
   */
  guardPatch: string
  /**
   * Company default credentials file copied to each instance's
   * `$DSH_HOME/.env` on every start ('' = no seeding). dsh reads it as the
   * user-env layer, which the managed `.credentials.yaml` (a user's personal
   * key set from Settings) outranks — so seeding never clobbers a personal
   * key, while a rotated company key reaches instances on their next start.
   */
  defaultEnvFile: string
}

const gatewayRoot = resolve(import.meta.dirname, '..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.HGW_PORT ?? 8899)
  const publicOrigins = (env.HGW_PUBLIC_ORIGINS ?? `http://127.0.0.1:${port}`)
    .split(',').map(s => s.trim()).filter(Boolean)
  const dshRepoRoot = env.HGW_DSH_REPO_ROOT ?? resolve(gatewayRoot, '..')
  // The default source-run entry is resolved to ABSOLUTE paths against
  // dshRepoRoot: instances spawn with cwd = user home (outside the repo), so
  // neither a relative `apps/cli/src/bin.ts` nor the bare `tsx/esm` specifier
  // would resolve from there. Production overrides this with HGW_DSH_COMMAND
  // pointing at the pinned npm `dsh` binary and never touches tsx.
  const resolveTsx = (): string => {
    try {
      return createRequire(join(dshRepoRoot, 'package.json')).resolve('tsx/esm')
    } catch {
      // No tsx under dshRepoRoot (tests replace dshCommand; production sets
      // HGW_DSH_COMMAND): keep the bare specifier so a failure surfaces at
      // spawn only if this default command is actually exercised.
      return 'tsx/esm'
    }
  }
  const dshCommand = env.HGW_DSH_COMMAND?.split(' ')
    ?? ['node', '--import', resolveTsx(), join(dshRepoRoot, 'apps/cli/src/bin.ts'), 'web', '--port', '{port}']
  const guardPatch = env.HGW_GUARD_PATCH === 'off'
    ? ''
    : env.HGW_GUARD_PATCH ?? join(dshRepoRoot, 'plugins/dsh-directory-guard/cordis.patch.yml')
  return {
    port,
    publicOrigins,
    dataDir: env.HGW_DATA_DIR ?? join(gatewayRoot, 'data'),
    usersRoot: env.HGW_USERS_ROOT ?? join(homedir(), 'harness-users'),
    dshCommand,
    dshRepoRoot,
    instancePortBase: Number(env.HGW_INSTANCE_PORT_BASE ?? 42000),
    idleTimeoutMs: Number(env.HGW_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000),
    readinessTimeoutMs: Number(env.HGW_READINESS_TIMEOUT_MS ?? 30 * 1000),
    sessionTtlMs: Number(env.HGW_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    sessionAbsoluteTtlMs: Number(env.HGW_SESSION_ABS_TTL_MS ?? 30 * 24 * 3600 * 1000),
    secureCookies: publicOrigins.some(o => o.startsWith('https://')),
    launcher: env.HGW_LAUNCHER === 'systemd' ? 'systemd' : 'local',
    memoryMax: env.HGW_MEMORY_MAX ?? '1G',
    cpuQuota: env.HGW_CPU_QUOTA ?? '100%',
    gatewayDir: env.HGW_GATEWAY_DIR ?? gatewayRoot,
    systemdUnitDir: env.HGW_SYSTEMD_UNIT_DIR ?? '/etc/systemd/system',
    guardPatch,
    defaultEnvFile: env.HGW_DEFAULT_ENV_FILE ?? '',
  }
}
