/** Gateway PostgreSQL session persistence provider. @module @deepseek-ai/dsh-session-persistence-gateway */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-collaboration'
import type {
  GatewayRequestPrincipal,
  GatewayRuntimeRequestInit,
} from '@deepseek-ai/dsh-gateway-runtime'
import {
  GatewaySessionCreationAuthorization,
  type GatewaySessionCreationAuthorization as SessionCreationAuthorization,
} from '@deepseek-ai/dsh-gateway-runtime'
import {
  isSurfaceEligibleType,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionPersistenceRevision as PersistenceRevision,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const EVENT_ENVELOPE_KEYS = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
])

interface PendingSessionCreation {
  visibility: 'project' | 'private'
  header: SessionHeader
  authorization: Promise<SessionCreationAuthorization>
  unregister: () => void
}

/** Provider tunables for coordinator caching, write coalescing, and loopback requests. */
export interface Config {
  /** Maximum number of cold prepared sessions retained for a later resume. */
  preparedSessionCacheSize?: number
  /** Maximum delay before one live event batch is flushed. */
  writeBatchMaxDelayMs?: number
  /** Deadline for one internal Gateway HTTP request. */
  requestTimeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
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
    && nonNegativeInteger(operation.start)
    && nonNegativeInteger(operation.end)
}

function jsonSerializable(value: unknown): boolean {
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === 'string'
  } catch {
    return false
  }
}

function headerFrom(value: unknown): SessionHeader {
  const header = record(value)
  if (typeof header?.id !== 'string' || header.id === '' || !safeInteger(header.version)
    || !nonNegativeInteger(header.createdAt) || !optionalString(header.cwd)
    || !optionalString(header.parentSession)
    || (header.seedLength !== undefined && !nonNegativeInteger(header.seedLength))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined && !nonNegativeInteger(header.delegationDepth))
    || !optionalString(header.agentPreset)) {
    throw new Error('Gateway returned an invalid session header')
  }
  return {
    id: SessionId(header.id),
    version: header.version,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: SessionId(header.parentSession) }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

function eventsFrom(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new Error('Gateway returned an invalid session event list')
  return value.map((candidate) => {
    const event = record(candidate)
    if (event === undefined || !Object.keys(event).every(key => EVENT_ENVELOPE_KEYS.has(key))
      || !Object.hasOwn(event, 'type') || typeof event.type !== 'string' || event.type === ''
      || !Object.hasOwn(event, 'seq') || !nonNegativeInteger(event.seq)
      || !Object.hasOwn(event, 'time') || !nonNegativeInteger(event.time)
      || !Object.hasOwn(event, 'data') || !jsonSerializable(event.data)
      || (Object.hasOwn(event, 'sourceEventSeqs') && (!Array.isArray(event.sourceEventSeqs)
        || !event.sourceEventSeqs.every(nonNegativeInteger)))
      || (Object.hasOwn(event, 'ignorable') && event.ignorable !== true)) {
      throw new Error('Gateway returned an invalid session event list')
    }
    const isSurfaceEvent = isSurfaceEligibleType(event.type) || event.type === 'steering/message'
    const hasSurfaceOp = Object.hasOwn(event, 'surfaceOp')
    const hasSourceEventSeqs = Object.hasOwn(event, 'sourceEventSeqs')
    if ((isSurfaceEvent && (!hasSurfaceOp || !surfaceOp(event.surfaceOp)))
      || (!isSurfaceEvent && (hasSurfaceOp || hasSourceEventSeqs))) {
      throw new Error('Gateway returned an invalid session event list')
    }
    return candidate as SessionEvent
  })
}

