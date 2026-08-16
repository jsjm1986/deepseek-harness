import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GovernancePolicyFile } from '../src/policy.ts'
import { PolicyReloader, type WatchDirectory } from '../src/reload.ts'

class FakeWatcher extends EventEmitter {
  closeCalls = 0
  listener?: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void

  close(): void {
    this.closeCalls += 1
  }

  emitFile(eventType: 'rename' | 'change', filename: string | Buffer | null): void {
    this.listener?.(eventType, filename)
  }
}

type PolicyWatchListener = (eventType: 'rename' | 'change', filename: string | Buffer | null) => void

function policy(defaultAllowed: boolean): GovernancePolicyFile {
  return {
    version: 1,
    defaultAllowed,
    models: [],
    intakeUrl: 'http://127.0.0.1:8899/usage',
    intakeToken: 'token',
  }
}

describe('PolicyReloader', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reconciles the initial race, publishes matching file events, and closes cleanly', async () => {
    const home = mkdtempSync(`${tmpdir()}/dsh-governance-reload-`)
    const filename = `${home}/model-governance.json`
    writeFileSync(filename, '{}')
    const watcher = new FakeWatcher()
    const fakeWatch = (directory: string, options: { persistent: boolean }, listener: PolicyWatchListener): FakeWatcher => {
      expect(directory).toBe(home)
      expect(options).toEqual({ persistent: false })
      watcher.listener = listener
      return watcher
    }
    const watchDirectory = fakeWatch as unknown as WatchDirectory
    const valid: GovernancePolicyFile[] = []
    const invalid: unknown[] = []
    const reloader = new PolicyReloader({
      filename,
      onValid: next => { valid.push(next) },
      onInvalid: error => { invalid.push(error) },
      onWatcherError: vi.fn(),
      watchDirectory,
    })

    // The boot-time reconciliation sees the file as invalid but keeps the
    // watcher queue alive for a later valid replacement.
    await vi.waitFor(() => { expect(invalid).toHaveLength(1) })
    writeFileSync(filename, JSON.stringify(policy(true)))
    watcher.emitFile('change', 'model-governance.json')
    await vi.waitFor(() => { expect(valid).toHaveLength(1) })

    watcher.emitFile('change', 'unrelated.json')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(valid).toHaveLength(1)

    await reloader.close()
    expect(watcher.closeCalls).toBe(1)
    writeFileSync(filename, JSON.stringify(policy(false)))
    watcher.emitFile('change', basename(filename))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(valid).toHaveLength(1)
  })

  it('reports watcher failures without rejecting the lifecycle queue', async () => {
    const home = mkdtempSync(`${tmpdir()}/dsh-governance-reload-`)
    const filename = `${home}/model-governance.json`
    writeFileSync(filename, JSON.stringify(policy(true)))
    const watcher = new FakeWatcher()
    const onWatcherError = vi.fn()
    const reloader = new PolicyReloader({
      filename,
      onValid: vi.fn(),
      onInvalid: vi.fn(),
      onWatcherError,
      watchDirectory: (() => watcher) as unknown as WatchDirectory,
    })
    await vi.waitFor(() => { expect(onWatcherError).not.toHaveBeenCalled() })
    const error = new Error('watch backend failed')
    watcher.emit('error', error)
    expect(onWatcherError).toHaveBeenCalledWith(error)
    await reloader.close()
  })
})
