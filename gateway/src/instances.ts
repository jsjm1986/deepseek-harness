import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import {
  LocalLauncher,
  type InstanceProc,
  type Launcher,
  type RuntimePolicyIdentity,
} from './launcher.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000
const MANAGED_CREDENTIALS_FILENAME = '.credentials.yaml'
const ADMIN_GUARD_PATCH_FILENAME = 'cordis.admin.patch.yml'
const PROJECT_RUNTIME_PATCH = `- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: gateway-runtime
      name: '@deepseek-ai/dsh-gateway-runtime'
    - id: collaboration-gateway
      name: '@deepseek-ai/dsh-collaboration-gateway'
    - id: collaboration-context
      name: '@deepseek-ai/dsh-collaboration-context'
    - id: session-persistence-gateway
      name: '@deepseek-ai/dsh-session-persistence-gateway'
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
`

interface InstanceOwner {
  kind: 'user' | 'project'
  id: number
  username: string
  homePath: string
  name?: string
}

/** Durable instance owner. Numeric inputs remain the personal-runtime shorthand. */
export type RuntimeTarget = { kind: 'user'; id: number } | { kind: 'project'; id: number }
export type RuntimeTargetInput = RuntimeTarget | number

/** Project facts required to launch its shared runtime. */
export interface ProjectRuntime {
  kind: 'project'
  id: number
  name: string
  path: string
}

/** Fully resolved launch facts passed to policy projection and launch drivers. */
export interface RuntimeLaunchContext extends RuntimePolicyIdentity {
  target: RuntimeTarget
  user?: UserRow
  project?: ProjectRuntime
}

/** Host facts embedded into each private runtime credential. */
export interface RuntimeSecurityConfig {
  principalPublicKey: string
}

function targetOf(input: RuntimeTargetInput): RuntimeTarget {
  return typeof input === 'number' ? { kind: 'user', id: input } : input
}

function targetKey(input: RuntimeTargetInput): string {
  const target = targetOf(input)
  return `${target.kind}:${String(target.id)}`
}

/** Durable instance rows required by {@link InstanceManager}. */
export interface InstanceRepository {
  initialize(instancesOutliveGateway: boolean): Promise<void>
  portOf(target: RuntimeTarget): Promise<number>
  stateOf(target: RuntimeTarget): Promise<string>
  generationOf(target: RuntimeTarget): Promise<number>
  touch(target: RuntimeTarget, at: number): Promise<void>
  beginStart(target: RuntimeTarget, at: number, runtimeTokenHash: Buffer): Promise<number>
  markReady(target: RuntimeTarget, generation: number): Promise<void>
  idleTargets(cutoff: number): Promise<RuntimeTarget[]>
  markStopping(target: RuntimeTarget): Promise<void>
  markStopped(target: RuntimeTarget): Promise<void>
  owner(target: RuntimeTarget): Promise<InstanceOwner | null>
}

class SqliteInstanceRepository implements InstanceRepository {
  constructor(private readonly db: Database.Database) {}

  async initialize(instancesOutliveGateway: boolean): Promise<void> {
    if (!instancesOutliveGateway) this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL`).run()
  }

  private userId(target: RuntimeTarget): number {
    if (target.kind !== 'user') throw new Error('SQLite test repository has no project runtimes')
    return target.id
  }

  async portOf(target: RuntimeTarget): Promise<number> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT port FROM instances WHERE user_id = ?`).get(userId) as
      { port: number } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${userId}`)
    return row.port
  }

  async stateOf(target: RuntimeTarget): Promise<string> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT state FROM instances WHERE user_id = ?`).get(userId) as
      { state: string } | undefined
    return row?.state ?? 'stopped'
  }

  async generationOf(target: RuntimeTarget): Promise<number> {
    this.userId(target)
    return 1
  }

  async touch(target: RuntimeTarget, at: number): Promise<void> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(at, userId)
  }

  async beginStart(target: RuntimeTarget, at: number, _runtimeTokenHash: Buffer): Promise<number> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET state = 'starting', started_at = ?, last_activity_at = ? WHERE user_id = ?`)
      .run(at, at, userId)
    return 1
  }

  async markReady(target: RuntimeTarget, _generation: number): Promise<void> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET state = 'ready' WHERE user_id = ?`).run(userId)
  }

  async idleTargets(cutoff: number): Promise<RuntimeTarget[]> {
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'ready' AND last_activity_at < ?`,
    ).all(cutoff) as Array<{ user_id: number }>
    return rows.map(row => ({ kind: 'user' as const, id: row.user_id }))
  }

  async markStopping(target: RuntimeTarget): Promise<void> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET state = 'stopping' WHERE user_id = ?`).run(userId)
  }

  async markStopped(target: RuntimeTarget): Promise<void> {
    const userId = this.userId(target)
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(userId)
  }

  async owner(target: RuntimeTarget): Promise<InstanceOwner | null> {
    const userId = this.userId(target)
    const row = this.db.prepare(`SELECT id, username, home_path FROM users WHERE id = ?`).get(userId) as
      | { id: number; username: string; home_path: string }
      | undefined
    return row === undefined ? null : { kind: 'user', id: row.id, username: row.username, homePath: row.home_path }
  }
}

