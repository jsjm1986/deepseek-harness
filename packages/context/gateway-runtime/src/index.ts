/**
 * Gateway-launched runtime identity and authenticated loopback transport.
 * @module @deepseek-ai/dsh-gateway-runtime
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConnectionRequestBoundary } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** HTTP header carrying one Gateway-signed browser principal. */
export const GATEWAY_PRINCIPAL_HEADER = 'x-dsh-gateway-principal'

/** Runtime identity bound into both the launch credential and every principal. */
export interface GatewayRuntimeIdentity {
  readonly kind: 'user' | 'project'
  readonly id: number
  readonly generation: number
}

/** Scope selected by the authenticated browser request. */
export type GatewayPrincipalScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number; projectName: string; mode: 'ro' | 'rw' }

/** Validated Gateway assertion claims available for one request. */
export interface GatewayPrincipalClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-runtime'
  organization: string
  user: {
    id: number
    username: string
    displayName: string
    role: 'admin' | 'user'
  }
  scope: GatewayPrincipalScope
  runtime: GatewayRuntimeIdentity
  issuedAt: number
  expiresAt: number
  nonce: string
}

/** Private launch credential delivered through an inherited FD or systemd credential file. */
export interface GatewayRuntimeCredential {
  version: 1
  gatewayUrl: string
  organization: string
  runtime: GatewayRuntimeIdentity
  token: string
  principalPublicKey: string
}

/** Request-local assertion and its verified claims. */
export interface GatewayRequestPrincipal {
  assertion: string
  claims: GatewayPrincipalClaims
}

/** Opaque Gateway capability for one delayed project-root materialization. */
export type GatewaySessionCreationAuthorization = Branded<'GatewaySessionCreationAuthorization'>

/**
 * Brand one validated non-empty creation authorization returned by the Gateway.
 * @param value Validated wire authorization.
 * @returns The opaque authorization accepted by Gateway-backed persistence.
 */
export function GatewaySessionCreationAuthorization(value: string): GatewaySessionCreationAuthorization {
  if (value === '') throw new Error('Gateway session creation authorization must not be empty')
  return value as GatewaySessionCreationAuthorization
}

