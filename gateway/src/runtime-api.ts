import type { IncomingMessage, ServerResponse } from 'node:http'
import { CollaborationDeniedError } from './collaboration.ts'
import type { RuntimeTarget } from './instances.ts'
import {
  PRINCIPAL_HEADER,
  type GatewayPrincipalClaims,
  type GatewayPrincipalSigner,
  type GatewaySessionCreationClaims,
  type GatewaySessionCreationHeader,
} from './principal.ts'
import type {
  ConversationEvent,
  ConversationHeader,
  ConversationRepository,
  StoredConversation,
} from './postgres/conversation-repository.ts'
import type { PostgresInstanceRepository } from './postgres/instance-repository.ts'
import type { PostgresCollaborationService } from './postgres/collaboration-service.ts'
import { internalUserId, type PostgresRuntimeContext } from './postgres/runtime-context.ts'

interface RuntimeCredentialSubject {
  organizationId: string
  target: RuntimeTarget
  generation: number
  userInternalId?: string
  projectInternalId?: string
}

type RuntimeSessionHeader = GatewaySessionCreationHeader

const MAX_READABLE_SESSION_IDS = 5000
const EVENT_ENVELOPE_KEYS = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
])
const SURFACE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
])

interface RuntimeApiDependencies {
  context: Pick<PostgresRuntimeContext, 'pool' | 'organizationSlug'>
  instances: Pick<PostgresInstanceRepository, 'authenticateRuntimeToken'>
  conversations: Pick<ConversationRepository, 'append' | 'listScoped' | 'load'>
  collaboration: Pick<
    PostgresCollaborationService,
    'access' | 'claimInteraction' | 'projectForUser' | 'readableSessionIds'
  >
  principals: GatewayPrincipalSigner
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function surfaceOp(value: unknown): boolean {
  if (value === 'append') return true
  const operation = record(value)
  return operation !== undefined
    && Object.keys(operation).length === 3
    && operation.op === 'replace'
    && safeInteger(operation.start)
    && safeInteger(operation.end)
}

function jsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined
  } catch {
    return false
  }
}

function sessionHeader(value: unknown): RuntimeSessionHeader {
  const header = record(value)
  if (header === undefined || typeof header.id !== 'string' || header.id === ''
    || !safeInteger(header.version) || !safeInteger(header.createdAt)
    || !optionalString(header.cwd) || !optionalString(header.parentSession)
    || (header.seedLength !== undefined && !safeInteger(header.seedLength))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined && !safeInteger(header.delegationDepth))
    || !optionalString(header.agentPreset)) {
    throw new Error('invalid session header')
  }
  return value as RuntimeSessionHeader
}

function conversationEvents(value: unknown): ConversationEvent[] {
  if (!Array.isArray(value)) throw new Error('invalid conversation event batch')
  return value.map((candidate) => {
    const event = record(candidate)
    if (event === undefined || !Object.keys(event).every(key => EVENT_ENVELOPE_KEYS.has(key))
      || !Object.hasOwn(event, 'type') || typeof event.type !== 'string' || event.type === ''
      || !Object.hasOwn(event, 'seq') || !safeInteger(event.seq)
      || !Object.hasOwn(event, 'time') || !safeInteger(event.time)
      || !Object.hasOwn(event, 'data') || !jsonSerializable(event.data)
      || (Object.hasOwn(event, 'sourceEventSeqs') && (!Array.isArray(event.sourceEventSeqs)
        || !event.sourceEventSeqs.every(seq => safeInteger(seq))))
      || (Object.hasOwn(event, 'ignorable') && event.ignorable !== true)) {
      throw new Error('invalid conversation event batch')
    }
    const isSurfaceEvent = SURFACE_EVENT_TYPES.has(event.type)
    const hasSurfaceOp = Object.hasOwn(event, 'surfaceOp')
    const hasSourceEventSeqs = Object.hasOwn(event, 'sourceEventSeqs')
    if ((isSurfaceEvent && (!hasSurfaceOp || !surfaceOp(event.surfaceOp)))
      || (!isSurfaceEvent && (hasSurfaceOp || hasSourceEventSeqs))) {
      throw new Error('invalid conversation event batch')
    }
    return candidate as ConversationEvent
  })
}