export class InstanceManager {
  private readonly launcher: Launcher
  private readonly repository: InstanceRepository
  private readonly initialized: Promise<void>
  private readonly procs = new Map<string, InstanceProc>()
  private readonly wsRefs = new Map<string, number>()
  /** Per-runtime operation chain: serializes start vs stop so a reap cannot orphan a fresh spawn. */
  private readonly ops = new Map<string, Promise<unknown>>()

  /**
   * Called with the resolved runtime just before it is spawned, on every start.
   * The wiring uses it to write the per-instance directory-grants file so the
   * grants handoff is intrinsic to starting an instance rather than a caller's
   * responsibility.
   */
  beforeStart?: (runtime: RuntimeLaunchContext) => void | Promise<void>

  constructor(
    source: Database.Database | InstanceRepository,
    private readonly cfg: GatewayConfig,
    launcher?: Launcher,
    private readonly security: RuntimeSecurityConfig = { principalPublicKey: '' },
  ) {
    this.repository = 'prepare' in source ? new SqliteInstanceRepository(source) : source
    this.launcher = launcher ?? new LocalLauncher(cfg)
    this.initialized = this.repository.initialize(this.launcher.instancesOutliveGateway)
  }

  async portOf(target: RuntimeTargetInput): Promise<number> {
    await this.initialized
    return this.repository.portOf(targetOf(target))
  }

  async stateOf(target: RuntimeTargetInput): Promise<string> {
    await this.initialized
    return this.repository.stateOf(targetOf(target))
  }

  async generationOf(target: RuntimeTargetInput): Promise<number> {
    await this.initialized
    return this.repository.generationOf(targetOf(target))
  }

  /**
   * Whether this process still holds a live child for a `ready` row.
   * A crashed or externally killed child leaves the row `ready`; callers must
   * treat that as not live and go through {@link ensureRunning}. systemd
   * handles always answer true while the row is `ready` — that driver does
   * not track the unit through this handle.
   * @param userId - instance owner
   * @returns true only when the row is `ready` and the tracked child has not exited
   */
  async isLive(target: RuntimeTargetInput): Promise<boolean> {
    const proc = this.procs.get(targetKey(target))
    return await this.stateOf(target) === 'ready' && proc !== undefined && !proc.hasExited()
  }

  async touch(target: RuntimeTargetInput): Promise<void> {
    await this.initialized
    await this.repository.touch(targetOf(target), Date.now())
  }

  async wsRef(target: RuntimeTargetInput, delta: 1 | -1): Promise<void> {
    const key = targetKey(target)
    this.wsRefs.set(key, Math.max(0, (this.wsRefs.get(key) ?? 0) + delta))
    if (delta === -1) await this.touch(target)
  }

