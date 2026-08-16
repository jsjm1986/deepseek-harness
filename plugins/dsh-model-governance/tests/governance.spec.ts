import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Governance from '../src/index.ts'
import { UsageOutbox } from '../src/outbox.ts'
import { loadPolicy } from '../src/policy.ts'

const oldHome = process.env.DSH_HOME
afterEach(() => { process.env.DSH_HOME = oldHome; vi.restoreAllMocks() })

class Adapter extends LlmAdapter {
  calls = 0
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'file' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []; for await (const chunk of source) result.push(chunk); return result
}
function policy(home: string, allowed: boolean): void {
  writeFileSync(join(home, 'model-governance.json'), JSON.stringify({ version: 1, defaultAllowed: false,
    models: [{ provider: 'p', model: 'm', allowed }], intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'token' }))
}

function replacePolicy(home: string, allowed: boolean): void {
  const path = join(home, 'model-governance.json')
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify({ version: 1, defaultAllowed: false,
    models: [{ provider: 'p', model: 'm', allowed }], intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'token' }))
  renameSync(temp, path)
}

describe('instance model governance', () => {
  it('fails closed on malformed policy and enforces denial before adapter dispatch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gov-')); process.env.DSH_HOME = home
    writeFileSync(join(home, 'model-governance.json'), '{}')
    expect(() => loadPolicy(join(home, 'model-governance.json'))).toThrow(/version/)
    policy(home, false)
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    const adapter = new Adapter(); ctx.llm.registerAdapter(['p'], adapter)
    await ctx.plugin(Governance)
    const chunks = await drain(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
    expect(adapter.calls).toBe(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(readdirSync(join(home, 'model-governance-outbox')).filter(name => name.endsWith('.json'))).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('records usage with personal credential attribution without changing the stream', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gov-')); process.env.DSH_HOME = home; policy(home, true)
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    const adapter = new Adapter(); ctx.llm.registerAdapter(['p'], adapter); await ctx.plugin(Governance)
    const chunks = await drain(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    await new Promise(resolve => setTimeout(resolve, 20))
    const file = readdirSync(join(home, 'model-governance-outbox')).find(name => name.endsWith('.json'))
    expect(file).toBeDefined()
    expect(JSON.parse(readFileSync(join(home, 'model-governance-outbox', file!), 'utf8'))).toMatchObject({
      credentialSource: 'file', credentialClass: 'personal', status: 'succeeded', usage: { inputTokens: 3, outputTokens: 2 },
    })
    await ctx.fiber.dispose()
  })

  it('reloads a valid policy without restarting the plugin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gov-')); process.env.DSH_HOME = home; policy(home, false)
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    const adapter = new Adapter(); ctx.llm.registerAdapter(['p'], adapter); await ctx.plugin(Governance)
    const denied = await drain(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
    expect(denied.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    replacePolicy(home, true)
    await vi.waitFor(async () => {
      const chunks = await drain(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
      expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    })
    expect(adapter.calls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('fails closed on an invalid live update and recovers on the next valid policy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gov-')); process.env.DSH_HOME = home; policy(home, true)
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    const adapter = new Adapter(); ctx.llm.registerAdapter(['p'], adapter); await ctx.plugin(Governance)
    const access = ctx.get('modelAccess')
    if (access === undefined) throw new Error('model access service missing')
    replacePolicy(home, true)
    // Replace the complete file so the watcher never reads an in-progress JSON document.
    const path = join(home, 'model-governance.json'); const temp = `${path}.invalid.tmp`
    writeFileSync(temp, '{}'); renameSync(temp, path)
    await vi.waitFor(() => {
      expect(access.decide({ provider: 'p', model: 'm' })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('temporarily unavailable'),
      })
    })
    replacePolicy(home, false)
    await vi.waitFor(() => {
      expect(access.decide({ provider: 'p', model: 'm' })).toMatchObject({
        allowed: false,
        reason: 'Model "p/m" is not authorized for this account.',
      })
    })
    expect(adapter.calls).toBe(0)
    await ctx.fiber.dispose()
  })

  it('keeps a failed delivery on disk and drains it after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-outbox-'))
    const first = new UsageOutbox(dir, 'http://127.0.0.1:1/usage', 't')
    first.enqueue({ eventId: 'e', occurredAt: 1, provider: 'p', model: 'm', purpose: 'assistant',
      credentialSource: 'unknown', credentialClass: 'unknown', status: 'missing-usage' })
    await new Promise(resolve => setTimeout(resolve, 30)); await first.close()
    expect(readdirSync(dir)).toContain('e.json')
    const server = createServer((_req, res) => { res.writeHead(200).end('{}') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const second = new UsageOutbox(dir, `http://127.0.0.1:${(server.address() as AddressInfo).port}/usage`, 't')
    for (let i = 0; i < 30 && readdirSync(dir).includes('e.json'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await second.close(); await new Promise<void>(resolve => server.close(() => resolve()))
    expect(readdirSync(dir)).not.toContain('e.json')
  })
})
