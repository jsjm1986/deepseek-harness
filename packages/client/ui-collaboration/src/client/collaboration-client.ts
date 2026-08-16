import {
  createSnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Visibility of a root conversation inside one project. */
export type CollaborationVisibility = 'project' | 'private'

/** One project membership exposed by the Gateway account context. */
export interface ProjectMembership {
  projectId: number
  name: string
  path: string
  mode: 'ro' | 'rw'
  /** Whether the account may invite members or rename this project. */
  canManage?: boolean
}

/** One project invitation returned by the account API. */
export interface ProjectInvitation {
  id: string
  projectId: number
  projectName: string
  invitee: { id: number; username: string; displayName: string }
  inviter: { id: number; username: string; displayName: string }
  mode: 'ro' | 'rw'
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
  expiresAt: string | null
  createdAt: string
  respondedAt: string | null
}

/** Authenticated user fields required by collaboration presentation. */
export interface CollaborationUser {
  id: number
  username: string
  displayName: string
  role: string
}

/** Active Gateway scope for the browser page. */
export type CollaborationScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number; projectName: string; mode: 'ro' | 'rw' }

/** Gateway account context used by the scope selector and create policy. */
export interface CollaborationContext {
  user: CollaborationUser
  scope: CollaborationScope
  projects: ProjectMembership[]
  /** Whether the current account may select the administrator full-access preset. */
  fullAccess?: boolean
}

/** One user who has contributed to a shared root conversation. */
export interface ConversationParticipant {
  userId: number
  displayName: string
  contributionCount: number
  lastContributedAt: number
}

/** Shared root-conversation metadata displayed in the session header. */
export interface ConversationCollaboration {
  sessionId: string
  creatorUserId: number
  creatorDisplayName: string
  visibility: CollaborationVisibility
  participants: ConversationParticipant[]
  updatedAt: number
}

/** Effective access for the requested session and its root conversation. */
export interface ConversationAccess {
  sessionId: string
  rootSessionId: string
  projectId: number
  visibility: CollaborationVisibility
  creatorUserId: number
  mode: 'ro' | 'rw'
  canRead: true
  canWrite: boolean
  canManage: boolean
}

/** Response returned for one session's collaboration header action. */
export interface ConversationDetail {
  access: ConversationAccess
  conversation: ConversationCollaboration | null
}

/** Per-session detail state kept by the collaboration client. */
export type ConversationDetailState =
  | { status: 'loading'; saving: false }
  | { status: 'error'; saving: false; error: 'load-failed' }
  | { status: 'ready'; detail: ConversationDetail; saving: boolean; error?: 'visibility-locked' | 'update-failed' }

/** Stable observable state shared by the collaboration UI entries. */
export interface CollaborationSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  context?: CollaborationContext
  stagedVisibility: CollaborationVisibility
  scopeBusy: boolean
  scopeError?: string
  conversations: Record<string, ConversationDetailState>
}

/** HTTP operations required by the collaboration state owner. */
export interface CollaborationTransport {
  loadContext: (signal: AbortSignal) => Promise<CollaborationContext>
  switchScope: (scope: { kind: 'personal' } | { kind: 'project'; projectId: number }, signal: AbortSignal) => Promise<void>
  loadConversation: (sessionId: string, signal: AbortSignal) => Promise<ConversationDetail>
  setVisibility: (sessionId: string, visibility: CollaborationVisibility, signal: AbortSignal) => Promise<void>
  /** Optional account project-management operations. */
  createProject?: (name: string, signal: AbortSignal) => Promise<{ projectId: number }>
  listInvitations?: (projectId: number | undefined, signal: AbortSignal) => Promise<ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw', signal: AbortSignal) => Promise<ProjectInvitation>
  acceptInvitation?: (invitationId: string, signal: AbortSignal) => Promise<void>
  reload: () => void
}

/** HTTP error retaining the Gateway's machine-readable collaboration code. */
export class CollaborationRequestError extends Error {
  /**
   * @param status - HTTP response status.
   * @param code - optional Gateway error code.
   */
  constructor(readonly status: number, readonly code?: string) {
    super(code ?? `collaboration request failed with status ${status}`)
    this.name = 'CollaborationRequestError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid collaboration response')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid collaboration response')
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid collaboration response')
  }
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid collaboration response')
  return value
}

