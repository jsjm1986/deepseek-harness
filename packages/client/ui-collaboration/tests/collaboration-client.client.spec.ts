// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  CollaborationClient, CollaborationRequestError, createBrowserCollaborationTransport,
  parseCollaborationContext, parseConversationDetail, type CollaborationContext,
  type CollaborationTransport, type ConversationDetail,
} from '../src/client/collaboration-client.ts'

const projectContext: CollaborationContext = {
  user: { id: 7, username: 'lin', displayName: '林工', role: 'member' },
  scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw' },
  projects: [
    { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' },
    { projectId: 10, name: '审计平台', path: '/srv/audit', mode: 'ro' },
  ],
}

const personalContext: CollaborationContext = {
  ...projectContext,
  scope: { kind: 'personal' },
}

const detail: ConversationDetail = {
  access: {
    sessionId: 'child',
    rootSessionId: 'root',
    projectId: 9,
    visibility: 'project',
    creatorUserId: 7,
    mode: 'rw',
    canRead: true,
    canWrite: true,
    canManage: true,
  },
  conversation: {
    sessionId: 'root',
    creatorUserId: 7,
    creatorDisplayName: '林工',
    visibility: 'project',
    participants: [
      { userId: 7, displayName: '林工', contributionCount: 3, lastContributedAt: 1_700_000_000_000 },
    ],
    updatedAt: 1_700_000_000_100,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function transport(overrides: Partial<CollaborationTransport> = {}): CollaborationTransport {
  return {
    loadContext: vi.fn().mockResolvedValue(projectContext),
    switchScope: vi.fn().mockResolvedValue(undefined),
    loadConversation: vi.fn().mockResolvedValue(detail),
    setVisibility: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    ...overrides,
  }
}

describe('response parsing', () => {
  it('accepts personal and project contexts plus full and null conversation details', () => {
    expect(parseCollaborationContext(personalContext)).toEqual(personalContext)
    expect(parseCollaborationContext(projectContext)).toEqual(projectContext)
    expect(parseConversationDetail(detail)).toEqual(detail)
    expect(parseConversationDetail({ ...detail, conversation: null })).toEqual({ ...detail, conversation: null })
  })

  it('rejects malformed account-context fields at the HTTP boundary', () => {
    const invalid: unknown[] = [
      null,
      [],
      { ...projectContext, user: 'bad' },
      { ...projectContext, user: { ...projectContext.user, id: -1 } },
      { ...projectContext, user: { ...projectContext.user, username: 1 } },
      { ...projectContext, user: { ...projectContext.user, displayName: null } },
      { ...projectContext, user: { ...projectContext.user, role: false } },
      { ...projectContext, scope: { kind: 'other' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1.5, projectName: 'x', mode: 'rw' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1, projectName: 2, mode: 'rw' } },
      { ...projectContext, scope: { kind: 'project', projectId: 1, projectName: 'x', mode: 'owner' } },
      { ...projectContext, projects: null },
      { ...projectContext, projects: [{ projectId: 1, name: 'x', path: 2, mode: 'rw' }] },
      { ...projectContext, projects: [{ projectId: 1, name: 'x', path: '/x', mode: 'owner' }] },
    ]
    for (const value of invalid) expect(() => parseCollaborationContext(value)).toThrow('invalid collaboration response')
  })

  it('rejects malformed conversation detail fields at the HTTP boundary', () => {
    const invalid: unknown[] = [
      1,
      { ...detail, access: null },
      { ...detail, access: { ...detail.access, canRead: false } },
      { ...detail, access: { ...detail.access, sessionId: null } },
      { ...detail, access: { ...detail.access, rootSessionId: 1 } },
      { ...detail, access: { ...detail.access, projectId: Number.NaN } },
      { ...detail, access: { ...detail.access, visibility: 'personal' } },
      { ...detail, access: { ...detail.access, creatorUserId: -1 } },
      { ...detail, access: { ...detail.access, mode: 'owner' } },
      { ...detail, access: { ...detail.access, canWrite: 'yes' } },
      { ...detail, access: { ...detail.access, canManage: 1 } },
      { ...detail, conversation: { ...detail.conversation, participants: null } },
      { ...detail, conversation: { ...detail.conversation, sessionId: 1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, creatorUserId: -1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, creatorDisplayName: 1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, visibility: 'personal', participants: [] } },
      { ...detail, conversation: { ...detail.conversation, updatedAt: -1, participants: [] } },
      { ...detail, conversation: { ...detail.conversation, participants: [{
        userId: 1, displayName: 'x', contributionCount: -1, lastContributedAt: 1,
      }] } },
      { ...detail, conversation: { ...detail.conversation, participants: [{
        userId: 1, displayName: 'x', contributionCount: 1, lastContributedAt: 'now',
      }] } },
    ]
    for (const value of invalid) expect(() => parseConversationDetail(value)).toThrow('invalid collaboration response')
  })
})

describe('browser transport', () => {
  it('uses the Gateway account routes, encodes session ids, and reloads through the injected callback', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(projectContext))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    const reload = vi.fn()
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload })
    const signal = new AbortController().signal

    await expect(api.loadContext(signal)).resolves.toEqual(projectContext)
    await expect(api.switchScope({ kind: 'project', projectId: 9 }, signal)).resolves.toBeUndefined()
    await expect(api.loadConversation('root/child', signal)).resolves.toEqual(detail)
    await expect(api.setVisibility('root/child', 'private', signal)).resolves.toBeUndefined()
    api.reload()

    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/context', {
      credentials: 'same-origin', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/scope', {
      credentials: 'same-origin', method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', projectId: 9 }),
    })
    expect(fetcher).toHaveBeenNthCalledWith(3, '/account/api/conversations/root%2Fchild', {
      credentials: 'same-origin', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(4, '/account/api/conversations/root%2Fchild', {
      credentials: 'same-origin', method: 'PATCH', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('uses the account project and invitation routes', async () => {
    const invitation = {
      id: 'invite-1', projectId: 9, projectName: '支付重构',
      invitee: { id: 8, username: 'zhou', displayName: '周工' },
      inviter: { id: 7, username: 'lin', displayName: '林工' },
      mode: 'rw', status: 'pending', expiresAt: null,
      createdAt: '2026-08-16T00:00:00.000Z', respondedAt: null,
    }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 12 }))
      .mockResolvedValueOnce(Response.json([invitation]))
      .mockResolvedValueOnce(Response.json(invitation))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.createProject?.('新项目', signal)).resolves.toEqual({ projectId: 12 })
    await expect(api.listInvitations?.(undefined, signal)).resolves.toEqual([invitation])
    await expect(api.inviteMember?.(9, 'zhou', 'rw', signal)).resolves.toEqual(invitation)
    await expect(api.acceptInvitation?.('invite/1', signal)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenNthCalledWith(1, '/account/api/projects', expect.objectContaining({ method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/account/api/invitations', expect.objectContaining({ credentials: 'same-origin' }))
    expect(fetcher).toHaveBeenNthCalledWith(3, '/account/api/projects/9/invitations', expect.objectContaining({ method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(4, '/account/api/invitations/invite%2F1/accept', expect.objectContaining({ method: 'POST' }))
  })

  it('retains machine error codes and tolerates malformed error bodies', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'visibility-locked' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 1 }, { status: 500 }))
      .mockResolvedValueOnce(new Response('not-json', { status: 502 })) as unknown as typeof fetch
    const api = createBrowserCollaborationTransport({ fetch: fetcher, reload: vi.fn() })
    const signal = new AbortController().signal

    await expect(api.setVisibility('s', 'private', signal)).rejects.toEqual(
      new CollaborationRequestError(409, 'visibility-locked'),
    )
    await expect(api.switchScope({ kind: 'personal' }, signal)).rejects.toEqual(
      new CollaborationRequestError(500),
    )
    await expect(api.loadConversation('s', signal)).rejects.toEqual(
      new CollaborationRequestError(502),
    )
  })

  it('uses browser defaults when no transport overrides are supplied', () => {
    const original = globalThis.fetch
    const fake = vi.fn() as unknown as typeof fetch
    globalThis.fetch = fake
    try {
      const api = createBrowserCollaborationTransport()
      expect(api.loadContext).toBeTypeOf('function')
      expect(api.reload).toBeTypeOf('function')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('CollaborationClient', () => {
  it('coalesces context loads, publishes project context, stages visibility, and clears details in personal scope', async () => {
    const first = deferred<CollaborationContext>()
    const loadContext = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(personalContext)
    const api = transport({ loadContext })
    const client = new CollaborationClient(api)
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)

    const one = client.load()
    const two = client.load()
    expect(one).toBe(two)
    expect(client.getSnapshot().status).toBe('loading')
    first.resolve(projectContext)
    await one
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: projectContext })
    client.stageVisibility('private')
    expect(client.getSnapshot().stagedVisibility).toBe('private')
    await client.loadConversation('child')
    expect(client.getSnapshot().conversations.child?.status).toBe('ready')
    await client.load()
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: personalContext, conversations: {} })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('marks an initial context failure unavailable but preserves ready data on refresh failure', async () => {
    const loadContext = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(projectContext)
      .mockRejectedValueOnce(new Error('offline again'))
    const client = new CollaborationClient(transport({ loadContext }))
    await client.load()
    expect(client.getSnapshot().status).toBe('unavailable')
    await client.load()
    expect(client.getSnapshot().status).toBe('ready')
    await client.load()
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', context: projectContext })
  })

  it('switches scope once, reloads on success, and surfaces a retryable failure', async () => {
    const pending = deferred<undefined>()
    const switchScope = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('denied'))
    const reload = vi.fn()
    const client = new CollaborationClient(transport({ switchScope, reload }))
    const first = client.switchScope({ kind: 'project', projectId: 9 })
    await client.switchScope({ kind: 'personal' })
    expect(switchScope).toHaveBeenCalledTimes(1)
    expect(client.getSnapshot().scopeBusy).toBe(true)
    pending.resolve(undefined)
    await first
    expect(reload).toHaveBeenCalledOnce()
    expect(client.getSnapshot().scopeBusy).toBe(false)
    await client.switchScope({ kind: 'personal' })
    expect(client.getSnapshot()).toMatchObject({ scopeBusy: false, scopeError: 'switch-failed' })
  })

  it('loads, coalesces, retries, and rejects conversation detail outside project scope', async () => {
    const pending = deferred<ConversationDetail>()
    const loadConversation = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()
    const first = client.loadConversation('child')
    await client.loadConversation('child')
    expect(loadConversation).toHaveBeenCalledTimes(1)
    pending.resolve(detail)
    await first
    await client.loadConversation('child')
    expect(loadConversation).toHaveBeenCalledTimes(1)

    await client.loadConversation('retry')
    expect(client.getSnapshot().conversations.retry).toEqual({
      status: 'error', saving: false, error: 'load-failed',
    })
    await client.loadConversation('retry')
    expect(client.getSnapshot().conversations.retry?.status).toBe('ready')

    const personal = new CollaborationClient(transport({ loadContext: vi.fn().mockResolvedValue(personalContext), loadConversation }))
    await personal.load()
    await personal.loadConversation('hidden')
    expect(loadConversation).toHaveBeenCalledTimes(3)
  })

  it('coalesces forced refreshes, retains ready detail while loading, and publishes the trailing result', async () => {
    const first = deferred<ConversationDetail>()
    const second = deferred<ConversationDetail>()
    const refreshed = {
      ...detail,
      conversation: {
        ...detail.conversation!,
        participants: [
          ...detail.conversation!.participants,
          { userId: 8, displayName: '周工', contributionCount: 1, lastContributedAt: 1_700_000_000_200 },
        ],
      },
    }
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()
    await client.loadConversation('child')

    const refresh = client.loadConversation('child', { force: true })
    const coalesced = client.loadConversation('child', { force: true })
    expect(coalesced).toBe(refresh)
    expect(client.getSnapshot().conversations.child).toMatchObject({ status: 'ready', detail })
    first.resolve(detail)
    await vi.waitFor(() => { expect(loadConversation).toHaveBeenCalledTimes(3) })
    second.resolve(refreshed)
    await refresh
    expect(client.getSnapshot().conversations.child).toMatchObject({
      status: 'ready', detail: refreshed,
    })
  })

  it('refreshes cached project conversations after reloading account context', async () => {
    const loadConversation = vi.fn().mockResolvedValue(detail)
    const loadContext = vi.fn().mockResolvedValue(projectContext)
    const client = new CollaborationClient(transport({ loadContext, loadConversation }))
    await client.load()
    await client.loadConversation('child')
    await client.refresh()
    expect(loadContext).toHaveBeenCalledTimes(2)
    expect(loadConversation).toHaveBeenCalledTimes(2)
  })

  it('matches only settled authoritative conversation visibility', async () => {
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new Error('stale refresh failed'))
      .mockRejectedValueOnce(new Error('offline'))
    const client = new CollaborationClient(transport({ loadConversation }))
    await client.load()

    await expect(client.matchesConversationVisibility('matching', 'project')).resolves.toBe(true)
    await expect(client.matchesConversationVisibility('matching', 'private')).resolves.toBe(false)
    await expect(client.matchesConversationVisibility('failed', 'project')).resolves.toBe(false)
  })

  it('rejects visibility reuse while saving or after disposal', async () => {
    const visibilityPending = deferred<undefined>()
    const loadConversation = vi.fn().mockResolvedValue(detail)
    const client = new CollaborationClient(transport({
      loadConversation,
      setVisibility: vi.fn().mockReturnValue(visibilityPending.promise),
    }))
    await client.load()
    await client.loadConversation('saving')
    const save = client.setVisibility('saving', 'private')
    await expect(client.matchesConversationVisibility('saving', 'project')).resolves.toBe(false)
    visibilityPending.resolve(undefined)
    await save
    await vi.waitFor(() => { expect(loadConversation).toHaveBeenCalledTimes(2) })

    client.dispose()
    await expect(client.matchesConversationVisibility('saving', 'private')).resolves.toBe(false)

    const detailPending = deferred<ConversationDetail>()
    const racing = new CollaborationClient(transport({
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
    }))
    await racing.load()
    const match = racing.matchesConversationVisibility('racing', 'project')
    racing.dispose()
    detailPending.resolve(detail)
    await expect(match).resolves.toBe(false)
  })

  it('updates visibility, including null conversation metadata and Gateway lock failures', async () => {
    const setVisibility = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new CollaborationRequestError(409, 'visibility-locked'))
      .mockRejectedValueOnce(new Error('offline'))
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce({ ...detail, conversation: null })
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ setVisibility, loadConversation }))
    await client.load()

    await client.setVisibility('missing', 'private')
    await client.loadConversation('one')
    await client.setVisibility('one', 'project')
    await client.setVisibility('one', 'private')
    expect(client.getSnapshot().conversations.one).toMatchObject({
      status: 'ready', saving: false,
      detail: { access: { visibility: 'private' }, conversation: { visibility: 'private' } },
    })

    await client.loadConversation('two')
    await client.setVisibility('two', 'private')
    expect(client.getSnapshot().conversations.two).toMatchObject({
      status: 'ready', detail: { access: { visibility: 'private' }, conversation: null },
    })

    await client.loadConversation('locked')
    await client.setVisibility('locked', 'private')
    expect(client.getSnapshot().conversations.locked).toMatchObject({
      status: 'ready', saving: false, error: 'visibility-locked',
    })
    await client.loadConversation('offline')
    await client.setVisibility('offline', 'private')
    expect(client.getSnapshot().conversations.offline).toMatchObject({
      status: 'ready', saving: false, error: 'update-failed',
    })
  })

  it('does not mutate visibility without management rights, during a save, or after disposal', async () => {
    const pending = deferred<undefined>()
    const setVisibility = vi.fn().mockReturnValue(pending.promise)
    const cannotManage: ConversationDetail = {
      ...detail,
      access: { ...detail.access, canManage: false },
    }
    const loadConversation = vi.fn()
      .mockResolvedValueOnce(cannotManage)
      .mockResolvedValueOnce(detail)
    const client = new CollaborationClient(transport({ setVisibility, loadConversation }))
    await client.load()
    await client.loadConversation('readonly')
    await client.setVisibility('readonly', 'private')
    expect(setVisibility).not.toHaveBeenCalled()

    await client.loadConversation('saving')
    const save = client.setVisibility('saving', 'private')
    await client.setVisibility('saving', 'private')
    expect(setVisibility).toHaveBeenCalledTimes(1)
    client.dispose()
    client.dispose()
    pending.resolve(undefined)
    await save
    await client.load()
    await client.loadConversation('after')
    await client.switchScope({ kind: 'personal' })
    await client.setVisibility('saving', 'project')
    expect(client.getSnapshot().conversations.saving).toMatchObject({ status: 'ready', saving: true })
  })

  it('suppresses context, conversation, and scope publications after disposal during requests', async () => {
    const contextPending = deferred<CollaborationContext>()
    const detailPending = deferred<ConversationDetail>()
    const scopePending = deferred<undefined>()
    const client = new CollaborationClient(transport({
      loadContext: vi.fn().mockReturnValueOnce(contextPending.promise).mockResolvedValueOnce(projectContext),
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
      switchScope: vi.fn().mockReturnValue(scopePending.promise),
    }))
    const contextLoad = client.load()
    client.dispose()
    contextPending.resolve(projectContext)
    await contextLoad
    expect(client.getSnapshot().status).toBe('loading')

    const active = new CollaborationClient(transport({
      loadConversation: vi.fn().mockReturnValue(detailPending.promise),
      switchScope: vi.fn().mockReturnValue(scopePending.promise),
    }))
    await active.load()
    const conversationLoad = active.loadConversation('child')
    const scopeSwitch = active.switchScope({ kind: 'personal' })
    active.dispose()
    detailPending.resolve(detail)
    scopePending.resolve(undefined)
    await Promise.all([conversationLoad, scopeSwitch])
    expect(active.getSnapshot().conversations.child?.status).toBe('loading')
    expect(active.getSnapshot().scopeBusy).toBe(true)
  })

  it('suppresses rejected scope, conversation, and visibility requests after disposal', async () => {
    const contextPending = deferred<CollaborationContext>()
    const contextClient = new CollaborationClient(transport({ loadContext: vi.fn().mockReturnValue(contextPending.promise) }))
    const contextRequest = contextClient.load()
    contextClient.dispose()
    contextPending.reject(new Error('offline'))
    await contextRequest
    expect(contextClient.getSnapshot().status).toBe('loading')

    const scopePending = deferred<undefined>()
    const scopeClient = new CollaborationClient(transport({ switchScope: vi.fn().mockReturnValue(scopePending.promise) }))
    const scopeRequest = scopeClient.switchScope({ kind: 'personal' })
    scopeClient.dispose()
    scopePending.reject(new Error('offline'))
    await scopeRequest
    expect(scopeClient.getSnapshot().scopeBusy).toBe(true)

    const detailPending = deferred<ConversationDetail>()
    const detailClient = new CollaborationClient(transport({ loadConversation: vi.fn().mockReturnValue(detailPending.promise) }))
    await detailClient.load()
    const detailRequest = detailClient.loadConversation('child')
    detailClient.dispose()
    detailPending.reject(new Error('offline'))
    await detailRequest
    expect(detailClient.getSnapshot().conversations.child?.status).toBe('loading')

    const visibilityPending = deferred<undefined>()
    const visibilityClient = new CollaborationClient(transport({ setVisibility: vi.fn().mockReturnValue(visibilityPending.promise) }))
    await visibilityClient.load()
    await visibilityClient.loadConversation('child')
    const visibilityRequest = visibilityClient.setVisibility('child', 'private')
    visibilityClient.dispose()
    visibilityPending.reject(new Error('offline'))
    await visibilityRequest
    expect(visibilityClient.getSnapshot().conversations.child).toMatchObject({ status: 'ready', saving: true })
  })

  it('ignores visibility settlements after a context refresh removes the conversation cache', async () => {
    const successPending = deferred<undefined>()
    const successClient = new CollaborationClient(transport({
      loadContext: vi.fn().mockResolvedValueOnce(projectContext).mockResolvedValueOnce(personalContext),
      setVisibility: vi.fn().mockReturnValue(successPending.promise),
    }))
    await successClient.load()
    await successClient.loadConversation('child')
    const success = successClient.setVisibility('child', 'private')
    await successClient.load()
    successPending.resolve(undefined)
    await success
    expect(successClient.getSnapshot().conversations).toEqual({})

    const failurePending = deferred<undefined>()
    const failureClient = new CollaborationClient(transport({
      loadContext: vi.fn().mockResolvedValueOnce(projectContext).mockResolvedValueOnce(personalContext),
      setVisibility: vi.fn().mockReturnValue(failurePending.promise),
    }))
    await failureClient.load()
    await failureClient.loadConversation('child')
    const failure = failureClient.setVisibility('child', 'private')
    await failureClient.load()
    failurePending.reject(new Error('offline'))
    await failure
    expect(failureClient.getSnapshot().conversations).toEqual({})
  })
})
