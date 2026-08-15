import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { ModelGovernanceService, type UsageEvent } from '../src/model-governance.ts'
import { UserService } from '../src/users.ts'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-governance-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users') })
  const users = new UserService(db, cfg)
  const admin = await users.create({ username: 'admin-governance', password: 'pw-12345678', role: 'admin' })
  const user = await users.create({ username: 'user-governance', password: 'pw-12345678', role: 'user' })
  return { db, users, admin, user, governance: new ModelGovernanceService(db) }
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: 'evt-1', occurredAt: Date.now(), provider: 'p', model: 'm', purpose: 'assistant',
    credentialSource: 'user-env', credentialClass: 'company', status: 'succeeded',
    usage: { inputTokens: 400, outputTokens: 500, cacheReadTokens: 100 }, ...overrides,
  }
}

describe('ModelGovernanceService', () => {
  it('applies role defaults, user exceptions, and global disable in priority order', async () => {
    const { governance, admin, user } = await setup()
    governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
      adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
    expect(governance.policyFor(admin).models[0]?.allowed).toBe(true)
    expect(governance.policyFor(user).models[0]?.allowed).toBe(false)
    governance.setUserAccess(user.id, 'p', 'm', true)
    expect(governance.policyFor(user).models[0]?.allowed).toBe(true)
    governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: false,
      adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
    expect(governance.policyFor(user).models[0]?.allowed).toBe(false)
  })

  it('prices token classes, excludes personal cost, deduplicates events, and emits threshold alerts once', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-15T00:00:00+08:00'))
    const { governance, user } = await setup()
    governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
      adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 500_000, cacheWriteMicrosPerMillion: 0 })
    governance.setQuota('user', String(user.id), 1_000, 1_800)
    expect(governance.ingest({ kind: 'user', id: user.id }, event())).toEqual({ inserted: true, alerts: 3 })
    expect(governance.ingest({ kind: 'user', id: user.id }, event())).toEqual({ inserted: false, alerts: 0 })
    const summary = governance.summary({ kind: 'user', id: user.id }, '2026-08')
    expect(summary.totalTokens).toBe(1_000)
    expect(summary.estimatedCostMicros).toBe(1_450)
    expect(summary.companyCostMicros).toBe(1_450)
    expect(summary.alerts.map(a => [a.metric, a.threshold])).toEqual([
      ['tokens', 80], ['tokens', 100], ['company-cost', 80],
    ])
    governance.ingest({ kind: 'user', id: user.id }, event({ eventId: 'evt-personal', credentialSource: 'file', credentialClass: 'personal' }))
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-08').companyCostMicros).toBe(1_450)
    vi.useRealTimers()
  })

  it('rejects unknown model exceptions and malformed intake values', async () => {
    const { governance, user } = await setup()
    expect(() => governance.setUserAccess(user.id, 'missing', 'm', true)).toThrow(/unknown model/)
    expect(() => governance.ingest({ kind: 'user', id: user.id }, event({ occurredAt: -1 }))).toThrow(/occurredAt/)
    expect(() => governance.setQuota('role', 'owner', 1, null)).toThrow(/admin or user/)
  })
})
