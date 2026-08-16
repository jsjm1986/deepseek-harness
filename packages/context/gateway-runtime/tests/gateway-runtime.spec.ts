import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayPrincipalClaims, GatewayRuntimeCredential } from '../src/index.ts'
import GatewayRuntime, {
  GATEWAY_PRINCIPAL_HEADER,
  GatewaySessionCreationAuthorization,
  parseGatewayRuntimeCredential,
  verifyGatewayPrincipal,
} from '../src/index.ts'

const NOW = Date.now()

function fixture(): {
  credential: GatewayRuntimeCredential
  issue: (claims?: Partial<GatewayPrincipalClaims>) => string
} {
  const pair = generateKeyPairSync('ed25519')
  const credential: GatewayRuntimeCredential = {
    version: 1,
    gatewayUrl: 'http://127.0.0.1:8899',
    organization: 'acme',
    runtime: { kind: 'project', id: 41, generation: 7 },
    token: 'runtime-secret',
    principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
  const issue = (overrides: Partial<GatewayPrincipalClaims> = {}): string => {
    const claims: GatewayPrincipalClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-runtime',
      organization: 'acme',
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
      runtime: { kind: 'project', id: 41, generation: 7 },
      issuedAt: NOW,
      expiresAt: NOW + 30_000,
      nonce: 'nonce-1',
      ...overrides,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
  }
  return { credential, issue }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD
})

describe('Gateway runtime credential', () => {
  it('accepts only a loopback HTTP origin and a positive runtime identity', () => {
    const { credential } = fixture()
    expect(parseGatewayRuntimeCredential(credential)).toEqual(credential)
    expect(() => parseGatewayRuntimeCredential({ ...credential, gatewayUrl: 'https://127.0.0.1:8899' }))
      .toThrow(/loopback HTTP origin/)
    expect(() => parseGatewayRuntimeCredential({
      ...credential,
      runtime: { ...credential.runtime, generation: 0 },
    })).toThrow(/invalid Gateway runtime credential/)
  })

  it('rejects tampering, expiry, and a foreign runtime generation', () => {
    const { credential, issue } = fixture()
    const assertion = issue()
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith('A') ? 'B' : 'A'}`
    expect(verifyGatewayPrincipal(assertion, credential, undefined, NOW + 1).user.id).toBe(9)
    expect(() => verifyGatewayPrincipal(tampered, credential, undefined, NOW + 1))
      .toThrow(/invalid Gateway principal assertion/)
    expect(() => verifyGatewayPrincipal(assertion, credential, undefined, NOW + 30_000))
      .toThrow(/expired or foreign/)
    expect(() => verifyGatewayPrincipal(issue({
      runtime: { kind: 'project', id: 41, generation: 8 },
    }), credential, undefined, NOW + 1)).toThrow(/expired or foreign/)
  })
})

describe('Gateway request context', () => {
  it('isolates concurrent principals and forwards only the selected assertion', async () => {
    const { credential, issue } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    expect(ctx.gatewayRuntime.identity).toEqual(credential.runtime)
    expect(ctx.gatewayRuntime.organization).toBe('acme')

    const sessionId = SessionId('pending-root')
    const authorization = Promise.resolve(GatewaySessionCreationAuthorization('creation-authorization'))
    const unregister = ctx.gatewayRuntime.registerSessionCreation(sessionId, authorization)
    expect(ctx.gatewayRuntime.sessionCreation(sessionId)).toBe(authorization)
    expect(() => ctx.gatewayRuntime.registerSessionCreation(
      sessionId,
      Promise.resolve(GatewaySessionCreationAuthorization('other-authorization')),
    )).toThrow(/already has a pending Gateway creation authorization/)
    unregister()
    unregister()
    expect(ctx.gatewayRuntime.sessionCreation(sessionId)).toBeUndefined()
    expect(() => GatewaySessionCreationAuthorization('')).toThrow(/must not be empty/)

    const seen: Array<{ url: string; authorization: string | null; principal: string | null }> = []
    vi.stubGlobal('fetch', vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        authorization: headers.get('authorization'),
        principal: headers.get(GATEWAY_PRINCIPAL_HEADER),
      })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))

    const first = issue({
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
      nonce: 'first',
    })
    const second = issue({
      user: { id: 10, username: 'mei', displayName: 'Mei', role: 'admin' },
      nonce: 'second',
    })
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered!: () => void
    const entered = new Promise<void>((resolve) => { firstEntered = resolve })
    const run = (assertion: string, operation: () => Promise<void>): Promise<void> =>
      ctx.waterfall('connection/request', {
        kind: 'http', headers: { [GATEWAY_PRINCIPAL_HEADER]: assertion },
      }, operation)

    const firstRun = run(first, async () => {
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(9)
      firstEntered()
      await blocked
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(9)
      await ctx.gatewayRuntime.request('/internal/runtime/session/list', { principal: true })
    })
    await entered
    await run(second, async () => {
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(10)
      await ctx.gatewayRuntime.request('/internal/runtime/session/list', { principal: true })
    })
    releaseFirst()
    await firstRun
    await ctx.gatewayRuntime.request('/internal/runtime/session/list')

    expect(seen).toEqual([
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: second,
      },
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: first,
      },
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: null,
      },
    ])
    expect(ctx.gatewayRuntime.current()).toBeUndefined()
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects alternate origins, fragments, traversal, and encoded dot segments', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetch)

    for (const path of [
      '//127.0.0.1:8899/internal/runtime/session/list',
      '//example.test/internal/runtime/session/list',
      '/internal/runtime/session/list#secret',
      '/internal/runtime/../admin',
      '/internal/runtime/%2e%2e/admin',
      '/internal/runtime/%252e%252e/admin',
    ]) {
      expect(() => ctx.gatewayRuntime.request(path)).toThrow(/invalid Gateway runtime API path/)
    }
    expect(fetch).not.toHaveBeenCalled()
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a request without a Gateway principal before downstream dispatch', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    let reached = false
    await expect(Promise.resolve().then(() =>
      ctx.waterfall('connection/request', { kind: 'upgrade', headers: {} }, async () => {
        reached = true
      }))).rejects.toThrow(/principal assertion is required/)
    expect(reached).toBe(false)
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
})