  /** Run `fn` after any in-flight start/stop for this runtime has settled. */
  private serialize<T>(target: RuntimeTargetInput, fn: () => Promise<T>): Promise<T> {
    const key = targetKey(target)
    const prev = this.ops.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.ops.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  private async launchContext(subject: UserRow | ProjectRuntime): Promise<Omit<RuntimeLaunchContext, 'generation'>> {
    if ('username' in subject) {
      const target: RuntimeTarget = { kind: 'user', id: subject.id }
      return {
        kind: 'user',
        ownerId: subject.id,
        target,
        user: subject,
        username: subject.username,
        runtimeKey: subject.username,
        systemUser: `harness-${subject.username}`,
        privileged: subject.role === 'admin',
        port: await this.portOf(target),
        homePath: subject.homePath,
        dshHome: join(this.cfg.usersRoot, subject.username, 'dsh'),
      }
    }
    const target: RuntimeTarget = { kind: 'project', id: subject.id }
    return {
      kind: 'project',
      ownerId: subject.id,
      target,
      project: subject,
      username: `project-${String(subject.id)}`,
      runtimeKey: `project-${String(subject.id)}`,
      systemUser: this.cfg.projectRuntimeUser,
      privileged: false,
      port: await this.portOf(target),
      homePath: subject.path,
      dshHome: join(this.cfg.projectRuntimesRoot, String(subject.id), 'dsh'),
    }
  }

  async ensureRunning(subject: UserRow | ProjectRuntime): Promise<{ port: number; generation: number }> {
    const target: RuntimeTarget = 'username' in subject
      ? { kind: 'user', id: subject.id }
      : { kind: 'project', id: subject.id }
    return this.serialize(target, async () => {
      const port = await this.portOf(target)
      const proc = this.procs.get(targetKey(target))
      if (await this.stateOf(target) === 'ready' && proc !== undefined && !proc.hasExited()) {
        return { port, generation: await this.repository.generationOf(target) }
      }
      return this.start(await this.launchContext(subject), port)
    })
  }

  /**
   * Mount the mandatory model-governance bundle and, when configured, the
   * independent directory-guard bundle. Their patch sequences are composed
   * into the one home-level patch file dsh loads. Turning the directory guard
   * off must never turn model authorization or usage accounting off.
   */
  private mountPolicyBundles(runtime: RuntimeLaunchContext): void {
    const governanceDir = this.cfg.modelGovernancePackage
    const governancePatch = join(governanceDir, 'cordis.patch.yml')
    if (!existsSync(join(governanceDir, 'package.json')) || !existsSync(governancePatch)) {
      throw new Error(`model-governance package is incomplete: ${governanceDir}`)
    }

    const dshHome = runtime.dshHome
    const linkParent = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    mkdirSync(linkParent, { recursive: true })
    try {
      const governanceLink = join(linkParent, 'dsh-model-governance')
      if (lstatSync(governanceLink, { throwIfNoEntry: false }) !== undefined) rmSync(governanceLink, { recursive: true })
      symlinkSync(governanceDir, governanceLink, 'dir')

      let patchText = readFileSync(governancePatch, 'utf8').trimEnd() + '\n'
      const guardPatch = this.cfg.guardPatch
      if (guardPatch !== '') {
        if (!existsSync(guardPatch)) {
          throw new Error(`directory-guard patch not found: ${guardPatch} (set HGW_GUARD_PATCH=off to disable)`)
        }
        const guardDir = dirname(guardPatch)
        const guardLink = join(linkParent, 'dsh-directory-guard')
        if (lstatSync(guardLink, { throwIfNoEntry: false }) !== undefined) rmSync(guardLink, { recursive: true })
        symlinkSync(guardDir, guardLink, 'dir')
        patchText += readFileSync(guardPatch, 'utf8').trimEnd() + '\n'
        if (runtime.user?.role === 'admin') {
          const adminPatch = join(guardDir, ADMIN_GUARD_PATCH_FILENAME)
          if (!existsSync(adminPatch)) {
            throw new Error(`directory-guard admin patch not found: ${adminPatch}`)
          }
          patchText += readFileSync(adminPatch, 'utf8').trimEnd() + '\n'
        }
      }
      if (runtime.kind === 'project') patchText += PROJECT_RUNTIME_PATCH
      writeFileSync(join(dshHome, 'cordis.patch.yml'), patchText)
    } catch (error) {
      throw new Error(`policy bundle mount failed for ${runtime.runtimeKey ?? runtime.username}: ${String(error)}`)
    }
  }

  /**
   * Copy the company default credentials file to the instance's
   * `$DSH_HOME/.env` (the dsh user-env layer). Refreshed every start so a
   * rotated company key propagates. Personal runtimes retain their managed
   * override; project runtimes remove it and expose credential writes as read-only.
   */
  private seedDefaultEnv(runtime: RuntimeLaunchContext): void {
    if (runtime.kind === 'project') {
      rmSync(join(runtime.dshHome, MANAGED_CREDENTIALS_FILENAME), { force: true })
    }
    const source = this.cfg.defaultEnvFile
    if (source === '') return
    if (!existsSync(source)) throw new Error(`default env file not found: ${source} (unset HGW_DEFAULT_ENV_FILE to disable)`)
    const dshHome = runtime.dshHome
    mkdirSync(dshHome, { recursive: true })
    copyFileSync(source, join(dshHome, '.env'))
  }

  private async start(
    descriptor: Omit<RuntimeLaunchContext, 'generation'>,
    port: number,
  ): Promise<{ port: number; generation: number }> {
    // Mount policy bundles first: a missing mandatory policy must refuse the
    // start before any state transition, not strand the row in 'starting'.
    this.mountPolicyBundles({ ...descriptor, generation: 0 })
    this.seedDefaultEnv({ ...descriptor, generation: 0 })
    const now = Date.now()
    const runtimeToken = randomBytes(32).toString('base64url')
    const generation = await this.repository.beginStart(
      descriptor.target,
      now,
      createHash('sha256').update(runtimeToken).digest(),
    )
    const runtime: RuntimeLaunchContext = { ...descriptor, generation }
    await this.beforeStart?.(runtime)
    const gatewayCredential = JSON.stringify({
      version: 1,
      gatewayUrl: `http://127.0.0.1:${String(this.cfg.port)}`,
      organization: this.cfg.organizationSlug,
      runtime: { kind: runtime.kind, id: runtime.ownerId, generation },
      token: runtimeToken,
      principalPublicKey: this.security.principalPublicKey,
    })
    const proc = await this.launcher.start({ ...runtime, gatewayCredential })
    const key = targetKey(runtime.target)
    this.procs.set(key, proc)

    const deadline = Date.now() + this.cfg.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (proc.hasExited()) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          await this.repository.markReady(runtime.target, generation)
          return { port, generation }
        }
      } catch { /* not up yet */ }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    // Already inside the serialized op — terminate directly (calling the public
    // serialized stop here would deadlock on this same user's chain).
    await this.terminate(runtime.target)
    throw new Error(`instance for ${runtime.runtimeKey ?? runtime.username} failed to become ready on port ${port}`)
  }

  async reapIdle(): Promise<number> {
    await this.initialized
    const cutoff = Date.now() - this.cfg.idleTimeoutMs
    const targets = await this.repository.idleTargets(cutoff)
    let stopped = 0
    for (const target of targets) {
      if ((this.wsRefs.get(targetKey(target)) ?? 0) > 0) continue
      await this.stop(target)
      stopped += 1
    }
    return stopped
  }

  async stop(target: RuntimeTargetInput): Promise<void> {
    return this.withStopped(target, async () => {})
  }

  /**
   * Stop one runtime and keep its operation slot until the supplied work settles.
   * @param target - runtime whose starts and stops remain serialized
   * @param operation - work that requires the runtime to remain stopped
   * @returns the operation result
   */
  async withStopped<T>(target: RuntimeTargetInput, operation: () => Promise<T>): Promise<T> {
    return this.serialize(target, async () => {
      await this.terminate(targetOf(target))
      return operation()
    })
  }

  /**
   * Terminate via the tracked handle, or re-attach first for an instance a
   * previous gateway process started (systemd survivors). Assumes the caller
   * holds the per-user op slot.
   */
  private async terminate(target: RuntimeTarget): Promise<void> {
    await this.initialized
    await this.repository.markStopping(target)
    const key = targetKey(target)
    let proc = this.procs.get(key)
    if (proc === undefined && this.launcher.attach !== undefined) {
      const row = await this.repository.owner(target)
      if (row !== null) {
        const runtimeKey = row.kind === 'user' ? row.username : `project-${String(row.id)}`
        proc = this.launcher.attach({
          kind: row.kind,
          ownerId: row.id,
          username: row.username,
          runtimeKey,
          systemUser: row.kind === 'user' ? `harness-${row.username}` : this.cfg.projectRuntimeUser,
          port: await this.portOf(target),
          homePath: row.homePath,
          dshHome: row.kind === 'user'
            ? join(this.cfg.usersRoot, row.username, 'dsh')
            : join(this.cfg.projectRuntimesRoot, String(row.id), 'dsh'),
        })
      }
    }
    if (proc !== undefined) await proc.terminate(STOP_GRACE_MS)
    this.procs.delete(key)
    await this.repository.markStopped(target)
  }

  async stopAll(): Promise<void> {
    // Local children must not outlive the gateway; systemd units stay up
    // across a gateway restart by design.
    if (this.launcher.instancesOutliveGateway) return
    const targets = await Promise.all([...this.procs.keys()].map(async (key) => {
      const [kind, rawId] = key.split(':')
      const id = Number(rawId)
      if ((kind !== 'user' && kind !== 'project') || !Number.isSafeInteger(id)) {
        throw new Error(`invalid runtime process key ${key}`)
      }
      return { kind, id } as RuntimeTarget
    }))
    await Promise.all(targets.map(target => this.stop(target)))
  }
}