/** Options for one authenticated call to the Gateway's internal runtime API. */
export interface GatewayRuntimeRequestInit extends RequestInit {
  /** Forward the current browser principal when this operation needs user authority. */
  principal?: boolean | GatewayRequestPrincipal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gatewayRuntime: GatewayRuntime
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse and validate one private runtime credential.
 * @param value - decoded credential JSON from the private launch channel.
 * @returns the validated credential.
 */
export function parseGatewayRuntimeCredential(value: unknown): GatewayRuntimeCredential {
  const credential = record(value)
  const runtime = record(credential?.runtime)
  if (credential?.version !== 1 || !nonEmptyString(credential.gatewayUrl)
    || !nonEmptyString(credential.organization) || !nonEmptyString(credential.token)
    || !nonEmptyString(credential.principalPublicKey)
    || (runtime?.kind !== 'user' && runtime?.kind !== 'project')
    || !positiveInteger(runtime.id) || !positiveInteger(runtime.generation)) {
    throw new Error('invalid Gateway runtime credential')
  }
  const gatewayUrl = new URL(credential.gatewayUrl)
  if (gatewayUrl.protocol !== 'http:'
    || (gatewayUrl.hostname !== '127.0.0.1' && gatewayUrl.hostname !== '::1' && gatewayUrl.hostname !== 'localhost')
    || gatewayUrl.username !== '' || gatewayUrl.password !== ''
    || gatewayUrl.pathname !== '/' || gatewayUrl.search !== '' || gatewayUrl.hash !== '') {
    throw new Error('Gateway runtime credential must name a loopback HTTP origin')
  }
  createPublicKey(credential.principalPublicKey)
  return value as GatewayRuntimeCredential
}

function principalClaims(value: unknown): GatewayPrincipalClaims {
  const claims = record(value)
  const user = record(claims?.user)
  const scope = record(claims?.scope)
  const runtime = record(claims?.runtime)
  if (claims?.version !== 1 || claims.issuer !== 'harness-gateway' || claims.audience !== 'dsh-runtime'
    || !nonEmptyString(claims.organization) || !positiveInteger(user?.id)
    || !nonEmptyString(user.username) || typeof user.displayName !== 'string'
    || (user.role !== 'admin' && user.role !== 'user')
    || (scope?.kind !== 'personal' && scope?.kind !== 'project')
    || (runtime?.kind !== 'user' && runtime?.kind !== 'project')
    || !positiveInteger(runtime.id) || !positiveInteger(runtime.generation)
    || typeof claims.issuedAt !== 'number' || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt < 0
    || typeof claims.expiresAt !== 'number' || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || !nonEmptyString(claims.nonce)) {
    throw new Error('invalid Gateway principal assertion')
  }
  if (scope.kind === 'project' && (!positiveInteger(scope.projectId)
    || !nonEmptyString(scope.projectName) || (scope.mode !== 'ro' && scope.mode !== 'rw'))) {
    throw new Error('invalid Gateway principal assertion')
  }
  return value as GatewayPrincipalClaims
}

/**
 * Verify a compact Ed25519 principal against one runtime credential.
 * @param assertion - compact payload and signature issued by the Gateway.
 * @param credential - runtime identity and verification key for this process.
 * @param publicKey - parsed verification key reused across requests.
 * @param now - current epoch milliseconds for assertion lifetime checks.
 * @returns the validated principal claims.
 */
export function verifyGatewayPrincipal(
  assertion: string,
  credential: GatewayRuntimeCredential,
  publicKey: KeyObject = createPublicKey(credential.principalPublicKey),
  now = Date.now(),
): GatewayPrincipalClaims {
  const parts = assertion.split('.')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error('invalid Gateway principal assertion')
  }
  const payload = parts[0] as string
  const signatureText = parts[1] as string
  const payloadBytes = Buffer.from(payload, 'base64url')
  const signature = Buffer.from(signatureText, 'base64url')
  if (payloadBytes.toString('base64url') !== payload || signature.toString('base64url') !== signatureText
    || !verifySignature(null, Buffer.from(payload), publicKey, signature)) {
    throw new Error('invalid Gateway principal assertion')
  }
  let value: unknown
  try {
    value = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('invalid Gateway principal assertion')
  }
  const claims = principalClaims(value)
  if (claims.organization !== credential.organization
    || claims.runtime.kind !== credential.runtime.kind
    || claims.runtime.id !== credential.runtime.id
    || claims.runtime.generation !== credential.runtime.generation
    || claims.issuedAt > now || claims.expiresAt <= now) {
    throw new Error('expired or foreign Gateway principal assertion')
  }
  if (claims.scope.kind === 'personal') {
    if (claims.runtime.kind !== 'user' || claims.user.id !== claims.runtime.id) {
      throw new Error('invalid Gateway principal assertion scope')
    }
  } else if (claims.runtime.kind !== 'project' || claims.scope.projectId !== claims.runtime.id) {
    throw new Error('invalid Gateway principal assertion scope')
  }
  return claims
}

function credentialText(env: NodeJS.ProcessEnv): string {
  const fdText = env.DSH_GATEWAY_CREDENTIAL_FD
  const path = env.DSH_GATEWAY_CREDENTIAL_FILE
  if (fdText !== undefined && path !== undefined) {
    throw new Error('configure exactly one Gateway runtime credential source')
  }
  if (fdText !== undefined) {
    const fd = Number(fdText)
    if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('invalid DSH_GATEWAY_CREDENTIAL_FD')
    return readFileSync(fd, 'utf8')
  }
  if (path !== undefined && path !== '') return readFileSync(path, 'utf8')
  throw new Error('Gateway runtime credential is unavailable')
}

/**
 * Read the launch credential from its private process channel.
 * @param env - process environment naming exactly one credential source.
 * @returns the validated private runtime credential.
 */
export function readGatewayRuntimeCredential(env: NodeJS.ProcessEnv = process.env): GatewayRuntimeCredential {
  let value: unknown
  try {
    value = JSON.parse(credentialText(env))
  } catch (error: unknown) {
    throw new Error(`failed to read Gateway runtime credential: ${String(error)}`)
  }
  return parseGatewayRuntimeCredential(value)
}

/** Authenticated Gateway context for one launched Harness runtime. */
export class GatewayRuntime extends Service {
  static inject = ['connection']

