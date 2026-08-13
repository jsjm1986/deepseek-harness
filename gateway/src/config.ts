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
}

const gatewayRoot = resolve(import.meta.dirname, '..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.HGW_PORT ?? 8899)
  const publicOrigins = (env.HGW_PUBLIC_ORIGINS ?? `http://127.0.0.1:${port}`)
    .split(',').map(s => s.trim()).filter(Boolean)
  const dshRepoRoot = env.HGW_DSH_REPO_ROOT ?? resolve(gatewayRoot, '..')
  // The default source-run entry is resolved to an ABSOLUTE path against
  // dshRepoRoot: instances spawn with cwd = user home, so a relative
  // `apps/cli/src/bin.ts` would not resolve. Production overrides this with
  // HGW_DSH_COMMAND pointing at the pinned npm `dsh` binary.
  const dshCommand = env.HGW_DSH_COMMAND?.split(' ')
    ?? ['node', '--import', 'tsx/esm', join(dshRepoRoot, 'apps/cli/src/bin.ts'), 'web', '--port', '{port}']
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
  }
}
