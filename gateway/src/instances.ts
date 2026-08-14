import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { LocalLauncher, type InstanceProc, type Launcher, type LaunchUser } from './launcher.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000

interface InstanceOwner {
  id: number
  username: string
  homePath: string
}

/** Durable instance rows required by {@link InstanceManager}. */
export interface InstanceRepository {
  initialize(instancesOutliveGateway: boolean): Promise<void>
  portOf(userId: number): Promise<number>
  stateOf(userId: number): Promise<string>
  touch(userId: number, at: number): Promise<void>
  markStarting(userId: number, at: number): Promise<void>
  markReady(userId: number): Promise<void>
  idleUserIds(cutoff: number): Promise<number[]>
  markStopping(userId: number): Promise<void>
  markStopped(userId: number): Promise<void>
  owner(userId: number): Promise<InstanceOwner | null>
}

class SqliteInstanceRepository implements InstanceRepository {
  constructor(private readonly db: Database.Database) {}

  async initialize(instancesOutliveGateway: boolean): Promise<void> {
    if (!instancesOutliveGateway) this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL`).run()
  }

  async portOf(userId: number): Promise<number> {
    const row = this.db.prepare(`SELECT port FROM instances WHERE user_id = ?`).get(userId) as
      { port: number } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${userId}`)
    return row.port
  }

  async stateOf(userId: number): Promise<string> {
    const row = this.db.prepare(`SELECT state FROM instances WHERE user_id = ?`).get(userId) as
      { state: string } | undefined
    return row?.state ?? 'stopped'
  }

  async touch(userId: number, at: number): Promise<void> {
    this.db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(at, userId)
  }

  async markStarting(userId: number, at: number): Promise<void> {
    this.db.prepare(`UPDATE instances SET state = 'starting', started_at = ?, last_activity_at = ? WHERE user_id = ?`)
      .run(at, at, userId)
  }

  async markReady(userId: number): Promise<void> {
    this.db.prepare(`UPDATE instances SET state = 'ready' WHERE user_id = ?`).run(userId)
  }

  async idleUserIds(cutoff: number): Promise<number[]> {
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'ready' AND last_activity_at < ?`,
    ).all(cutoff) as Array<{ user_id: number }>
    return rows.map(row => row.user_id)
  }

  async markStopping(userId: number): Promise<void> {
    this.db.prepare(`UPDATE instances SET state = 'stopping' WHERE user_id = ?`).run(userId)
  }

  async markStopped(userId: number): Promise<void> {
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(userId)
  }

  async owner(userId: number): Promise<InstanceOwner | null> {
    const row = this.db.prepare(`SELECT id, username, home_path FROM users WHERE id = ?`).get(userId) as
      | { id: number; username: string; home_path: string }
      | undefined
    return row === undefined ? null : { id: row.id, username: row.username, homePath: row.home_path }
  }
}

export class InstanceManager {
  private readonly launcher: Launcher
  private readonly repository: InstanceRepository
  private readonly initialized: Promise<void>
  private readonly procs = new Map<number, InstanceProc>()
  private readonly wsRefs = new Map<number, number>()
  /** Per-user operation chain: serializes start vs stop so a reap cannot orphan a fresh spawn. */
  private readonly ops = new Map<number, Promise<unknown>>()

  /**
   * Called with the user just before its instance is spawned, on every start.
   * The wiring uses it to write the per-instance directory-grants file so the
   * grants handoff is intrinsic to starting an instance rather than a caller's
   * responsibility.
   */
  beforeStart?: (user: UserRow) => void | Promise<void>

  constructor(source: Database.Database | InstanceRepository, private readonly cfg: GatewayConfig, launcher?: Launcher) {
    this.repository = 'prepare' in source ? new SqliteInstanceRepository(source) : source
    this.launcher = launcher ?? new LocalLauncher(cfg)
    this.initialized = this.repository.initialize(this.launcher.instancesOutliveGateway)
  }

  async portOf(userId: number): Promise<number> {
    await this.initialized
    return this.repository.portOf(userId)
  }

  async stateOf(userId: number): Promise<string> {
    await this.initialized
    return this.repository.stateOf(userId)
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
  async isLive(userId: number): Promise<boolean> {
    const proc = this.procs.get(userId)
    return await this.stateOf(userId) === 'ready' && proc !== undefined && !proc.hasExited()
  }

  async touch(userId: number): Promise<void> {
    await this.initialized
    await this.repository.touch(userId, Date.now())
  }

  async wsRef(userId: number, delta: 1 | -1): Promise<void> {
    this.wsRefs.set(userId, Math.max(0, (this.wsRefs.get(userId) ?? 0) + delta))
    if (delta === -1) await this.touch(userId)
  }

  /** Run `fn` after any in-flight start/stop for this user has settled. */
  private serialize<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(userId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.ops.set(userId, run.then(() => undefined, () => undefined))
    return run
  }

  private async launchUser(user: UserRow): Promise<LaunchUser> {
    return {
      username: user.username,
      port: await this.portOf(user.id),
      homePath: user.homePath,
      dshHome: join(this.cfg.usersRoot, user.username, 'dsh'),
    }
  }

  async ensureRunning(user: UserRow): Promise<{ port: number }> {
    return this.serialize(user.id, async () => {
      const port = await this.portOf(user.id)
      const proc = this.procs.get(user.id)
      if (await this.stateOf(user.id) === 'ready' && proc !== undefined && !proc.hasExited()) return { port }
      return this.start(user, port)
    })
  }

  /**
   * Mount the mandatory model-governance bundle and, when configured, the
   * independent directory-guard bundle. Their patch sequences are composed
   * into the one home-level patch file dsh loads. Turning the directory guard
   * off must never turn model authorization or usage accounting off.
   */
  private mountPolicyBundles(user: UserRow): void {
    const governanceDir = this.cfg.modelGovernancePackage
    const governancePatch = join(governanceDir, 'cordis.patch.yml')
    if (!existsSync(join(governanceDir, 'package.json')) || !existsSync(governancePatch)) {
      throw new Error(`model-governance package is incomplete: ${governanceDir}`)
    }

    const dshHome = join(this.cfg.usersRoot, user.username, 'dsh')
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
      }
      writeFileSync(join(dshHome, 'cordis.patch.yml'), patchText)
    } catch (error) {
      throw new Error(`policy bundle mount failed for ${user.username}: ${String(error)}`)
    }
  }

  /**
   * Copy the company default credentials file to the instance's
   * `$DSH_HOME/.env` (the dsh user-env layer). Refreshed every start so a
   * rotated company key propagates; a personal key set from the instance's
   * Settings lives in the managed `.credentials.yaml`, which outranks this
   * layer, so seeding never overrides it.
   */
  private seedDefaultEnv(user: UserRow): void {
    const source = this.cfg.defaultEnvFile
    if (source === '') return
    if (!existsSync(source)) throw new Error(`default env file not found: ${source} (unset HGW_DEFAULT_ENV_FILE to disable)`)
    const dshHome = join(this.cfg.usersRoot, user.username, 'dsh')
    mkdirSync(dshHome, { recursive: true })
    copyFileSync(source, join(dshHome, '.env'))
  }

  private async start(user: UserRow, port: number): Promise<{ port: number }> {
    // Mount policy bundles first: a missing mandatory policy must refuse the
    // start before any state transition, not strand the row in 'starting'.
    this.mountPolicyBundles(user)
    this.seedDefaultEnv(user)
    const now = Date.now()
    await this.repository.markStarting(user.id, now)
    await this.beforeStart?.(user)
    const proc = await this.launcher.start(await this.launchUser(user))
    this.procs.set(user.id, proc)

    const deadline = Date.now() + this.cfg.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (proc.hasExited()) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          await this.repository.markReady(user.id)
          return { port }
        }
      } catch { /* not up yet */ }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    // Already inside the serialized op — terminate directly (calling the public
    // serialized stop here would deadlock on this same user's chain).
    await this.terminate(user.id)
    throw new Error(`instance for ${user.username} failed to become ready on port ${port}`)
  }

  async reapIdle(): Promise<number> {
    await this.initialized
    const cutoff = Date.now() - this.cfg.idleTimeoutMs
    const userIds = await this.repository.idleUserIds(cutoff)
    let stopped = 0
    for (const userId of userIds) {
      if ((this.wsRefs.get(userId) ?? 0) > 0) continue
      await this.stop(userId)
      stopped += 1
    }
    return stopped
  }

  async stop(userId: number): Promise<void> {
    return this.serialize(userId, () => this.terminate(userId))
  }

  /**
   * Terminate via the tracked handle, or re-attach first for an instance a
   * previous gateway process started (systemd survivors). Assumes the caller
   * holds the per-user op slot.
   */
  private async terminate(userId: number): Promise<void> {
    await this.initialized
    await this.repository.markStopping(userId)
    let proc = this.procs.get(userId)
    if (proc === undefined && this.launcher.attach !== undefined) {
      const row = await this.repository.owner(userId)
      if (row !== null) {
        proc = this.launcher.attach({
          username: row.username,
          port: await this.portOf(userId),
          homePath: row.homePath,
          dshHome: join(this.cfg.usersRoot, row.username, 'dsh'),
        })
      }
    }
    if (proc !== undefined) await proc.terminate(STOP_GRACE_MS)
    this.procs.delete(userId)
    await this.repository.markStopped(userId)
  }

  async stopAll(): Promise<void> {
    // Local children must not outlive the gateway; systemd units stay up
    // across a gateway restart by design.
    if (this.launcher.instancesOutliveGateway) return
    await Promise.all([...this.procs.keys()].map(id => this.stop(id)))
  }
}
