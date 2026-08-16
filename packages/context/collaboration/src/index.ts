/** Project collaboration capability Service Definition. @module @deepseek-ai/dsh-collaboration */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Authorization verbs applied to a root conversation ACL. */
export type CollaborationAction = 'read' | 'write' | 'manage' | 'approve'

/** Human interaction classes that accept exactly one committed response. */
export type CollaborationInteractionKind = 'approval' | 'question'

/** Visibility of one root conversation inside a project runtime. */
export type CollaborationVisibility = 'project' | 'private'

/** Authenticated human participant attached to one request. */
export interface CollaborationParticipant {
  readonly userId: number
  readonly username: string
  readonly displayName: string
  readonly role: 'admin' | 'user'
  readonly scope:
    | { readonly kind: 'personal' }
    | {
      readonly kind: 'project'
      readonly projectId: number
      readonly projectName: string
      readonly mode: 'ro' | 'rw'
    }
}

/** Root-inherited access facts returned after authorization succeeds. */
export interface CollaborationAccess {
  readonly sessionId: SessionId
  readonly rootSessionId: SessionId
  readonly mode: 'ro' | 'rw'
  readonly canRead: true
  readonly canWrite: boolean
  readonly canManage: boolean
  readonly projectId?: number
  readonly visibility?: CollaborationVisibility
  readonly creatorUserId?: number
}

/** Request-scoped metadata for a new root conversation. */
export interface CollaborationSessionCreation {
  readonly visibility: CollaborationVisibility
}

/** Principal-bound collaboration operations safe to retain for one request or stream lifetime. */
export interface CollaborationAuthority {
  readonly participant: CollaborationParticipant
  /** Assertion expiry; long-lived streams reconnect no later than this instant. */
  readonly expiresAt: number
  /** Aborts when the provider that issued this authority unloads. */
  readonly signal: AbortSignal

  /**
   * Authorize one operation against the session's root ACL.
   * @param sessionId - requested root or descendant session.
   * @param action - operation class to authorize.
   * @returns root-inherited access facts.
   */
  authorize(sessionId: SessionId, action: CollaborationAction): Promise<CollaborationAccess>

  /**
   * Filter a batch to sessions this participant may read.
   * @param sessionIds - candidate root or descendant session ids.
   * @returns the readable subset.
   */
  readableSessionIds(sessionIds: readonly SessionId[]): Promise<ReadonlySet<SessionId>>

  /**
   * Atomically claim one pending human response for a shared conversation.
   * @param sessionId - session that emitted the approval request.
   * @param kind - interaction class whose ids occupy an independent namespace.
   * @param interactionId - stable approval or question request id.
   * @param outcome - exact response payload being committed.
   * @returns true for the first accepted responder; false after another responder won.
   */
  claimInteraction(
    sessionId: SessionId,
    kind: CollaborationInteractionKind,
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean>
}

/** Stable failure codes shared by Gateway-backed Consumers. */
export type CollaborationErrorCode =
  | 'not-member'
  | 'conversation-not-found'
  | 'forbidden'
  | 'visibility-locked'
  | 'gateway-unavailable'

/** Collaboration denial or provider failure with a stable machine-readable code. */
export class CollaborationError extends Error {
  /**
   * Create one collaboration failure.
   * @param code - stable denial or provider failure code.
   * @param message - optional diagnostic override.
   */
  constructor(readonly code: CollaborationErrorCode, message: string = code) {
    super(message)
    this.name = 'CollaborationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    collaboration: Collaboration
  }
}

/** Project collaboration Service Definition consumed by host APIs and persistence providers. */
export abstract class Collaboration extends Service {
  constructor(ctx: Context) {
    super(ctx, 'collaboration')
  }

  /**
   * Capture the authenticated principal for one request or event stream.
   * @returns an authority with participant identity and collaboration operations.
   */
  abstract capture(): CollaborationAuthority

  /**
   * Return new-session metadata visible during the wrapped creation operation.
   * @returns the active creation metadata, or undefined outside a wrapped operation.
   */
  abstract currentCreation(): CollaborationSessionCreation | undefined

  /**
   * Run session creation under an authenticated visibility choice.
   * @param creation - requested root-conversation visibility.
   * @param operation - creation work that synchronously reaches persistence registration.
   * @returns the operation result.
   */
  abstract withSessionCreation<T>(
    creation: CollaborationSessionCreation,
    operation: () => Promise<T>,
  ): Promise<T>
}

export default Collaboration