function deterministicBatchId(kind: 'append' | 'repair', sessionId: SessionId, value: unknown): string {
  const bytes = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(JSON.stringify(value))
    .digest()
    .subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Gateway-backed session persistence using `PersistenceCoordinator` for lifecycle orchestration. */
export class GatewaySessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-gateway'

  static inject = ['sessions', 'gatewayRuntime']
  static Config: z<Config> = z.object({
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_TIMEOUT_MS),
  })

  private readonly coordinator: PersistenceCoordinator<never>
  private readonly creations = new Map<SessionId, PendingSessionCreation>()
  private readonly requestTimeoutMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    ctx.on('session/created', (session) => { this.rememberCreation(session.header) })
    this.coordinator = new PersistenceCoordinator(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
    ctx.on('session/disposed', (session) => {
      void ctx.sessions.flush(session).then(
        () => { this.forgetCreation(session.id) },
        () => {
          // The coordinator reports the failed retirement; retain creation identity for its retry.
        },
      )
    })
  }

  /** PostgreSQL owns no independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    const creation = this.rememberCreation(meta)
    return this.coordinator.create(meta).catch((error: unknown) => {
      if (creation !== undefined) this.forgetCreation(meta.id, creation)
      throw error
    })
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  }

  private rememberCreation(header: SessionHeader): PendingSessionCreation | undefined {
    const creation = this.ctx.get('collaboration')?.currentCreation()
    if (creation === undefined) return this.creations.get(header.id)
    const principal = this.ctx.gatewayRuntime.current()
    if (principal === undefined) {
      throw new Error('Gateway session creation requires an authenticated principal')
    }
    const existing = this.creations.get(header.id)
    if (existing !== undefined) {
      if (existing.visibility !== creation.visibility
        || JSON.stringify(existing.header) !== JSON.stringify(header)) {
        throw new Error(`session "${header.id}" has conflicting Gateway creation metadata`)
      }
      return existing
    }
    const authorization = this.prepareCreation(header, creation.visibility, principal)
    void authorization.catch(() => {})
    const pending: PendingSessionCreation = {
      visibility: creation.visibility,
      header,
      authorization,
      unregister: () => {},
    }
    pending.unregister = this.ctx.gatewayRuntime.registerSessionCreation(header.id, authorization)
    this.creations.set(header.id, pending)
    return pending
  }

  private forgetCreation(id: SessionId, expected?: PendingSessionCreation): void {
    const creation = this.creations.get(id)
    if (creation === undefined || (expected !== undefined && creation !== expected)) return
    this.creations.delete(id)
    creation.unregister()
  }

  private async prepareCreation(
    header: SessionHeader,
    visibility: 'project' | 'private',
    principal: GatewayRequestPrincipal,
  ): Promise<SessionCreationAuthorization> {
    const value = record(await this.request('/internal/runtime/session/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ header, visibility }),
      principal,
    }))
    if (typeof value?.authorization !== 'string' || value.authorization === '') {
      throw new Error('Gateway returned an invalid session creation authorization')
    }
    return GatewaySessionCreationAuthorization(value.authorization)
  }

  private async request(path: string, init: GatewayRuntimeRequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const response = await this.ctx.gatewayRuntime.request(path, { ...init, signal: this.signal(signal) })
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error(`Gateway session persistence returned HTTP ${String(response.status)}`)
    }
    if (!response.ok) {
      const detail = record(value)?.error
      throw new Error(`Gateway session persistence failed: ${typeof detail === 'string' ? detail : `HTTP ${String(response.status)}`}`)
    }
    return value
  }

  private async optional(path: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const response = await this.ctx.gatewayRuntime.request(path, { signal: this.signal(signal) })
    if (response.status === 404) return undefined
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error(`Gateway session persistence returned HTTP ${String(response.status)}`)
    }
    if (!response.ok) throw new Error(`Gateway session persistence failed with HTTP ${String(response.status)}`)
    return value
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    const value = record(await this.optional(
      `/internal/runtime/session/load?sessionId=${encodeURIComponent(id)}`,
      signal,
    ))
    if (value === undefined) return undefined
    if (typeof value.revision !== 'string' || value.revision === '') {
      throw new Error('Gateway returned an invalid session revision')
    }
    return {
      meta: headerFrom(value.header),
      events: eventsFrom(value.events),
      revision: SessionPersistenceRevision(value.revision),
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    const value = record(await this.request(
      `/internal/runtime/session/revision?sessionId=${encodeURIComponent(id)}`,
      {},
      signal,
    ))
    if (value?.revision === null) return undefined
    if (typeof value?.revision !== 'string' || value.revision === '') {
      throw new Error('Gateway returned an invalid session revision')
    }
    return SessionPersistenceRevision(value.revision)
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    const value = record(await this.optional(
      `/internal/runtime/session/read-from?sessionId=${encodeURIComponent(id)}&fromSeq=${String(fromSeq)}`,
      signal,
    ))
    if (value === undefined) return undefined
    return { meta: headerFrom(value.header), events: eventsFrom(value.events) }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    const creation = isMaterialized ? undefined : this.creations.get(meta.id)
    const authorization = creation === undefined ? undefined : await creation.authorization
    await this.request('/internal/runtime/session/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: meta.id,
        batchId: deterministicBatchId('append', meta.id, events),
        events,
        ...isMaterialized ? {} : {
          ...(authorization === undefined ? { header: meta } : { creationAuthorization: authorization }),
        },
      }),
    })
    if (creation !== undefined) this.forgetCreation(meta.id, creation)
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length === 0) return
    await this.request('/internal/runtime/session/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: meta.id,
        batchId: deterministicBatchId('repair', meta.id, closers),
        closers,
      }),
    })
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listSnapshots(signal)).map(snapshot => snapshot.header)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const value = record(await this.request('/internal/runtime/session/list', {}, signal))
    if (!Array.isArray(value?.items)) throw new Error('Gateway returned an invalid session list')
    return value.items.map((candidate) => {
      const item = record(candidate)
      if (typeof item?.revision !== 'string' || item.revision === '') {
        throw new Error('Gateway returned an invalid session list revision')
      }
      return {
        header: headerFrom(item.header),
        revision: SessionPersistenceRevision(item.revision),
      }
    })
  }
}

export default GatewaySessionPersistence
