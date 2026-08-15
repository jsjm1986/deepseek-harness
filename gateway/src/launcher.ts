/**
 * Instance launch drivers behind one seam. `LocalLauncher` (macOS dev) spawns
 * plain subprocesses that die with the gateway; `SystemdLauncher` (Linux
 * production) renders one per-user confinement unit per start — grants become
 * kernel mount-namespace binds — and drives it through systemctl. A start
 * returns an {@link InstanceProc} handle; readiness stays the
 * InstanceManager's HTTP poll. systemctl runs through the injectable `run`
 * option so the driver's command sequence is unit-tested off a Linux host.
 * Per-user system accounts and directory ownership are provisioning concerns
 * (deploy/provision-user.sh), not launch-time work.
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { GatewayConfig } from './config.ts'
import { renderUserUnit, unitName, type GrantEntry, type SystemdOptions } from './systemd.ts'

/** Stable process identity and filesystem facts for one runtime. */
export interface RuntimeProcessIdentity {
  /** Runtime owner category. */
  kind: 'user' | 'project'
  /** Public numeric id of the runtime owner. */
  ownerId: number
  username: string
  /** Stable process/unit key. */
  runtimeKey: string
  /** Exact Linux account for systemd. */
  systemUser: string
  /** Whether the personal runtime receives administrator filesystem policy. */
  privileged?: boolean
  port: number
  /** Absolute writable home (also the instance cwd / workspace root). */
  homePath: string
  /** Absolute `$DSH_HOME` for this instance. */
  dshHome: string
}

/** Non-secret runtime facts available to policy projection. */
export interface RuntimePolicyIdentity extends RuntimeProcessIdentity {
  /** Monotonic instance generation assigned to this start. */
  generation: number
}

/** Launch-only facts, including the credential delivered through a private channel. */
export interface LaunchRuntime extends RuntimePolicyIdentity {
  gatewayCredential: string
}

/** Handle over one launched instance. */
export interface InstanceProc {
  /** Ask the instance to stop; escalate after `graceMs`. Resolves when the request completed. */
  terminate(graceMs: number): Promise<void>
  /**
   * Whether the underlying process is known to have exited. A systemd unit is
   * not tracked through this handle (systemd supervises it), so its handle
   * always answers false; liveness there is the manager's HTTP probe.
   */
  hasExited(): boolean
}

/** One instance launch driver. */
export interface Launcher {
  /** Launch (or restart) one instance and return its handle. */
  start(runtime: LaunchRuntime): Promise<InstanceProc>
  /**
   * Re-attach to an instance this gateway process did not start (present
   * after a gateway restart under systemd). Absent on drivers whose
   * instances cannot outlive the gateway.
   */
  attach?(runtime: RuntimeProcessIdentity): InstanceProc
  /** Whether instances survive a gateway shutdown (systemd) or must be stopped with it (local). */
  readonly instancesOutliveGateway: boolean
}

/** macOS dev driver: plain subprocesses tracked by their ChildProcess. */
export class LocalLauncher implements Launcher {
  readonly instancesOutliveGateway = false

  constructor(private readonly cfg: GatewayConfig) {}

  async start(runtime: LaunchRuntime): Promise<InstanceProc> {
    const argv = this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(runtime.port)))
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      cwd: runtime.homePath,
      env: {
        ...process.env,
        DSH_HOME: runtime.dshHome,
        DSH_GATEWAY_CREDENTIAL_FD: '3',
        // Source-run instances load TypeScript through tsx, which resolves
        // the workspace `paths` map from tsconfig — discovered from cwd,
        // which is the user home, OUTSIDE the repo. Point tsx at the repo
        // tsconfig explicitly; the pinned-npm production command has no tsx
        // and ignores the variable.
        TSX_TSCONFIG_PATH: join(this.cfg.dshRepoRoot, 'tsconfig.base.json'),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
    })
    const credentialPipe = child.stdio[3] as Writable | null | undefined
    if (credentialPipe === null || credentialPipe === undefined) {
      child.kill('SIGKILL')
      throw new Error(`runtime credential pipe unavailable for ${runtime.runtimeKey}`)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        credentialPipe.once('error', reject)
        credentialPipe.end(runtime.gatewayCredential, resolve)
      })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      throw new Error(`runtime credential delivery failed for ${runtime.runtimeKey}: ${String(error)}`)
    }
    return {
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      terminate: async (graceMs: number) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
        await exited
        clearTimeout(timer)
      },
    }
  }
}

