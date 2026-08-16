/**
 * Gateway collaboration browser plugin: owns the account-context transport,
 * project scope selector, root-conversation visibility UI, and project
 * read-only composer policy.
 */
import type { ClientContext, SessionCreateOptions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  CollaborationClient, createBrowserCollaborationTransport,
  type CollaborationVisibility,
} from './collaboration-client.ts'
import {
  ConversationShareAction, type ConversationShareInjected,
} from './ConversationShareAction.tsx'
import {
  ReadOnlyComposer, type ProjectReadOnlyMatch,
} from './ReadOnlyComposer.tsx'
import { ScopeControl, type ScopeControlInjected } from './ScopeControl.tsx'
import { en, NS, zh, type CollaborationKey } from './locales.ts'

export type {
  CollaborationContext, CollaborationScope, CollaborationSnapshot,
  CollaborationVisibility, ConversationAccess, ConversationCollaboration,
  ConversationDetail, ConversationParticipant, ProjectInvitation, ProjectMembership,
} from './collaboration-client.ts'
export type { ConversationShareActionProps, ConversationShareInjected } from './ConversationShareAction.tsx'
export type { ProjectReadOnlyMatch, ReadOnlyComposerProps } from './ReadOnlyComposer.tsx'
export type { ScopeControlInjected, ScopeControlProps } from './ScopeControl.tsx'
export type { ProjectManagerMode, ProjectManagerModalProps } from './ProjectManagerModal.tsx'
export type { CollaborationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project scope and shared-conversation copy. */
    collaboration: CollaborationKey
  }
}

/** Error raised before a read-only project can create a root session. */
class ProjectReadOnlyError extends Error {
  constructor() {
    super('read-only project members cannot create sessions')
    this.name = 'ProjectReadOnlyError'
  }
}

/** Required services for collaboration slots, session creation, and copy. */
export const inject = ['slots', 'sessions', 'locale']

/** Pure selector installed only while the active project membership is read-only. */
function selectProjectReadOnly(_owner: ComposerChainProps): ProjectReadOnlyMatch {
  return 'project-read-only'
}

/**
 * Compose Gateway collaboration behavior and presentation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-collaboration: dictionaries')

  const collaboration = new CollaborationClient(createBrowserCollaborationTransport())
  ctx.effect(() => {
    void collaboration.load()
    return () => { collaboration.dispose() }
  }, 'ui-collaboration: account context')
  ctx.on('connection/reset', () => { void collaboration.refresh() })

  ctx.on('sessions/prepare-create', async (_options, next): Promise<SessionCreateOptions> => {
    const prepared = await next()
    const snapshot = collaboration.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.context?.scope.kind !== 'project') return prepared
    if (snapshot.context.scope.mode === 'ro') throw new ProjectReadOnlyError()
    return { ...prepared, visibility: snapshot.stagedVisibility }
  })

  ctx.on('sessions/confirm-blank-reuse', async (request, next): Promise<boolean> => {
    const reusable = await next()
    if (!reusable) return false
    const snapshot = collaboration.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.context?.scope.kind !== 'project') return true
    const expected = request.options.visibility
    if (expected === undefined) return false
    return collaboration.matchesConversationVisibility(request.sessionId, expected)
  })

  const hooks = { collaboration }
  const scopeInjected = (): ScopeControlInjected => ({
    hooks,
    switchScope: scope => collaboration.switchScope(scope),
    stageVisibility: (visibility: CollaborationVisibility) => { collaboration.stageVisibility(visibility) },
    createProject: name => collaboration.createProject(name),
    listInvitations: projectId => collaboration.listInvitations(projectId),
    inviteMember: (projectId, username, mode) => collaboration.inviteMember(projectId, username, mode),
    acceptInvitation: id => collaboration.acceptInvitation(id),
  })
  const conversationInjected = (sessionId: SessionId): ConversationShareInjected => ({
    hooks,
    load: () => collaboration.loadConversation(sessionId),
    refresh: () => collaboration.loadConversation(sessionId, { force: true }),
    setVisibility: visibility => collaboration.setVisibility(sessionId, visibility),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'collaboration-scope',
    order: -20,
    locale: NS,
    inject: scopeInjected,
  }, ScopeControl))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'collaboration-sharing',
    order: -20,
    locale: NS,
    inject: conversationInjected,
  }, ConversationShareAction))

  ctx.effect(() => {
    let disposeComposer: (() => void) | undefined
    const reconcile = (): void => {
      const scope = collaboration.getSnapshot().context?.scope
      const readOnly = scope?.kind === 'project' && scope.mode === 'ro'
      if (readOnly && disposeComposer === undefined) {
        disposeComposer = ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer',
          priority: 100,
          locale: NS,
          select: selectProjectReadOnly,
        }, ReadOnlyComposer))
      } else if (!readOnly && disposeComposer !== undefined) {
        disposeComposer()
        disposeComposer = undefined
      }
    }
    const unsubscribe = collaboration.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      disposeComposer?.()
    }
  }, 'ui-collaboration: read-only composer')
}
