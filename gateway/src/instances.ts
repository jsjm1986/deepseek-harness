import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { LocalLauncher, type InstanceProc, type Launcher, type LaunchUser } from './launcher.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000

export class InstanceManager {
  private readonly launcher: Launcher
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
  beforeStart?: (user: UserRow) => void

  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig, launcher?: Launcher) {
    this.launcher = launcher ?? new LocalLauncher(cfg)
    // Local children died with the previous gateway process; systemd units
    // survive it, and their rows re-converge through ensureRunning's probe.
    if (!this.launcher.instancesOutliveGateway) {
      this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL`).run()
    }
  }

  private markStopped(userId: number): void {
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(userId)
  }

  portOf(userId: number): number {
    const row = this.db.prepare(`SELECT port FROM instances WHERE user_id = ?`).get(userId) as { port: number } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${userId}`)
    return row.port
  }

  stateOf(userId: number): string {
    const row = this.db.prepare(`SELECT state FROM instances WHERE user_id = ?`).get(userId) as { state: string } | undefined
    return row?.state ?? 'stopped'
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
  isLive(userId: number): boolean {
    const proc = this.procs.get(userId)
    return this.stateOf(userId) === 'ready' && proc !== undefined && !proc.hasExited()
  }

  touch(userId: number): void {
    this.db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now(), userId)
  }

  wsRef(userId: number, delta: 1 | -1): void {
    this.wsRefs.set(userId, Math.max(0, (this.wsRefs.get(userId) ?? 0) + delta))
    if (delta === -1) this.touch(userId)
  }

  /** Run `fn` after any in-flight start/stop for this user has settled. */
  private serialize<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(userId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.ops.set(userId, run.then(() => undefined, () => undefined))
    return run
  }

  private launchUser(user: UserRow): LaunchUser {
    return {
      username: user.username,
      port: this.portOf(user.id),
      homePath: user.homePath,
      dshHome: join(this.cfg.usersRoot, user.username, 'dsh'),
    }
  }

  async ensureRunning(user: UserRow): Promise<{ port: number }> {
    return this.serialize(user.id, async () => {
      const port = this.portOf(user.id)
      const proc = this.procs.get(user.id)
      if (this.stateOf(user.id) === 'ready' && proc !== undefined && !proc.hasExited()) return { port }
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
    this.db.prepare(`UPDATE instances SET state = 'starting', started_at = ?, last_activity_at = ? WHERE user_id = ?`)
      .run(now, now, user.id)
    this.beforeStart?.(user)
    const proc = await this.launcher.start(this.launchUser(user))
    this.procs.set(user.id, proc)

    const deadline = Date.now() + this.cfg.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (proc.hasExited()) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          this.db.prepare(`UPDATE instances SET state = 'ready' WHERE user_id = ?`).run(user.id)
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
    const cutoff = Date.now() - this.cfg.idleTimeoutMs
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'ready' AND last_activity_at < ?`,
    ).all(cutoff) as Array<{ user_id: number }>
    let stopped = 0
    for (const row of rows) {
      if ((this.wsRefs.get(row.user_id) ?? 0) > 0) continue
      await this.stop(row.user_id)
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
    this.db.prepare(`UPDATE instances SET state = 'stopping' WHERE user_id = ?`).run(userId)
    let proc = this.procs.get(userId)
    if (proc === undefined && this.launcher.attach !== undefined) {
      const row = this.db.prepare(`SELECT id, username, home_path FROM users WHERE id = ?`).get(userId) as
        | { id: number; username: string; home_path: string } | undefined
      if (row !== undefined) {
        proc = this.launcher.attach({
          username: row.username,
          port: this.portOf(userId),
          homePath: row.home_path,
          dshHome: join(this.cfg.usersRoot, row.username, 'dsh'),
        })
      }
    }
    if (proc !== undefined) await proc.terminate(STOP_GRACE_MS)
    this.procs.delete(userId)
    this.markStopped(userId)
  }

  async stopAll(): Promise<void> {
    // Local children must not outlive the gateway; systemd units stay up
    // across a gateway restart by design.
    if (this.launcher.instancesOutliveGateway) return
    await Promise.all([...this.procs.keys()].map(id => this.stop(id)))
  }
}