  /** Non-sensitive runtime identity bound to every accepted principal. */
  readonly identity: GatewayRuntimeIdentity
  /** Gateway organization bound to this runtime. */
  readonly organization: string

  private readonly credential: GatewayRuntimeCredential
  private readonly gatewayUrl: URL
  private readonly publicKey: KeyObject
  private readonly requests = new AsyncLocalStorage<GatewayRequestPrincipal>()
  private readonly sessionCreations = new Map<SessionId, Promise<GatewaySessionCreationAuthorization>>()

  constructor(ctx: Context) {
    super(ctx, 'gatewayRuntime')
    this.credential = readGatewayRuntimeCredential()
    this.identity = { ...this.credential.runtime }
    this.organization = this.credential.organization
    this.gatewayUrl = new URL(this.credential.gatewayUrl)
    this.publicKey = createPublicKey(this.credential.principalPublicKey)
    ctx.on('connection/request', (request: ConnectionRequestBoundary, next) => {
      const header = request.headers[GATEWAY_PRINCIPAL_HEADER]
      if (typeof header !== 'string') throw new Error('Gateway principal assertion is required')
      const principal = {
        assertion: header,
        claims: verifyGatewayPrincipal(header, this.credential, this.publicKey),
      }
      return this.requests.run(principal, next)
    })
  }

  /**
   * Return the principal bound to the current HTTP or WebSocket operation.
   * @returns the verified principal, or undefined outside an authenticated operation.
   */
  current(): GatewayRequestPrincipal | undefined {
    return this.requests.getStore()
  }

  /**
   * Return the current principal or reject an operation outside an authenticated request.
   * @returns the verified principal bound to the current operation.
   */
  requireCurrent(): GatewayRequestPrincipal {
    const principal = this.current()
    if (principal === undefined) throw new Error('Gateway request principal is unavailable')
    return principal
  }

  /**
   * Publish one pending lazy-creation capability for other Gateway Consumers.
   * @param sessionId - project root whose first append will materialize it.
   * @param authorization - in-flight or resolved Gateway capability.
   * @returns an exact-registration disposer.
   */
  registerSessionCreation(
    sessionId: SessionId,
    authorization: Promise<GatewaySessionCreationAuthorization>,
  ): () => void {
    const existing = this.sessionCreations.get(sessionId)
    if (existing !== undefined && existing !== authorization) {
      throw new Error(`session "${sessionId}" already has a pending Gateway creation authorization`)
    }
    this.sessionCreations.set(sessionId, authorization)
    return () => {
      if (this.sessionCreations.get(sessionId) === authorization) this.sessionCreations.delete(sessionId)
    }
  }

  /**
   * Read the pending lazy-creation capability for one project root.
   * @param sessionId - candidate project root.
   * @returns the capability promise, or undefined after materialization or rollback.
   */
  sessionCreation(sessionId: SessionId): Promise<GatewaySessionCreationAuthorization> | undefined {
    return this.sessionCreations.get(sessionId)
  }

  /**
   * Call the authenticated loopback API without exposing its bearer token to other plugins.
   * @param path - absolute internal runtime API path.
   * @param options - fetch options and optional current-principal forwarding.
   * @returns the Gateway HTTP response.
   */
  request(path: string, options: GatewayRuntimeRequestInit = {}): Promise<Response> {
    const rawPathname = path.split(/[?#]/, 1)[0] ?? ''
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')
      || rawPathname.split('/').some(segment => segment === '.' || segment === '..')
      || /%(?:25)*2e/i.test(rawPathname)) {
      throw new Error(`invalid Gateway runtime API path: ${path}`)
    }
    const target = new URL(path, this.gatewayUrl)
    if (target.origin !== this.gatewayUrl.origin || !target.pathname.startsWith('/internal/runtime/')) {
      throw new Error(`invalid Gateway runtime API path: ${path}`)
    }
    const { principal = false, ...init } = options
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.credential.token}`)
    if (principal === true) headers.set(GATEWAY_PRINCIPAL_HEADER, this.requireCurrent().assertion)
    else if (principal !== false) headers.set(GATEWAY_PRINCIPAL_HEADER, principal.assertion)
    else headers.delete(GATEWAY_PRINCIPAL_HEADER)
    return fetch(target, { ...init, headers })
  }
}

export default GatewayRuntime
