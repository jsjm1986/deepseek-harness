import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyModelGovernanceToUser, writeModelGovernanceFile } from '../src/apply-model-governance.ts'
import { AuditService } from '../src/audit.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { ModelGovernanceService, type UsageEvent } from '../src/model-governance.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import { UserService } from '../src/users.ts'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

async function fixture(timeZone = 'Asia/Shanghai') {
  const root = mkdtempSync(join(tmpdir(), 'hgw-model-int-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_USAGE_TIME_ZONE: timeZone })
  const users = new UserService(db, cfg)
  const user = await users.create({ username: 'metered-user', password: 'pw-12345678' })
  const governance = new ModelGovernanceService(db, timeZone)
  governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
    adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
  return { root, db, cfg, users, user, governance }
}

function deniedEvent(eventId = 'denied-1'): UsageEvent {
  return { eventId, occurredAt: Date.now(), provider: 'p', model: 'm', purpose: 'assistant',
    credentialSource: 'none', credentialClass: 'unknown', status: 'denied' }
}

describe('model governance integration', () => {
  it('authenticates intake, deduplicates denial audit, and rejects source/class spoofing', async () => {
    const { db, user, governance } = await fixture()
    const audit = new AuditService(db)
    const token = governance.issueIntakeToken({ kind: 'user', id: user.id })
    const server = createUsageIntakeServer(governance, audit)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/usage`, { method: 'POST', body: '{}' })).status).toBe(401)
    const post = (body: unknown) => fetch(`${base}/usage`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) })
    expect((await post(deniedEvent())).status).toBe(200)
    expect((await post(deniedEvent())).status).toBe(200)
    expect(audit.query({ action: 'model.denied' })).toHaveLength(1)
    const spoofed = { ...deniedEvent('spoof'), status: 'succeeded', credentialSource: 'file', credentialClass: 'company' }
    expect((await post(spoofed)).status).toBe(400)
  })

  it('writes a private policy, reuses its valid token, and reflects changed access', async () => {
    const { cfg, user, governance } = await fixture()
    governance.setUserAccess(user.id, 'p', 'm', false)
    const path = await writeModelGovernanceFile(cfg, governance, user)
    const first = JSON.parse(readFileSync(path, 'utf8')) as { intakeToken: string; models: Array<{ allowed: boolean }> }
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(first.models[0]?.allowed).toBe(false)
    governance.setUserAccess(user.id, 'p', 'm', true)
    await writeModelGovernanceFile(cfg, governance, user)
    const second = JSON.parse(readFileSync(path, 'utf8')) as typeof first
    expect(second.intakeToken).toBe(first.intakeToken)
    expect(second.models[0]?.allowed).toBe(true)
  })

  it('projects a changed policy without restarting the user instance', async () => {
    const { cfg, user, users, governance } = await fixture()
    governance.setUserAccess(user.id, 'p', 'm', false)
    await expect(applyModelGovernanceToUser({ cfg, users, governance }, user.id)).resolves.toBeUndefined()
    const path = join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ models: [{ allowed: false }] })
  })

  it('uses configured natural-month boundaries and supports per-metric inherit/unlimited/custom', async () => {
    const { user, governance } = await fixture('America/New_York')
    governance.setQuota('role', 'user', 100, 200)
    governance.setQuota('user', String(user.id), 'inherit', null)
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-03'))
      .toMatchObject({ tokenLimit: 100, companyCostMicrosLimit: null })
    governance.ingest({ kind: 'user', id: user.id }, { ...deniedEvent('before-midnight'), status: 'succeeded', occurredAt: Date.parse('2026-04-01T03:30:00Z'),
      credentialSource: 'user-env', credentialClass: 'company', usage: { inputTokens: 7, outputTokens: 0 } })
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-03').totalTokens).toBe(7)
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-04').totalTokens).toBe(0)
    governance.setQuota('user', String(user.id), 'inherit', 'inherit')
    expect(governance.summary({ kind: 'user', id: user.id }).companyCostMicrosLimit).toBe(200)
  })
})