function runtimeHeader(header: ConversationHeader): RuntimeSessionHeader {
  return {
    id: header.id,
    version: header.sessionFormatVersion,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSessionId === undefined ? {} : { parentSession: header.parentSessionId }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    ...(header.origin === undefined ? {} : { origin: header.origin as 'subagent' }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

function assertionHeader(req: IncomingMessage): string | undefined {
  const value = req.headers[PRINCIPAL_HEADER]
  return typeof value === 'string' ? value : undefined
}

function authorizationToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length)
  return token === '' ? undefined : token
}

function assertionFor(
  req: IncomingMessage,
  authority: GatewayPrincipalSigner,
  subject: RuntimeCredentialSubject,
  required: boolean,
): GatewayPrincipalClaims | undefined {
  const assertion = assertionHeader(req)
  if (assertion === undefined) {
    if (required) throw new CollaborationDeniedError('forbidden')
    return undefined
  }
  const claims = authority.verify(assertion)
  if (claims.runtime.kind !== subject.target.kind || claims.runtime.id !== subject.target.id
    || claims.runtime.generation !== subject.generation) {
    throw new CollaborationDeniedError('forbidden')
  }
  if (subject.target.kind === 'user') {
    if (claims.scope.kind !== 'personal' || claims.user.id !== subject.target.id) {
      throw new CollaborationDeniedError('forbidden')
    }
  } else if (claims.scope.kind !== 'project' || claims.scope.projectId !== subject.target.id) {
    throw new CollaborationDeniedError('forbidden')
  }
  return claims
}

function belongsToRuntime(header: ConversationHeader, subject: RuntimeCredentialSubject): boolean {
  if (header.organizationId !== subject.organizationId) return false
  if (subject.target.kind === 'user') {
    return header.projectId === undefined && header.creatorUserId === subject.userInternalId
  }
  return header.projectId === subject.projectInternalId
}

function revisionFor(subject: RuntimeCredentialSubject, revision: string): string {
  return `postgres:${subject.organizationId}:${subject.target.kind}:${String(subject.target.id)}:${revision}`
}

/** Authenticated loopback API used by Gateway-backed runtime plugins. */
export function createRuntimeApiHandler(
  deps: RuntimeApiDependencies,
): (req: IncomingMessage, res: ServerResponse, pathname: string, body: string) => Promise<boolean> {
  const authenticate = async (req: IncomingMessage): Promise<RuntimeCredentialSubject | null> => {
    const token = authorizationToken(req)
    return token === undefined ? null : deps.instances.authenticateRuntimeToken(token)
  }

  const stored = async (sessionId: string, subject: RuntimeCredentialSubject): Promise<StoredConversation | undefined> => {
    const value = await deps.conversations.load(sessionId)
    return value !== undefined && belongsToRuntime(value.header, subject) ? value : undefined
  }

  const createHeader = async (
    req: IncomingMessage,
    subject: RuntimeCredentialSubject,
    header: RuntimeSessionHeader,
    visibility: unknown,
  ): Promise<ConversationHeader> => {
    if (visibility !== undefined && visibility !== 'project' && visibility !== 'private') {
      throw new Error('invalid conversation visibility')
    }
    let creatorUserId = subject.userInternalId
    if (subject.target.kind === 'project') {
      if (header.parentSession === undefined) throw new CollaborationDeniedError('forbidden')
      assertionFor(req, deps.principals, subject, false)
      creatorUserId = undefined
    } else {
      assertionFor(req, deps.principals, subject, false)
    }
    return {
      id: header.id,
      organizationId: subject.organizationId,
      ...(creatorUserId === undefined ? {} : { creatorUserId }),
      ...(subject.projectInternalId === undefined ? {} : { projectId: subject.projectInternalId }),
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(subject.target.kind === 'project'
        ? { visibility: (visibility ?? 'project') as 'project' | 'private' }
        : { visibility: 'personal' as const }),
      sessionFormatVersion: header.version,
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    }
  }

  const verifyCreation = (
    authorization: string,
    subject: RuntimeCredentialSubject,
    sessionId: string,
  ): GatewaySessionCreationClaims => {
    const claims = deps.principals.verifySessionCreation(authorization)
    if (subject.target.kind !== 'project' || subject.projectInternalId === undefined
      || claims.organization !== deps.context.organizationSlug
      || claims.runtime.kind !== subject.target.kind || claims.runtime.id !== subject.target.id
      || claims.runtime.generation !== subject.generation) {
      throw new Error('invalid session creation authorization')
    }
    if (claims.header.id !== sessionId || claims.header.parentSession !== undefined) {
      throw new Error('invalid session creation authorization')
    }
    return claims
  }

  const creationHeader = async (
    authorization: string,
    subject: RuntimeCredentialSubject,
    sessionId: string,
  ): Promise<ConversationHeader> => {
    const claims = verifyCreation(authorization, subject, sessionId)
    const membership = await deps.collaboration.projectForUser(subject.target.id, claims.creatorUserId)
    if (membership === null || membership.mode !== 'rw') throw new CollaborationDeniedError('forbidden')
    const creatorUserId = await internalUserId(
      deps.context.pool,
      subject.organizationId,
      claims.creatorUserId,
    )
    if (creatorUserId === null) throw new CollaborationDeniedError('forbidden')
    return {
      id: claims.header.id,
      organizationId: subject.organizationId,
      creatorUserId,
      projectId: subject.projectInternalId,
      visibility: claims.visibility,
      sessionFormatVersion: claims.header.version,
      createdAt: claims.header.createdAt,
      ...(claims.header.cwd === undefined ? {} : { cwd: claims.header.cwd }),
      ...(claims.header.seedLength === undefined ? {} : { seedLength: claims.header.seedLength }),
      ...(claims.header.origin === undefined ? {} : { origin: claims.header.origin }),
      ...(claims.header.delegationDepth === undefined
        ? {} : { delegationDepth: claims.header.delegationDepth }),
      ...(claims.header.agentPreset === undefined ? {} : { agentPreset: claims.header.agentPreset }),
    }
  }

  const creationAccess = async (
    authorization: string,
    subject: RuntimeCredentialSubject,
    actor: GatewayPrincipalClaims,
    sessionId: string,
    action: 'read' | 'write' | 'manage' | 'approve',
  ) => {
    const claims = verifyCreation(authorization, subject, sessionId)
    const membership = await deps.collaboration.projectForUser(subject.target.id, actor.user.id)
    if (membership === null) throw new CollaborationDeniedError('not-member')
    const isCreator = actor.user.id === claims.creatorUserId
    const canRead = membership.administrator || claims.visibility === 'project' || isCreator
    const canWrite = membership.mode === 'rw' && canRead
    const canManage = membership.mode === 'rw' && (membership.administrator || isCreator)
    if (!canRead || (action === 'write' && !canWrite) || (action === 'approve' && !canWrite)
      || (action === 'manage' && !canManage)) {
      throw new CollaborationDeniedError('forbidden')
    }
    return {
      sessionId,
      rootSessionId: sessionId,
      projectId: subject.target.id,
      visibility: claims.visibility,
      creatorUserId: claims.creatorUserId,
      mode: membership.mode,
      canRead: true as const,
      canWrite,
      canManage,
    }
  }

  return async (req, res, pathname, body) => {
    if (!pathname.startsWith('/internal/runtime/')) return false
    const subject = await authenticate(req)
    if (subject === null) {
      send(res, 401, { error: 'invalid-runtime-token' })
      return true
    }
    try {
      const url = new URL(req.url ?? '/', 'http://runtime')
      if (pathname === '/internal/runtime/session/create' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        const header = sessionHeader(payload?.header)
        if (subject.target.kind !== 'project' || header.parentSession !== undefined
          || (payload?.visibility !== undefined
            && payload.visibility !== 'project' && payload.visibility !== 'private')) {
          throw new Error('invalid session creation request')
        }
        const claims = assertionFor(req, deps.principals, subject, true)!
        const membership = await deps.collaboration.projectForUser(subject.target.id, claims.user.id)
        if (membership === null || membership.mode !== 'rw'
          || await internalUserId(deps.context.pool, subject.organizationId, claims.user.id) === null) {
          throw new CollaborationDeniedError('forbidden')
        }
        send(res, 200, {
          authorization: deps.principals.issueSessionCreation({
            creatorUserId: claims.user.id,
            runtime: { kind: 'project', id: subject.target.id, generation: subject.generation },
            header,
            visibility: (payload?.visibility ?? 'project') as 'project' | 'private',
          }),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/append' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string' || typeof payload.batchId !== 'string') {
          throw new Error('invalid append request')
        }
        const header = payload.header === undefined ? undefined : sessionHeader(payload.header)
        const creationAuthorization = payload.creationAuthorization
        if ((creationAuthorization !== undefined && (typeof creationAuthorization !== 'string'
          || creationAuthorization === '')) || (header !== undefined && creationAuthorization !== undefined)
          || (header !== undefined && header.id !== payload.sessionId)) {
          throw new Error('invalid append request')
        }
        if (header === undefined && creationAuthorization === undefined
          && await stored(payload.sessionId, subject) === undefined) {
          throw new CollaborationDeniedError('conversation-not-found')
        }
        const materialization = creationAuthorization === undefined
          ? (header === undefined ? undefined : await createHeader(req, subject, header, payload.visibility))
          : await creationHeader(creationAuthorization, subject, payload.sessionId)
        const result = await deps.conversations.append(
          payload.sessionId,
          payload.batchId,
          conversationEvents(payload.events),
          materialization,
        )
        send(res, 200, { result })
        return true
      }

      if (pathname === '/internal/runtime/session/load' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const value = await stored(sessionId, subject)
        if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
        send(res, 200, {
          header: runtimeHeader(value.header),
          events: value.events,
          revision: revisionFor(subject, value.revision),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/read-from' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const fromSeq = Number(url.searchParams.get('fromSeq'))
        if (!safeInteger(fromSeq)) throw new Error('invalid fromSeq')
        const value = await stored(sessionId, subject)
        if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
        send(res, 200, {
          header: runtimeHeader(value.header),
          events: value.events.filter(event => event.seq >= fromSeq),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/revision' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const value = await stored(sessionId, subject)
        send(res, 200, {
          revision: value === undefined ? null : revisionFor(subject, value.revision),
        })
        return true
      }

      if (pathname === '/internal/runtime/session/list' && req.method === 'GET') {
        const items = await deps.conversations.listScoped({
          organizationId: subject.organizationId,
          ...(subject.projectInternalId === undefined ? {} : { projectId: subject.projectInternalId }),
          ...(subject.userInternalId === undefined ? {} : { creatorUserId: subject.userInternalId }),
        })
        send(res, 200, { items: items.map(item => ({
          header: runtimeHeader(item.header),
          revision: revisionFor(subject, item.revision),
        })) })
        return true
      }

      if (pathname === '/internal/runtime/session/repair' && req.method === 'POST') {
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string' || typeof payload.batchId !== 'string') {
          throw new Error('invalid repair request')
        }
        if (await stored(payload.sessionId, subject) === undefined) throw new CollaborationDeniedError('conversation-not-found')
        const closers = conversationEvents(payload.closers)
        if (closers.length > 0) await deps.conversations.append(payload.sessionId, payload.batchId, closers)
        send(res, 200, { repaired: true })
        return true
      }

      if (pathname === '/internal/runtime/collaboration/authorize' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (typeof payload?.sessionId !== 'string'
          || (payload.action !== 'read' && payload.action !== 'write'
            && payload.action !== 'manage' && payload.action !== 'approve')) {
          throw new Error('invalid authorization request')
        }
        const creationAuthorization = payload.creationAuthorization
        if (creationAuthorization !== undefined
          && (typeof creationAuthorization !== 'string' || creationAuthorization === '')) {
          throw new Error('invalid authorization request')
        }
        if (subject.target.kind === 'user') {
          const value = await stored(payload.sessionId, subject)
          if (value === undefined) throw new CollaborationDeniedError('conversation-not-found')
          send(res, 200, {
            access: {
              sessionId: value.header.id,
              rootSessionId: value.header.rootSessionId ?? value.header.id,
              mode: 'rw',
              canRead: true,
              canWrite: true,
              canManage: true,
            },
          })
          return true
        }
        try {
          send(res, 200, { access: await deps.collaboration.access(claims.user.id, payload.sessionId, payload.action) })
        } catch (error: unknown) {
          if (!(error instanceof CollaborationDeniedError && error.code === 'conversation-not-found')
            || creationAuthorization === undefined) throw error
          send(res, 200, {
            access: await creationAccess(
              creationAuthorization,
              subject,
              claims,
              payload.sessionId,
              payload.action,
            ),
          })
        }
        return true
      }

      if (pathname === '/internal/runtime/collaboration/claim-interaction' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (subject.target.kind !== 'project' || typeof payload?.sessionId !== 'string'
          || (payload.kind !== 'approval' && payload.kind !== 'question')
          || typeof payload.interactionId !== 'string' || payload.interactionId === '') {
          throw new Error('invalid interaction claim')
        }
        send(res, 200, {
          claimed: await deps.collaboration.claimInteraction(
            claims.user.id,
            payload.sessionId,
            payload.kind,
            payload.interactionId,
            payload.outcome,
          ),
        })
        return true
      }

      if (pathname === '/internal/runtime/collaboration/readable' && req.method === 'POST') {
        const claims = assertionFor(req, deps.principals, subject, true)!
        const payload = record(JSON.parse(body))
        if (subject.target.kind !== 'project' || !Array.isArray(payload?.sessionIds)
          || payload.sessionIds.length > MAX_READABLE_SESSION_IDS
          || !payload.sessionIds.every(id => typeof id === 'string' && id !== '')) {
          throw new Error('invalid readable session request')
        }
        const requested = new Set(payload.sessionIds)
        const authorizations = payload.creationAuthorizations === undefined
          ? []
          : payload.creationAuthorizations
        if (!Array.isArray(authorizations) || authorizations.length > payload.sessionIds.length
          || !authorizations.every((candidate) => {
            const entry = record(candidate)
            return typeof entry?.sessionId === 'string' && requested.has(entry.sessionId)
              && typeof entry.authorization === 'string' && entry.authorization !== ''
          })) {
          throw new Error('invalid readable session request')
        }
        const readable = new Set(await deps.collaboration.readableSessionIds(
          claims.user.id,
          subject.target.id,
          payload.sessionIds,
        ))
        for (const candidate of authorizations) {
          const entry = record(candidate)!
          const sessionId = entry.sessionId as string
          if (await stored(sessionId, subject) !== undefined) continue
          try {
            await creationAccess(
              entry.authorization as string,
              subject,
              claims,
              sessionId,
              'read',
            )
            readable.add(sessionId)
          } catch (error: unknown) {
            if (!(error instanceof CollaborationDeniedError
              && (error.code === 'forbidden' || error.code === 'not-member'))) throw error
          }
        }
        send(res, 200, {
          sessionIds: payload.sessionIds.filter(sessionId => readable.has(sessionId)),
        })
        return true
      }

      return false
    } catch (error) {
      if (error instanceof CollaborationDeniedError) {
        const status = error.code === 'conversation-not-found' ? 404
          : error.code === 'visibility-locked' ? 409 : 403
        send(res, status, { error: error.code })
        return true
      }
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('invalid '))) {
        send(res, 400, { error: error instanceof Error ? error.message : 'invalid request' })
        return true
      }
      throw error
    }
  }
}
