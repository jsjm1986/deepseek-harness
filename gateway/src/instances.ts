import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000

export class InstanceManager {
  private readonly children = new Map<number, ChildProcess>()
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

  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL`).run()
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

  async ensureRunning(user: UserRow): Promise<{ port: number }> {
    return this.serialize(user.id, async () => {
      const port = this.portOf(user.id)
      if (this.stateOf(user.id) === 'ready' && this.children.has(user.id)) return { port }
      return this.start(user, port)
    })
  }

  private async start(user: UserRow, port: number): Promise<{ port: number }> {
    const now = Date.now()
    this.db.prepare(`UPDATE instances SET state = 'starting', started_at = ?, last_activity_at = ? WHERE user_id = ?`)
      .run(now, now, user.id)
    this.beforeStart?.(user)
    const argv = this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(port)))
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      cwd: user.homePath,
      env: {
        ...process.env,
        DSH_HOME: join(this.cfg.usersRoot, user.username, 'dsh'),
      },
      stdio: 'ignore',
    })
    this.children.set(user.id, child)
    child.on('exit', () => {
      if (this.children.get(user.id) === child) {
        this.children.delete(user.id)
        this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(user.id)
      }
    })
    this.db.prepare(`UPDATE instances SET pid = ? WHERE user_id = ?`).run(child.pid ?? null, user.id)

    const deadline = Date.now() + this.cfg.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
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

  /** Kill the child and mark the row stopped. Assumes the caller holds the per-user op slot. */
  private async terminate(userId: number): Promise<void> {
    const child = this.children.get(userId)
    this.db.prepare(`UPDATE instances SET state = 'stopping' WHERE user_id = ?`).run(userId)
    if (child !== undefined && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(timer)
    }
    this.children.delete(userId)
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(userId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map(id => this.stop(id)))
  }
}
