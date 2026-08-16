import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { GatewayPrincipalSigner, loadPrincipalKeys } from '../src/principal.ts'

const USER: UserRow = {
  id: 7,
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  homePath: '/tmp/alice',
}

describe('GatewayPrincipalSigner', () => {
  it('issues generation-bound assertions and rejects tampering, expiry, and foreign organizations', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const assertion = signer.issue({
      user: USER,
      scope: { kind: 'project', projectId: 11, projectName: 'Atlas', mode: 'rw' },
      runtime: { kind: 'project', id: 11, generation: 4 },
      now: 10_000,
    })

    expect(signer.verify(assertion, 10_500)).toMatchObject({
      organization: 'acme',
      user: { id: 7, displayName: 'Alice' },
      scope: { kind: 'project', projectId: 11, mode: 'rw' },
      runtime: { kind: 'project', id: 11, generation: 4 },
    })
    expect(() => signer.verify(`${assertion.slice(0, -1)}x`, 10_500)).toThrow(/invalid principal assertion/)
    expect(() => signer.verify(assertion, 11_000)).toThrow(/expired or foreign/)
    expect(() => new GatewayPrincipalSigner(privateKey, 'other', 1000).verify(assertion, 10_500))
      .toThrow(/expired or foreign/)
  })

  it('binds delayed session creation to its creator, runtime generation, header, and visibility', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const signer = new GatewayPrincipalSigner(privateKey, 'acme', 1000)
    const authorization = signer.issueSessionCreation({
      creatorUserId: USER.id,
      runtime: { kind: 'project', id: 11, generation: 4 },
      header: {
        id: 'session-1',
        version: 0,
        createdAt: 10_000,
        cwd: '/srv/project',
        agentPreset: 'coding',
      },
      visibility: 'private',
      now: 10_000,
    })
    const tampered = `${authorization.slice(0, -1)}${authorization.endsWith('A') ? 'B' : 'A'}`

    expect(signer.verifySessionCreation(authorization)).toMatchObject({
      organization: 'acme',
      creatorUserId: USER.id,
      runtime: { kind: 'project', id: 11, generation: 4 },
      header: { id: 'session-1', cwd: '/srv/project', agentPreset: 'coding' },
      visibility: 'private',
      issuedAt: 10_000,
    })
    expect(() => signer.verifySessionCreation(tampered))
      .toThrow(/invalid session creation authorization/)
    expect(() => new GatewayPrincipalSigner(privateKey, 'other', 1000)
      .verifySessionCreation(authorization)).toThrow(/invalid session creation authorization/)
  })

  it('persists one owner-only keypair and reloads the same signing identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hgw-principal-'))
    writeFileSync(join(directory, 'principal-public.pem'), 'stale derived key')
    const first = loadPrincipalKeys(directory, 'acme', 1000)
    const assertion = first.signer.issue({
      user: USER,
      scope: { kind: 'personal' },
      runtime: { kind: 'user', id: USER.id, generation: 2 },
      now: 20_000,
    })
    const second = loadPrincipalKeys(directory, 'acme', 1000)

    expect(second.publicKeyPem).toBe(first.publicKeyPem)
    expect(second.signer.verify(assertion, 20_500).runtime.generation).toBe(2)
    expect(readFileSync(join(directory, 'principal-private.pem'), 'utf8')).toContain('PRIVATE KEY')
    expect(existsSync(join(directory, 'principal-public.pem'))).toBe(false)
  })
})
