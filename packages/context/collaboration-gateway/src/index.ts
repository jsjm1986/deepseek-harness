/** Gateway-backed project collaboration provider. @module @deepseek-ai/dsh-collaboration-gateway */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import Collaboration, {
  CollaborationError,
  type CollaborationAccess,
  type CollaborationAction,
  type CollaborationAuthority,
  type CollaborationInteractionKind,
  type CollaborationParticipant,
  type CollaborationSessionCreation,
} from '@deepseek-ai/dsh-collaboration'
import type { GatewayRequestPrincipal, GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import type { PermissionPresetAuthorization } from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function accessView(value: unknown): CollaborationAccess {
  const access = record(value)
  if (typeof access?.sessionId !== 'string' || access.sessionId === ''
    || typeof access.rootSessionId !== 'string' || access.rootSessionId === ''
    || (access.mode !== 'ro' && access.mode !== 'rw') || access.canRead !== true
    || typeof access.canWrite !== 'boolean' || typeof access.canManage !== 'boolean'
    || (access.projectId !== undefined && !positiveInteger(access.projectId))
    || (access.visibility !== undefined && access.visibility !== 'project' && access.visibility !== 'private')
    || (access.creatorUserId !== undefined && !positiveInteger(access.creatorUserId))) {
    throw new CollaborationError('gateway-unavailable', 'Gateway returned invalid collaboration access')
  }
  return {
    sessionId: SessionId(access.sessionId),
    rootSessionId: SessionId(access.rootSessionId),
    mode: access.mode,
    canRead: true,
    canWrite: access.canWrite,
    canManage: access.canManage,
    ...(access.projectId === undefined ? {} : { projectId: access.projectId }),
    ...(access.visibility === undefined ? {} : { visibility: access.visibility }),
    ...(access.creatorUserId === undefined ? {} : { creatorUserId: access.creatorUserId }),
  }
}

function failureCode(value: unknown): CollaborationError['code'] {
  const code = record(value)?.error
  if (code === 'not-member' || code === 'conversation-not-found' || code === 'forbidden'
    || code === 'visibility-locked') return code
  return 'gateway-unavailable'
}

class GatewayAuthority implements CollaborationAuthority {
  readonly participant: CollaborationParticipant
  readonly expiresAt: number
  readonly signal: AbortSignal

  constructor(
    private readonly runtime: GatewayRuntime,
    private readonly principal: GatewayRequestPrincipal,
    signal: AbortSignal,
    private readonly assertActive: () => void,
  ) {
    const claims = principal.claims
    this.expiresAt = claims.expiresAt
    this.signal = signal
    this.participant = {
      userId: claims.user.id,
      username: claims.user.username,
      displayName: claims.user.displayName,
      role: claims.user.role,
      scope: claims.scope.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: claims.scope.projectId,
          projectName: claims.scope.projectName,
          mode: claims.scope.mode,
        },
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    this.assertActive()
    let response: Response
    try {
      response = await this.runtime.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        principal: this.principal,
      })
    } catch (error: unknown) {
      throw new CollaborationError('gateway-unavailable', `Gateway collaboration request failed: ${String(error)}`)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new CollaborationError('gateway-unavailable', `Gateway collaboration request returned HTTP ${String(response.status)}`)
    }
    if (!response.ok) throw new CollaborationError(failureCode(value))
    return value
  }

  private async creationAuthorization(sessionId: SessionIdentity): Promise<string | undefined> {
    const pending = this.runtime.sessionCreation(sessionId)
    if (pending === undefined) return undefined
    try {
      return await pending
    } catch (error: unknown) {
      throw new CollaborationError(
        'gateway-unavailable',
        `Gateway session creation authorization failed: ${String(error)}`,
      )
    }
  }

  async authorize(sessionId: SessionIdentity, action: CollaborationAction): Promise<CollaborationAccess> {
    this.assertActive()
    const creationAuthorization = await this.creationAuthorization(sessionId)
    const value = record(await this.post('/internal/runtime/collaboration/authorize', {
      sessionId,
      action,
      ...(creationAuthorization === undefined ? {} : { creationAuthorization }),
    }))
    return accessView(value?.access)
  }

  async readableSessionIds(sessionIds: readonly SessionIdentity[]): Promise<ReadonlySet<SessionIdentity>> {
    this.assertActive()
    if (sessionIds.length === 0) return new Set()
    if (this.participant.scope.kind === 'personal') return new Set(sessionIds)
    const creationAuthorizations = (await Promise.all(sessionIds.map(async (sessionId) => {
      const authorization = await this.creationAuthorization(sessionId)
      return authorization === undefined ? undefined : { sessionId, authorization }
    }))).filter((entry): entry is { sessionId: SessionIdentity; authorization: string } => entry !== undefined)
    const value = record(await this.post('/internal/runtime/collaboration/readable', {
      sessionIds,
      ...(creationAuthorizations.length === 0 ? {} : { creationAuthorizations }),
    }))
    if (!Array.isArray(value?.sessionIds) || !value.sessionIds.every(id => typeof id === 'string')) {
      throw new CollaborationError('gateway-unavailable', 'Gateway returned invalid readable session ids')
    }
    const candidates = new Set(sessionIds.map(String))
    const readable = new Set<SessionIdentity>()
    for (const id of value.sessionIds) {
      if (!candidates.has(id)) {
        throw new CollaborationError('gateway-unavailable', 'Gateway returned an unrequested readable session id')
      }
      readable.add(SessionId(id))
    }
    return readable
  }

  async claimInteraction(
    sessionId: SessionIdentity,
    kind: CollaborationInteractionKind,
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean> {
    this.assertActive()
    if (this.participant.scope.kind === 'personal') return true
    const value = record(await this.post('/internal/runtime/collaboration/claim-interaction', {
      sessionId,
      kind,
      interactionId,
      outcome,
    }))
    if (typeof value?.claimed !== 'boolean') {
      throw new CollaborationError('gateway-unavailable', 'Gateway returned an invalid interaction claim')
    }
    return value.claimed
  }
}