function mode(value: unknown): 'ro' | 'rw' {
  if (value !== 'ro' && value !== 'rw') throw new Error('invalid collaboration response')
  return value
}

function actor(value: unknown): { id: number; username: string; displayName: string } {
  const row = object(value)
  return { id: integer(row.id), username: string(row.username), displayName: string(row.displayName) }
}

function invitationStatus(value: unknown): ProjectInvitation['status'] {
  if (value !== 'pending' && value !== 'accepted' && value !== 'declined'
    && value !== 'revoked' && value !== 'expired') throw new Error('invalid collaboration response')
  return value
}

function nullableString(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new Error('invalid collaboration response')
  return value
}

function visibility(value: unknown): CollaborationVisibility {
  if (value !== 'project' && value !== 'private') throw new Error('invalid collaboration response')
  return value
}

function project(value: unknown): ProjectMembership {
  const row = object(value)
  return {
    projectId: integer(row.projectId),
    name: string(row.name),
    path: string(row.path),
    mode: mode(row.mode),
    ...(row.canManage === true ? { canManage: true } : {}),
  }
}

function invitation(value: unknown): ProjectInvitation {
  const row = object(value)
  return {
    id: string(row.id),
    projectId: integer(row.projectId),
    projectName: string(row.projectName),
    invitee: actor(row.invitee),
    inviter: actor(row.inviter),
    mode: mode(row.mode),
    status: invitationStatus(row.status),
    expiresAt: nullableString(row.expiresAt),
    createdAt: string(row.createdAt),
    respondedAt: nullableString(row.respondedAt),
  }
}

function createdProject(value: unknown): { projectId: number } {
  const row = object(value)
  return { projectId: integer(row.id) }
}

/**
 * Decode the account-context response at the HTTP trust boundary.
 * @param value - parsed JSON response.
 * @returns validated collaboration context.
 */
export function parseCollaborationContext(value: unknown): CollaborationContext {
  const root = object(value)
  const user = object(root.user)
  const scope = object(root.scope)
  if (!Array.isArray(root.projects)) throw new Error('invalid collaboration response')
  const parsedScope: CollaborationScope = scope.kind === 'personal'
    ? { kind: 'personal' }
    : scope.kind === 'project'
      ? {
        kind: 'project',
        projectId: integer(scope.projectId),
        projectName: string(scope.projectName),
        mode: mode(scope.mode),
      }
      : (() => { throw new Error('invalid collaboration response') })()
  return {
    user: {
      id: integer(user.id),
      username: string(user.username),
      displayName: string(user.displayName),
      role: string(user.role),
    },
    scope: parsedScope,
    projects: root.projects.map(project),
    ...(root.fullAccess === true ? { fullAccess: true } : {}),
  }
}

function participant(value: unknown): ConversationParticipant {
  const row = object(value)
  return {
    userId: integer(row.userId),
    displayName: string(row.displayName),
    contributionCount: integer(row.contributionCount),
    lastContributedAt: integer(row.lastContributedAt),
  }
}

function conversation(value: unknown): ConversationCollaboration {
  const row = object(value)
  if (!Array.isArray(row.participants)) throw new Error('invalid collaboration response')
  return {
    sessionId: string(row.sessionId),
    creatorUserId: integer(row.creatorUserId),
    creatorDisplayName: string(row.creatorDisplayName),
    visibility: visibility(row.visibility),
    participants: row.participants.map(participant),
    updatedAt: integer(row.updatedAt),
  }
}

/**
 * Decode one conversation collaboration response at the HTTP trust boundary.
 * @param value - parsed JSON response.
 * @returns validated access and root-conversation metadata.
 */
export function parseConversationDetail(value: unknown): ConversationDetail {
  const root = object(value)
  const access = object(root.access)
  if (access.canRead !== true) throw new Error('invalid collaboration response')
  return {
    access: {
      sessionId: string(access.sessionId),
      rootSessionId: string(access.rootSessionId),
      projectId: integer(access.projectId),
      visibility: visibility(access.visibility),
      creatorUserId: integer(access.creatorUserId),
      mode: mode(access.mode),
      canRead: true,
      canWrite: boolean(access.canWrite),
      canManage: boolean(access.canManage),
    },
    conversation: root.conversation === null ? null : conversation(root.conversation),
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = object(await response.json())
    return typeof body.error === 'string' ? body.error : undefined
  } catch (_invalidErrorResponse) {
    return undefined
  }
}