/** Construction options for {@link SystemdLauncher}. */
export interface SystemdLauncherOptions {
  /** Unit-rendering facts shared by every user (see systemd.ts). */
  systemd: SystemdOptions
  /** Current effective grants for a username, rendered into mount binds. */
  grantsProvider: (runtime: RuntimePolicyIdentity) => GrantEntry[] | Promise<GrantEntry[]>
  /** Private host directory used as the source for systemd credentials. */
  credentialDir: string
  /** Unit directory the per-user unit files are written into. */
  unitDir?: string
  /** systemctl arguments runner; injectable for tests. */
  run?: (args: string[]) => Promise<void>
}

const runSystemctl = async (args: string[]): Promise<void> => {
  await promisify(execFile)('systemctl', args)
}

/**
 * Linux production driver: render the user's confinement unit from the
 * current grants, write it, `daemon-reload`, and `restart`. Restarting is
 * required because every launch rotates the runtime generation and credential.
 */
export class SystemdLauncher implements Launcher {
  readonly instancesOutliveGateway = true
  private readonly unitDir: string
  private readonly run: (args: string[]) => Promise<void>

  constructor(private readonly options: SystemdLauncherOptions) {
    this.unitDir = options.unitDir ?? '/etc/systemd/system'
    this.run = options.run ?? runSystemctl
  }

  async start(user: LaunchRuntime): Promise<InstanceProc> {
    // $DSH_HOME sits under the TemporaryFileSystem mask like the home, so it
    // must be re-bound writable too (session logs, settings, grants file);
    // the renderer itself only auto-binds the home.
    const { gatewayCredential, ...policyIdentity } = user
    const grants: GrantEntry[] = [
      { path: user.dshHome, mode: 'rw' },
      ...await this.options.grantsProvider(policyIdentity),
    ]
    mkdirSync(this.options.credentialDir, { recursive: true, mode: 0o700 })
    const credentialPath = join(
      this.options.credentialDir,
      `${user.runtimeKey}.${String(user.generation)}.${String(process.pid)}.credential`,
    )
    writeFileSync(credentialPath, gatewayCredential, { mode: 0o600, flag: 'wx' })
    try {
      writeFileSync(
        join(this.unitDir, unitName(user.runtimeKey)),
        renderUserUnit(user, grants, this.options.systemd, credentialPath),
      )
      await this.run(['daemon-reload'])
      await this.run(['restart', unitName(user.runtimeKey)])
    } finally {
      rmSync(credentialPath, { force: true })
    }
    return this.attach(user)
  }

  attach(user: RuntimeProcessIdentity): InstanceProc {
    return {
      hasExited: () => false,
      terminate: async () => { await this.run(['stop', unitName(user.runtimeKey)]) },
    }
  }
}

/**
 * Construct the launcher the config selects; the systemd options factory is
 * evaluated only when the systemd driver is actually chosen.
 * @param cfg - gateway config (`launcher` field).
 * @param systemdOptions - lazily builds the systemd driver's options.
 * @returns the driver behind the shared seam.
 */
export function selectLauncher(cfg: GatewayConfig, systemdOptions: () => SystemdLauncherOptions): Launcher {
  return cfg.launcher === 'systemd'
    ? new SystemdLauncher(systemdOptions())
    : new LocalLauncher(cfg)
}
