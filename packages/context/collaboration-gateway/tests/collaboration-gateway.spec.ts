import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { GatewayRequestPrincipal, GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import GatewayCollaboration from '../src/index.ts'

const PRINCIPAL: GatewayRequestPrincipal = {
  assertion: 'assertion',
  claims: {
    version: 1,
    issuer: 'harness-gateway',
    audience: 'dsh-runtime',
    organization: 'acme',
    user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
    scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
    runtime: { kind: 'project', id: 41, generation: 7 },
    issuedAt: 1,
    expiresAt: 2,
    nonce: 'nonce',
  },
}

const ADMIN_PRINCIPAL: GatewayRequestPrincipal = {
  ...PRINCIPAL,
  claims: {
    ...PRINCIPAL.claims,
    user: { ...PRINCIPAL.claims.user, role: 'admin' },
  },
}

describe('GatewayCollaboration', () => {
  it('advertises full access only to an authenticated administrator in every scope', async () => {
    let current: GatewayRequestPrincipal | undefined = PRINCIPAL
    const runtime = {
      requireCurrent: () => {
        if (current === undefined) throw new Error('no current request')
        return current
      },
      request: vi.fn(),
      sessionCreation: () => undefined,
    } as unknown as GatewayRuntime
    const ctx = new Context()
    ctx.provide('gatewayRuntime', runtime)
    const fiber = ctx.plugin(GatewayCollaboration)
    await fiber.await()
    const authorization = ctx.get('permissionPresetAuthorization')
    if (authorization === undefined) throw new Error('permission preset authorization was not installed')
    expect(authorization.canSelect('workspace-write')).toBe(true)
    expect(authorization.canSelect('danger-full-access')).toBe(false)
    current = ADMIN_PRINCIPAL
    expect(authorization.canSelect('danger-full-access')).toBe(true)
    current = undefined
    expect(authorization.canSelect('danger-full-access')).toBe(false)
    await fiber.dispose()
  })

  it('invalidates retained authorities when the provider unloads', async () => {
    const request = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      access: {
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        mode: 'rw',
        canRead: true,
        canWrite: true,
        canManage: false,
        projectId: 41,
        visibility: 'project',
        creatorUserId: 9,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const runtime = {
      requireCurrent: () => PRINCIPAL,
      request,
      sessionCreation: () => undefined,
    } as unknown as GatewayRuntime
    const ctx = new Context()
    ctx.provide('gatewayRuntime', runtime)
    const fiber = ctx.plugin(GatewayCollaboration)
    await fiber.await()
    const authority = ctx.collaboration.capture()
    expect(authority.signal.aborted).toBe(false)

    await expect(authority.authorize(SessionId('session-1'), 'read')).resolves.toMatchObject({ canRead: true })
    expect(request).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(authority.signal.aborted).toBe(true)
    await expect(authority.authorize(SessionId('session-1'), 'read'))
      .rejects.toMatchObject({ code: 'gateway-unavailable' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('forwards pending creation authorizations for blank-session ACL checks', async () => {
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
      const body = JSON.parse(init.body) as Record<string, unknown>
      if (path.endsWith('/authorize')) {
        expect(body).toMatchObject({
          sessionId: 'pending-root',
          action: 'write',
          creationAuthorization: 'creation-authorization',
        })
        return Promise.resolve(new Response(JSON.stringify({
          access: {
            sessionId: 'pending-root',
            rootSessionId: 'pending-root',
            mode: 'rw',
            canRead: true,
            canWrite: true,
            canManage: true,
            projectId: 41,
            visibility: 'private',
            creatorUserId: 9,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      expect(body).toEqual({
        sessionIds: ['pending-root', 'stored-root'],
        creationAuthorizations: [{
          sessionId: 'pending-root',
          authorization: 'creation-authorization',
        }],
      })
      return Promise.resolve(new Response(JSON.stringify({
        sessionIds: ['pending-root', 'stored-root'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const runtime = {
      requireCurrent: () => PRINCIPAL,
      request,
      sessionCreation: (sessionId: string) => sessionId === 'pending-root'
        ? Promise.resolve('creation-authorization')
        : undefined,
    } as unknown as GatewayRuntime
    const ctx = new Context()
    ctx.provide('gatewayRuntime', runtime)
    const fiber = ctx.plugin(GatewayCollaboration)
    await fiber.await()
    const authority = ctx.collaboration.capture()

    await expect(authority.authorize(SessionId('pending-root'), 'write'))
      .resolves.toMatchObject({ canWrite: true, visibility: 'private' })
    await expect(authority.readableSessionIds([
      SessionId('pending-root'),
      SessionId('stored-root'),
    ])).resolves.toEqual(new Set([SessionId('pending-root'), SessionId('stored-root')]))
    expect(request).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })
})