async function jsonRequest<T>(
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetcher(path, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
  return parse(await response.json())
}

async function emptyRequest(fetcher: typeof fetch, path: string, init: RequestInit): Promise<void> {
  const response = await fetcher(path, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
}

/**
 * Create the browser transport for Gateway account collaboration endpoints.
 * @param options - browser fetch and reload overrides.
 * @returns fetch-backed collaboration operations and full-page scope reload.
 */
export function createBrowserCollaborationTransport(options: {
  fetch?: typeof fetch
  reload?: () => void
} = {}): CollaborationTransport {
  const fetcher = options.fetch ?? globalThis.fetch
  const reload = options.reload ?? window.location.reload.bind(window.location)
  const jsonHeaders = { 'content-type': 'application/json' }
  return {
    loadContext: signal => jsonRequest(fetcher, '/account/api/context', { signal }, parseCollaborationContext),
    switchScope: (scope, signal) => emptyRequest(fetcher, '/account/api/scope', {
      method: 'POST', signal, headers: jsonHeaders, body: JSON.stringify(scope),
    }),
    loadConversation: (sessionId, signal) => jsonRequest(
      fetcher,
      `/account/api/conversations/${encodeURIComponent(sessionId)}`,
      { signal },
      parseConversationDetail,
    ),
    setVisibility: (sessionId, nextVisibility, signal) => emptyRequest(
      fetcher,
      `/account/api/conversations/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH', signal, headers: jsonHeaders,
        body: JSON.stringify({ visibility: nextVisibility }),
      },
    ),
    createProject: (name, signal) => jsonRequest(
      fetcher, '/account/api/projects', {
        method: 'POST', signal, headers: jsonHeaders, body: JSON.stringify({ name }),
      }, createdProject,
    ),
    listInvitations: (projectId, signal) => jsonRequest(
      fetcher,
      projectId === undefined
        ? '/account/api/invitations'
        : `/account/api/projects/${String(projectId)}/invitations`,
      { signal },
      (value) => {
        if (!Array.isArray(value)) throw new Error('invalid collaboration response')
        return value.map(invitation)
      },
    ),
    inviteMember: (projectId, username, memberMode, signal) => jsonRequest(
      fetcher, `/account/api/projects/${String(projectId)}/invitations`, {
        method: 'POST', signal, headers: jsonHeaders,
        body: JSON.stringify({ username, mode: memberMode }),
      }, invitation,
    ),
    acceptInvitation: (invitationId, signal) => emptyRequest(
      fetcher, `/account/api/invitations/${encodeURIComponent(invitationId)}/accept`, {
        method: 'POST', signal, headers: jsonHeaders,
      },
    ),
    reload,
  }
}

function initialSnapshot(): CollaborationSnapshot {
  return {
    status: 'idle',
    stagedVisibility: 'project',
    scopeBusy: false,
    conversations: {},
  }
}

/** React-free state owner for Gateway project and shared-conversation data. */
export class CollaborationClient {
  private readonly store = createSnapshotStore(initialSnapshot())
  private readonly abortController = new AbortController()
  private readonly conversationLoads = new Map<string, Promise<void>>()
  private readonly conversationRefreshPending = new Set<string>()
  private contextLoad: Promise<void> | undefined
  private disposed = false

  /**
   * @param transport - Gateway account transport.
   */
  constructor(private readonly transport: CollaborationTransport) {}

  /**
   * Return the stable collaboration snapshot.
   * @returns the current snapshot.
   */
  getSnapshot(): CollaborationSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Subscribe to snapshot replacements.
   * @param listener - change callback.
   * @returns disposer for the callback.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Load or refresh the authenticated account context.
   * @param force - refresh even when a ready snapshot exists.
   * @returns settlement after the current coalesced request.
   */
  load(force = false): Promise<void> {
    if (this.contextLoad !== undefined) return this.contextLoad
    if (this.disposed) return Promise.resolve()
    if (!force && this.getSnapshot().status !== 'ready') {
      this.store.update((draft) => { draft.status = 'loading' })
    }
    const operation = this.transport.loadContext(this.abortController.signal)
      .then((context) => {
        if (this.disposed) return
        this.store.update((draft) => {
          draft.status = 'ready'
          draft.context = context
          delete draft.scopeError
          if (context.scope.kind === 'personal') draft.conversations = {}
        })
      })
      .catch((_contextLoadFailure: unknown) => {
        if (this.disposed) return
        this.store.update((draft) => {
          if (draft.status !== 'ready') draft.status = 'unavailable'
        })
      })
      .finally(() => {
        this.contextLoad = undefined
      })
    this.contextLoad = operation
    return operation
  }

  /**
   * Refresh account context, then revalidate every cached project conversation.
   * @returns settlement after the coalesced account and conversation requests.
   */
  async refresh(): Promise<void> {
    await this.load(true)
    if (this.disposed || this.getSnapshot().context?.scope.kind !== 'project') return
    await Promise.all(Object.keys(this.getSnapshot().conversations)
      .map(sessionId => this.loadConversation(sessionId, { force: true })))
  }

  /**
   * Stage the visibility injected into the next project root-session create.
   * @param nextVisibility - project-visible or creator-private.
   */
  stageVisibility(nextVisibility: CollaborationVisibility): void {
    this.store.update((draft) => { draft.stagedVisibility = nextVisibility })
  }

  /**
   * Persist a new page scope and reload so the Gateway runtime target changes.
   * @param scope - personal runtime or one accessible project runtime.
   * @returns settlement after the HTTP mutation; successful requests reload.
   */
  async switchScope(scope: { kind: 'personal' } | { kind: 'project'; projectId: number }): Promise<void> {
    if (this.disposed || this.getSnapshot().scopeBusy) return
    this.store.update((draft) => {
      draft.scopeBusy = true
      delete draft.scopeError
    })
    try {
      await this.transport.switchScope(scope, this.abortController.signal)
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => { draft.scopeBusy = false })
      this.transport.reload()
    } catch (_scopeSwitchFailure) {
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => {
        draft.scopeBusy = false
        draft.scopeError = 'switch-failed'
      })
    }
  }

  /**
   * Create a user-owned project and refresh the account context.
   * @param name - project display name.
   * @returns the newly allocated public project id.
   */
  async createProject(name: string): Promise<number> {
    if (this.disposed) throw new CollaborationRequestError(499, 'client-disposed')
    const operation = this.transport.createProject
    if (operation === undefined) throw new CollaborationRequestError(503, 'managed-projects-unavailable')
    const result = await operation(name, this.abortController.signal)
    if (this.abortController.signal.aborted) throw new CollaborationRequestError(499, 'client-disposed')
    await this.load(true)
    return result.projectId
  }

  /**
   * Load invitations visible to the account, optionally narrowed to a project.
   * @param projectId - optional project to narrow the invitation list.
   * @returns invitations visible to the current account.
   */
  listInvitations(projectId?: number): Promise<ProjectInvitation[]> {
    if (this.disposed) return Promise.resolve([])
    const operation = this.transport.listInvitations
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'invitations-unavailable'))
    return operation(projectId, this.abortController.signal)
  }

  /**
   * Invite one account to a project.
   * @param projectId - project receiving the invitation.
   * @param username - account username to invite.
   * @param memberMode - access mode granted after acceptance.
   * @returns the persisted pending invitation.
   */
  inviteMember(projectId: number, username: string, memberMode: 'ro' | 'rw'): Promise<ProjectInvitation> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const operation = this.transport.inviteMember
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'invitations-unavailable'))
    return operation(projectId, username, memberMode, this.abortController.signal)
  }

  /**
   * Accept one pending invitation and refresh project membership.
   * @param invitationId - invitation identifier to accept.
   * @returns settlement after the membership refresh.
   */
  async acceptInvitation(invitationId: string): Promise<void> {
    if (this.disposed) throw new CollaborationRequestError(499, 'client-disposed')
    const operation = this.transport.acceptInvitation
    if (operation === undefined) throw new CollaborationRequestError(503, 'invitations-unavailable')
    await operation(invitationId, this.abortController.signal)
    if (this.abortController.signal.aborted) return
    await this.load(true)
  }

  /**
   * Load one requested session's effective access and root collaboration data.
   * @param sessionId - requested session, including a root's descendants.
   * @param options - whether a ready cache entry must be revalidated.
   * @returns settlement after the request or a deliberate no-op.
   */
  loadConversation(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
    const snapshot = this.getSnapshot()
    if (this.disposed || snapshot.context?.scope.kind !== 'project') return Promise.resolve()
    const existing = snapshot.conversations[sessionId]
    const force = options.force === true
    const inFlight = this.conversationLoads.get(sessionId)
    if (inFlight !== undefined) {
      if (!force) return Promise.resolve()
      this.conversationRefreshPending.add(sessionId)
      return inFlight
    }
    if (existing?.status === 'ready' && !force) return Promise.resolve()
    if (existing?.status === 'ready' && existing.saving) {
      this.conversationRefreshPending.add(sessionId)
      return Promise.resolve()
    }

    const projectId = snapshot.context.scope.projectId
    const operation = this.runConversationLoads(sessionId, projectId, force)
      .finally(() => { this.conversationLoads.delete(sessionId) })
    this.conversationLoads.set(sessionId, operation)
    return operation
  }

  /**
   * Revalidate one blank root conversation and compare its authoritative
   * visibility with a prepared Client create request.
   * @param sessionId - reusable blank-session candidate.
   * @param expected - visibility requested for the next root conversation.
   * @returns true only for a settled, matching Gateway response.
   */
  async matchesConversationVisibility(
    sessionId: string,
    expected: CollaborationVisibility,
  ): Promise<boolean> {
    if (this.disposed) return false
    await this.loadConversation(sessionId, { force: true })
    if (this.abortController.signal.aborted) return false
    const state = this.getSnapshot().conversations[sessionId]
    return state?.status === 'ready' && !state.saving
      && state.detail.access.visibility === expected
  }

  private async runConversationLoads(sessionId: string, projectId: number, force: boolean): Promise<void> {
    let refresh = force
    do {
      this.conversationRefreshPending.delete(sessionId)
      const existing = this.getSnapshot().conversations[sessionId]
      if (existing?.status !== 'ready') {
        this.store.update((draft) => {
          draft.conversations[sessionId] = { status: 'loading', saving: false }
        })
      }
      try {
        const detail = await this.transport.loadConversation(sessionId, this.abortController.signal)
        const scope = this.getSnapshot().context?.scope
        if (this.disposed || scope?.kind !== 'project' || scope.projectId !== projectId) return
        this.store.update((draft) => {
          const current = draft.conversations[sessionId]
          const saving = current?.status === 'ready' && current.saving
          draft.conversations[sessionId] = { status: 'ready', detail, saving }
        })
      } catch (_conversationLoadFailure) {
        const scope = this.getSnapshot().context?.scope
        if (this.disposed || scope?.kind !== 'project' || scope.projectId !== projectId) return
        if (this.getSnapshot().conversations[sessionId]?.status !== 'ready') {
          this.store.update((draft) => {
            draft.conversations[sessionId] = { status: 'error', saving: false, error: 'load-failed' }
          })
        }
      }
      refresh = this.conversationRefreshPending.delete(sessionId)
    } while (refresh)
  }

  /**
   * Update a manageable root conversation's visibility and publish the result.
   * @param sessionId - requested session whose root owns visibility.
   * @param nextVisibility - desired root visibility.
   * @returns settlement after the request and snapshot publication.
   */
  async setVisibility(sessionId: string, nextVisibility: CollaborationVisibility): Promise<void> {
    const state = this.getSnapshot().conversations[sessionId]
    if (this.disposed || state?.status !== 'ready'
      || !state.detail.access.canManage || state.saving
      || state.detail.access.visibility === nextVisibility) return
    this.store.update((draft) => {
      draft.conversations[sessionId] = { status: 'ready', detail: state.detail, saving: true }
    })
    try {
      await this.transport.setVisibility(sessionId, nextVisibility, this.abortController.signal)
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => {
        const current = draft.conversations[sessionId]
        if (current?.status !== 'ready') return
        current.saving = false
        current.detail.access.visibility = nextVisibility
        if (current.detail.conversation !== null) current.detail.conversation.visibility = nextVisibility
      })
    } catch (error) {
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => {
        const current = draft.conversations[sessionId]
        if (current?.status !== 'ready') return
        current.saving = false
        current.error = error instanceof CollaborationRequestError && error.code === 'visibility-locked'
          ? 'visibility-locked'
          : 'update-failed'
      })
    } finally {
      if (this.conversationRefreshPending.delete(sessionId)) {
        void this.loadConversation(sessionId, { force: true })
      }
    }
  }

  /** Abort in-flight HTTP operations and suppress later publications. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
  }
}
