import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { loadPolicy, type GovernancePolicyFile } from './policy.ts'

/** Directory watcher signature used by the policy reloader and its tests. */
export type WatchDirectory = (
  directory: string,
  options: { persistent: boolean },
  listener: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void,
) => FSWatcher

/** Callbacks owned by the plugin that consumes policy reloads. */
export interface PolicyReloaderOptions {
  /** Absolute or process-resolvable policy filename. */
  filename: string
  /** Publish one validated policy snapshot. */
  onValid: (policy: GovernancePolicyFile) => void
  /** Enter the consumer's fail-closed state after a reload failure. */
  onInvalid: (error: unknown) => void
  /** Surface watcher backend failures without throwing from an event callback. */
  onWatcherError: (error: unknown) => void
  /** Injectable watcher factory for deterministic lifecycle tests. */
  watchDirectory?: WatchDirectory
}

/**
 * Reloads an atomically replaced policy file and drains all queued work before
 * disposal. The parent directory is watched so rename-based replacement keeps
 * working after the policy inode changes.
 */
export class PolicyReloader {
  private readonly filename: string
  private readonly target: string
  private readonly onValid: (policy: GovernancePolicyFile) => void
  private readonly onInvalid: (error: unknown) => void
  private readonly onWatcherError: (error: unknown) => void
  private readonly watcher: FSWatcher
  private operations: Promise<void> = Promise.resolve()
  private reloadQueued = false
  private closed = false

  /**
   * @param options - policy path, lifecycle callbacks, and optional watcher factory.
   */
  constructor(options: PolicyReloaderOptions) {
    this.filename = options.filename
    this.target = basename(options.filename)
    this.onValid = options.onValid
    this.onInvalid = options.onInvalid
    this.onWatcherError = options.onWatcherError
    const watchDirectory = options.watchDirectory ?? watch
    this.watcher = watchDirectory(dirname(options.filename), { persistent: false }, (_eventType, filename) => {
      if (filename === null || filename === undefined || String(filename) === this.target) this.queueReload()
    })
    this.watcher.on('error', this.onWatcherError)
    // Reconcile once after watcher setup closes the race between the initial
    // boot read and the directory watcher becoming active.
    queueMicrotask(() => { this.queueReload() })
  }

  /**
   * Close the watcher and wait for every already-queued reload to settle.
   * @returns completion after no reload callback can publish again.
   */
  async close(): Promise<void> {
    this.closed = true
    this.watcher.close()
    await this.operations
  }

  private queueReload(): void {
    if (this.closed || this.reloadQueued) return
    this.reloadQueued = true
    const task = this.operations.then(() => {
      this.reloadQueued = false
      return this.reload()
    })
    this.operations = task.then(() => undefined, () => undefined)
    void task.catch(error => { this.onWatcherError(error) })
  }

  private reload(): void {
    if (this.closed) return
    try {
      this.onValid(loadPolicy(this.filename))
    } catch (error) {
      this.onInvalid(error)
    }
  }
}