/** Gateway-backed collaboration provider using the verified request principal. */
export class GatewayCollaboration extends Collaboration {
  static inject = ['gatewayRuntime']

  private readonly creations = new AsyncLocalStorage<CollaborationSessionCreation>()
  private readonly lifetime = new AbortController()
  private readonly assertActive = (): void => {
    if (this.lifetime.signal.aborted) {
      throw new CollaborationError('gateway-unavailable', 'Gateway collaboration provider is unavailable')
    }
  }

  constructor(ctx: Context) {
    super(ctx)
    const presetAuthorization: PermissionPresetAuthorization = {
      canSelect: (name) => {
        if (name !== 'danger-full-access') return true
        try {
          return this.ctx.gatewayRuntime.requireCurrent().claims.user.role === 'admin'
        } catch {
          // Permission changes outside an authenticated Gateway request fail closed.
          return false
        }
      },
    }
    ctx.provide('permissionPresetAuthorization', presetAuthorization)
    ctx.effect(
      () => () => { this.lifetime.abort(new Error('Gateway collaboration provider unloaded')) },
      'collaboration-gateway: invalidate captured authorities',
    )
  }

  capture(): CollaborationAuthority {
    this.assertActive()
    return new GatewayAuthority(
      this.ctx.gatewayRuntime,
      this.ctx.gatewayRuntime.requireCurrent(),
      this.lifetime.signal,
      this.assertActive,
    )
  }

  currentCreation(): CollaborationSessionCreation | undefined {
    this.assertActive()
    return this.creations.getStore()
  }

  withSessionCreation<T>(
    creation: CollaborationSessionCreation,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertActive()
    const principal = this.ctx.gatewayRuntime.requireCurrent()
    if (principal.claims.scope.kind === 'personal') return operation()
    if (principal.claims.scope.mode !== 'rw') throw new CollaborationError('forbidden')
    return this.creations.run(creation, operation)
  }
}

export default GatewayCollaboration
