/**
 * Instance launch drivers behind one seam: `child` (macOS dev — plain
 * subprocesses that die with the gateway) and `systemd` (Linux production —
 * per-user template units with kernel mount-namespace confinement). The
 * InstanceManager owns DB state, serialization, readiness polling, and idle
 * reaping; a launcher owns only how a process comes up, is probed, and goes
 * away. systemctl/useradd run through an injectable exec so the driver's
 * command sequences are unit-tested off a Linux host.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { chownSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { renderUserUnit, unitName, type GrantEntry } from './systemd.ts'

/** How an instance process is launched, probed, and terminated. */
export interface InstanceLauncher {
  /** Issue the launch (readiness stays the manager's HTTP poll). */
  start(user: UserRow, port: number): Promise<void>
  /** Whether the underlying process/unit is currently alive. */
  isRunning(user: UserRow): Promise<boolean>
  /** Terminate the user's instance and resolve when it is gone. */
  stop(user: UserRow): Promise<void>
  /**
   * Gateway shutdown hook. Child processes die with the gateway so they are
   * stopped here; systemd units deliberately survive a gateway restart.
   */
  stopAll(users: UserRow[]): Promise<void>
}

const STOP_GRACE_MS = 5000

/** macOS dev driver: plain subprocesses tracked in-memory. */
export class ChildLauncher implements InstanceLauncher {
  private readonly children = new Map<number, ChildProcess>()

  constructor(
    private readonly cfg: GatewayConfig,
    /** Called when a tracked child exits on its own (crash or external kill). */
    private readonly onExit: (userId: number) => void,
  ) {}

  async start(user: UserRow, port: number): Promise<void> {
    const argv = this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(port)))
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      cwd: user.homePath,
      env: {
        ...process.env,
        DSH_HOME: join(this.cfg.usersRoot, user.username, 'dsh'),
        // Source-run instances load TypeScript through tsx, which resolves the
        // workspace `paths` map from tsconfig — discovered from cwd, which is
        // the user home, OUTSIDE the repo. Point tsx at the repo tsconfig
        // explicitly; the pinned-npm production command has no tsx and
        // ignores the variable.
        TSX_TSCONFIG_PATH: join(this.cfg.dshRepoRoot, 'tsconfig.base.json'),
      },
      stdio: 'ignore',
    })
    this.children.set(user.id, child)
    child.on('exit', () => {
      if (this.children.get(user.id) === child) {
        this.children.delete(user.id)
        this.onExit(user.id)
      }
    })
  }

  async isRunning(user: UserRow): Promise<boolean> {
    const child = this.children.get(user.id)
    return child !== undefined && child.exitCode === null
  }

  async stop(user: UserRow): Promise<void> {
    const child = this.children.get(user.id)
    if (child !== undefined && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(timer)
    }
    this.children.delete(user.id)
  }

  async stopAll(users: UserRow[]): Promise<void> {
    await Promise.all(users.map(user => this.stop(user)))
  }
}

/** Minimal exec facade the systemd driver needs; injectable for unit tests. */
export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>

const realExec: ExecFn = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args)
  return { stdout }
}

/**
 * Linux production driver: one rendered unit file per user under
 * `cfg.systemdUnitDir`, refreshed on every start so grant changes take effect
 * on the next restart; a per-user system account and the user's directory
 * layout are ensured idempotently before the first launch.
 */
export class SystemdLauncher implements InstanceLauncher {
  constructor(
    private readonly cfg: GatewayConfig,
    /** Current effective grants for a user (gateway DB), rendered into binds. */
    private readonly effectiveGrants: (userId: number) => GrantEntry[],
    private readonly exec: ExecFn = realExec,
  ) {}

  private systemAccount(username: string): string {
    return `harness-${username}`
  }

  private async ensureSystemUser(username: string): Promise<void> {
    const account = this.systemAccount(username)
    try {
      await this.exec('id', ['-u', account])
    } catch {
      await this.exec('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', account])
    }
  }

  /** Home and $DSH_HOME must exist and belong to the instance account before the unit binds them. */
  private async ensureLayout(user: UserRow): Promise<void> {
    const dshHome = join(this.cfg.usersRoot, user.username, 'dsh')
    mkdirSync(user.homePath, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    const owner = (await this.exec('id', ['-u', this.systemAccount(user.username)])).stdout.trim()
    const group = (await this.exec('id', ['-g', this.systemAccount(user.username)])).stdout.trim()
    for (const dir of [join(this.cfg.usersRoot, user.username), user.homePath, dshHome]) {
      chownSync(dir, Number(owner), Number(group))
    }
  }

  async start(user: UserRow, port: number): Promise<void> {
    await this.ensureSystemUser(user.username)
    await this.ensureLayout(user)
    const dshHome = join(this.cfg.usersRoot, user.username, 'dsh')
    // $DSH_HOME sits under the TemporaryFileSystem mask like the home, so it
    // must be re-bound writable too (session logs, settings, grants file).
    const grants: GrantEntry[] = [
      { path: dshHome, mode: 'rw' },
      ...this.effectiveGrants(user.id),
    ]
    const unit = renderUserUnit(
      { username: user.username, port, homePath: user.homePath, dshHome },
      grants,
      {
        usersRoot: this.cfg.usersRoot,
        execStart: this.cfg.dshCommand.join(' '),
        gatewayDir: this.cfg.gatewayDir,
        memoryMax: this.cfg.memoryMax,
        cpuQuota: this.cfg.cpuQuota,
      },
    )
    writeFileSync(join(this.cfg.systemdUnitDir, unitName(user.username)), unit)
    await this.exec('systemctl', ['daemon-reload'])
    // restart, not start: the unit content may have just changed (grants).
    await this.exec('systemctl', ['restart', unitName(user.username)])
  }

  async isRunning(user: UserRow): Promise<boolean> {
    try {
      await this.exec('systemctl', ['is-active', '--quiet', unitName(user.username)])
      return true
    } catch {
      return false
    }
  }

  async stop(user: UserRow): Promise<void> {
    // Absent unit files answer with a clean "not loaded" failure; treat any
    // stop error on a non-running unit as already stopped.
    try {
      await this.exec('systemctl', ['stop', unitName(user.username)])
    } catch {
      if (await this.isRunning(user)) throw new Error(`systemctl stop failed for ${user.username}`)
    }
  }

  /** Gateway restarts must not take user instances down: units keep running. */
  async stopAll(): Promise<void> {}
}

/**
 * Construct the launcher the config selects.
 * @param cfg - gateway config (`launcher` field).
 * @param deps - callbacks the drivers need.
 * @returns the driver behind the shared seam.
 */
export function makeLauncher(
  cfg: GatewayConfig,
  deps: { onExit: (userId: number) => void; effectiveGrants: (userId: number) => GrantEntry[] },
): InstanceLauncher {
  return cfg.launcher === 'systemd'
    ? new SystemdLauncher(cfg, deps.effectiveGrants)
    : new ChildLauncher(cfg, deps.onExit)
}

/** Re-exported for callers that pre-create the unit dir. */
export { unitName }

/** True when the platform can host the systemd driver at all. */
export function systemdAvailable(): boolean {
  return process.platform === 'linux' && existsSync('/run/systemd/system')
}
