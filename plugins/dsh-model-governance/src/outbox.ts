import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageRecord {
  eventId: string
  occurredAt: number
  provider: string
  model: string
  purpose: string
  sessionId?: string
  credentialSource: string
  credentialClass: 'company' | 'personal' | 'unknown'
  status: 'succeeded' | 'failed' | 'cancelled' | 'missing-usage' | 'denied'
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

/** Crash-safe local outbox; each record is committed by same-directory rename. */
export class UsageOutbox {
  private pumping: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout
  private closed = false

  constructor(private readonly dir: string, private url: string, private token: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.timer = setInterval(() => this.kick(), 5_000)
    this.timer.unref()
    this.kick()
  }

  /**
   * Replace the intake destination used by future delivery attempts.
   * @param url - loopback intake URL from the validated policy.
   * @param token - bearer token from the validated policy.
   */
  setEndpoint(url: string, token: string): void {
    if (this.closed) return
    this.url = url
    this.token = token
  }

  enqueue(record: UsageRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = join(this.dir, `${record.eventId}.json`)
    const temp = `${target}.${randomBytes(5).toString('hex')}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); closeSync(fd); renameSync(temp, target) } catch (error) {
      try { closeSync(fd) } catch { /* already closed */ }
      rmSync(temp, { force: true })
      throw error
    }
    this.kick()
  }

  private kick(): void {
    if (this.closed) return
    this.pumping = this.pumping.then(() => this.drain(), () => this.drain())
  }

  private async drain(): Promise<void> {
    for (const name of readdirSync(this.dir).filter(name => name.endsWith('.json')).sort()) {
      if (this.closed) return
      const path = join(this.dir, name)
      let response: Response
      try {
        response = await fetch(this.url, {
          method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')),
          signal: AbortSignal.timeout(5_000),
        })
      } catch { return }
      if (!response.ok) return
      rmSync(path, { force: true })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.pumping
  }
}
