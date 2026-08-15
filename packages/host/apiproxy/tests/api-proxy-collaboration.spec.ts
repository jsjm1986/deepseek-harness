import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CollaborationError, type CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  TypertLookupFailure,
  type TypertGatewayAuthorizationRequest,
} from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { HostFrame, MuxFrame, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { authorizeTypertRemote, createApiProxy } from '../src/api-proxy.ts'

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('collaboration-test'), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

function controlledAuthority(): {
  authority: CollaborationAuthority
  firstRead: PromiseWithResolvers<ReadonlySet<SessionId>>
  firstReadStarted: Promise<readonly SessionId[]>
} {
  const firstRead = Promise.withResolvers<ReadonlySet<SessionId>>()
  const started = Promise.withResolvers<readonly SessionId[]>()
  let reads = 0
  return {
    firstRead,
    firstReadStarted: started.promise,
    authority: {
      participant: {
        userId: 7,
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
      },
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      authorize: sessionId => Promise.resolve({
        sessionId,
        rootSessionId: sessionId,
        mode: 'rw',
        canRead: true,
        canWrite: true,
        canManage: true,
        projectId: 41,
        visibility: 'project',
        creatorUserId: 7,
      }),
      readableSessionIds: (sessionIds) => {
        reads += 1
        if (reads === 1) {
          started.resolve([...sessionIds])
          return firstRead.promise
        }
        return Promise.resolve(new Set(sessionIds))
      },
      claimInteraction: () => Promise.resolve(true),
    },
  }
}

function readOnlyAuthority(): CollaborationAuthority {
  const authority = controlledAuthority().authority
  return {
    ...authority,
    participant: {
      ...authority.participant,
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'ro' },
    },
    authorize: () => Promise.reject(new CollaborationError('forbidden')),
    readableSessionIds: sessionIds => Promise.resolve(new Set(sessionIds)),
  }
}

async function harness(
  authority: CollaborationAuthority,
  workspaceRegistry?: unknown,
  options: {
    cwd?: string
    directoryPicker?: object
    agentPresets?: object
    canOpenPath?: () => boolean
    openPath?: (path: string, signal: AbortSignal) => Promise<void>
  } = {},
): Promise<{
  ctx: Context
  api: ReturnType<typeof createApiProxy>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService)
  ctx.provide('workspaceRegistry', (workspaceRegistry ?? {
    list: () => [],
    archivedSessionIds: [],
  }) as never)
  if (options.directoryPicker !== undefined) {
    ctx.provide('directoryPicker', options.directoryPicker as never)
  }
  if (options.agentPresets !== undefined) {
    ctx.provide('agentPresets', options.agentPresets as never)
  }
  ctx.provide('collaboration', {
    capture: () => authority,
    currentCreation: () => undefined,
    withSessionCreation: (_creation: unknown, operation: () => Promise<unknown>) => operation(),
  } as never)
  return {
    ctx,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
      cwd: options.cwd ?? '/tmp',
      canOpenPath: options.canOpenPath ?? (() => false),
      ...(options.openPath === undefined ? {} : { openPath: options.openPath }),
    }),
  }
}

function collaborationForbidden(action: 'read' | 'write', sessionId?: SessionId): object {
  return {
    ok: false,
    error: {
      code: 'collaboration-forbidden',
      details: {
        action,
        reason: 'forbidden',
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    },
  }
}

function typertRequest(
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
): TypertGatewayAuthorizationRequest {
  const [namespace, method] = endpoint.split('/') as [string, string]
  return { endpoint, service: namespace, namespace, method, args }
}

async function expectTypertCollaborationFailure(
  operation: Promise<void>,
): Promise<TypertLookupFailure> {
  try {
    await operation
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TypertLookupFailure)
    return error as TypertLookupFailure
  }
  throw new Error('expected Typert collaboration refusal')
}

describe('project collaboration Typert Remote ACL', () => {
  it('authorizes every current session-scoped Remote with its declared action', async () => {
    const authority = controlledAuthority().authority
    const authorize = vi.fn(authority.authorize.bind(authority))
    authority.authorize = authorize
    const { ctx } = await harness(authority)
    const sessionId = SessionId('remote-session')
    const cases: Array<{
      endpoint: string
      action: 'read' | 'write'
      args: Readonly<Record<string, unknown>>
    }> = [
      ...['create', 'edit', 'pause', 'resume', 'complete', 'clear'].map(method => ({
        endpoint: `goals/${method}`,
        action: 'write' as const,
        args: { agentId: sessionId },
      })),
      { endpoint: 'messageFeedback/list', action: 'read', args: { request: { sessionId } } },
      { endpoint: 'messageFeedback/put', action: 'write', args: { request: { sessionId } } },
      { endpoint: 'messageFeedback/delete', action: 'write', args: { request: { sessionId } } },
    ]

    for (const entry of cases) {
      await authorizeTypertRemote(ctx, typertRequest(entry.endpoint, entry.args))
    }

    expect(authorize.mock.calls).toEqual(cases.map(entry => [sessionId, entry.action]))
  })

  it('returns the collaboration error branch for a denied session Remote', async () => {
    const { ctx } = await harness(readOnlyAuthority())
    const sessionId = SessionId('read-only-session')

    const failure = await expectTypertCollaborationFailure(authorizeTypertRemote(
      ctx,
      typertRequest('goals/edit', { agentId: sessionId }),
    ))

    expect(failure.failure).toMatchObject({
      code: 'collaboration-forbidden',
      details: { action: 'write', reason: 'forbidden', sessionId },
    })
  })

  it('denies unclassified process-wide Remotes in project scope', async () => {
    const { ctx } = await harness(controlledAuthority().authority)

    const failure = await expectTypertCollaborationFailure(authorizeTypertRemote(
      ctx,
      typertRequest('pluginInventory/list', {}),
    ))

    expect(failure.failure).toMatchObject({
      code: 'collaboration-forbidden',
      details: { action: 'manage', reason: 'forbidden' },
    })
  })

  it('does not apply project policy to a personal principal', async () => {
    const projectAuthority = controlledAuthority().authority
    const authority: CollaborationAuthority = {
      ...projectAuthority,
      participant: {
        ...projectAuthority.participant,
        scope: { kind: 'personal' },
      },
      authorize: () => Promise.reject(new Error('personal request must not authorize a project session')),
    }
    const { ctx } = await harness(authority)

    await expect(authorizeTypertRemote(
      ctx,
      typertRequest('pluginInventory/list', {}),
    )).resolves.toBeUndefined()
  })
})

describe('project collaboration streams', () => {
  it('filters external Workspaces and private Session ids from Host increments', async () => {
    const visibleId = SessionId('visible-workspace-session')
    const privateId = SessionId('private-workspace-session')
    const authority = controlledAuthority().authority
    const readableSessionIds = vi.fn((sessionIds: readonly SessionId[]) => Promise.resolve(new Set(
      sessionIds.filter(sessionId => sessionId === visibleId),
    )))
    authority.readableSessionIds = readableSessionIds
    const visibleWorkspace = {
      id: 'workspace-visible',
      path: '/tmp/project',
      title: 'Project',
      sessionIds: [visibleId, privateId],
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }
    const externalWorkspace = {
      id: 'workspace-external',
      path: '/outside-project',
      title: 'External',
      sessionIds: [visibleId],
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }
    const workspaces = new Map([
      [visibleWorkspace.id, visibleWorkspace],
      [externalWorkspace.id, externalWorkspace],
    ])
    const { ctx, api } = await harness(authority, {
      list: () => [...workspaces.values()],
      get: (id: string) => workspaces.get(id),
      archivedSessionIds: [],
    })
    ctx.sessions.create(visibleId)
    ctx.sessions.create(privateId)
    const abort = new AbortController()
    const stream = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const changed = stream.next()
    await vi.waitFor(() => { expect(readableSessionIds).toHaveBeenCalled() })

    ctx.emit('domain/changed', {
      domain: 'workspace',
      table: 'workspaces',
      operation: 'put',
      key: externalWorkspace.id,
      value: { ...externalWorkspace, title: 'External changed' },
    })
    ctx.emit('domain/changed', {
      domain: 'workspace',
      table: '',
      operation: 'put',
      key: '',
      value: {
        initialized: true,
        workspaceIds: [externalWorkspace.id, visibleWorkspace.id],
        archivedSessionIds: [],
      },
    })
    ctx.emit('domain/changed', {
      domain: 'workspace',
      table: 'workspaces',
      operation: 'put',
      key: visibleWorkspace.id,
      value: { ...visibleWorkspace, title: 'Visible changed' },
    })

    await expect(changed).resolves.toMatchObject({
      done: false,
      value: {
        payload: {
          type: 'host/workspace-changed',
          workspace: {
            workspaceId: visibleWorkspace.id,
            title: 'Visible changed',
            sessionIds: [visibleId],
          },
        },
      },
    })

    const archived = stream.next()
    ctx.emit('domain/changed', {
      domain: 'workspace',
      table: '',
      operation: 'put',
      key: '',
      value: {
        initialized: true,
        workspaceIds: [visibleWorkspace.id],
        archivedSessionIds: [privateId, visibleId],
      },
    })
    await expect(archived).resolves.toMatchObject({
      done: false,
      value: {
        payload: {
          type: 'host/archived-sessions-changed',
          archivedSessionIds: [visibleId],
        },
      },
    })
    abort.abort()
    await stream.return?.()
  })

  it('delivers mux events committed while the initial ACL batch is pending', async () => {
    const controlled = controlledAuthority()
    const { ctx, api } = await harness(controlled.authority)
    const session = ctx.sessions.create(SessionId('initial'))
    const abort = new AbortController()
    const frames: MuxFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.mux(request({}), abort.signal)) {
        frames.push(envelope.payload)
      }
    })()

    expect(await controlled.firstReadStarted).toEqual([session.id])
    session.append('turn/start', { turn: 1 })
    controlled.firstRead.resolve(new Set([session.id]))

    try {
      await vi.waitFor(() => {
        expect(frames.some(frame => frame.type === 'session/event'
          && frame.sessionId === session.id
          && frame.event.type === 'turn/start')).toBe(true)
      })
    } finally {
      abort.abort()
      await consuming
    }
  })

  it('delivers host additions created while the initial ACL batch is pending', async () => {
    const controlled = controlledAuthority()
    const { ctx, api } = await harness(controlled.authority)
    const initial = ctx.sessions.create(SessionId('initial'))
    const abort = new AbortController()
    const frames: HostFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.host(request({}), abort.signal)) {
        frames.push(envelope.payload)
      }
    })()

    expect(await controlled.firstReadStarted).toEqual([initial.id])
    const added = ctx.sessions.create(SessionId('added-during-authorization'))
    controlled.firstRead.resolve(new Set([initial.id]))

    try {
      await vi.waitFor(() => {
        expect(frames).toContainEqual(expect.objectContaining({
          type: 'host/session-added',
          sessionId: added.id,
        }))
      })
    } finally {
      abort.abort()
      await consuming
    }
  })

  it('preserves approval transitions while the initial ACL batch is pending', async () => {
    const controlled = controlledAuthority()
    const { ctx, api } = await harness(controlled.authority)
    const session = ctx.sessions.create(SessionId('approval-session'))
    session.append('turn/start', { turn: 1 })
    const agent = stubAgent(ctx, session)
    const firstAbort = new AbortController()
    const firstFrames: MuxFrame[] = []
    const firstConsumer = (async () => {
      for await (const envelope of api.events.mux(request({}), firstAbort.signal)) {
        firstFrames.push(envelope.payload)
      }
    })()

    expect(await controlled.firstReadStarted).toEqual([session.id])
    const witnessAbort = new AbortController()
    const witnessFrames: MuxFrame[] = []
    const witnessConsumer = (async () => {
      for await (const envelope of api.events.mux(request({}), witnessAbort.signal)) {
        witnessFrames.push(envelope.payload)
      }
    })()
    const cancel = new AbortController()
    const outcome = ctx.approval.request({ agent, toolName: 'bash', signal: cancel.signal })
    await vi.waitFor(() => {
      expect(witnessFrames.some(frame => frame.type === 'approval/requested')).toBe(true)
    })
    cancel.abort()
    await expect(outcome).resolves.toBe('cancelled')
    await vi.waitFor(() => {
      expect(witnessFrames.some(frame => frame.type === 'approval/resolved')).toBe(true)
    })
    controlled.firstRead.resolve(new Set([session.id]))

    try {
      await vi.waitFor(() => {
        expect(firstFrames.filter(frame => frame.type === 'approval/requested')).toHaveLength(1)
        expect(firstFrames.filter(frame => frame.type === 'approval/resolved')).toHaveLength(1)
      })
      expect(firstFrames.findIndex(frame => frame.type === 'approval/requested'))
        .toBeLessThan(firstFrames.findIndex(frame => frame.type === 'approval/resolved'))
    } finally {
      firstAbort.abort()
      witnessAbort.abort()
      await Promise.all([firstConsumer, witnessConsumer])
    }
  })

  it('does not claim an approval cancelled while authorization is pending', async () => {
    const authority = controlledAuthority().authority
    const authorization = Promise.withResolvers<Awaited<ReturnType<CollaborationAuthority['authorize']>>>()
    const authorizationStarted = Promise.withResolvers<true>()
    const claimInteraction = vi.fn(() => Promise.resolve(true))
    authority.authorize = () => {
      authorizationStarted.resolve(true)
      return authorization.promise
    }
    authority.readableSessionIds = sessionIds => Promise.resolve(new Set(sessionIds))
    authority.claimInteraction = claimInteraction
    const { ctx, api } = await harness(authority)
    const session = ctx.sessions.create(SessionId('cancelled-approval'))
    session.append('turn/start', { turn: 1 })
    const agent = stubAgent(ctx, session)
    const streamAbort = new AbortController()
    const envelopes: RpcRequest<MuxFrame>[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.mux(request({}), streamAbort.signal)) {
        envelopes.push(envelope)
      }
    })()
    const cancel = new AbortController()
    const outcome = ctx.approval.request({ agent, toolName: 'bash', signal: cancel.signal })
    await vi.waitFor(() => {
      expect(envelopes.some(envelope => envelope.payload.type === 'approval/requested')).toBe(true)
    })
    const envelope = envelopes.find(candidate => candidate.payload.type === 'approval/requested')!
    if (envelope.payload.type !== 'approval/requested') throw new Error('expected approval request')
    const response = api.respond({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: envelope.payload.sessionId,
          approvalId: envelope.payload.approvalId,
          outcome: 'allowed-once',
        },
      },
    })
    await authorizationStarted.promise
    cancel.abort()
    await expect(outcome).resolves.toBe('cancelled')
    authorization.resolve({
      sessionId: session.id,
      rootSessionId: session.id,
      mode: 'rw',
      canRead: true,
      canWrite: true,
      canManage: true,
      projectId: 41,
      visibility: 'project',
      creatorUserId: 7,
    })

    try {
      await expect(response).resolves.toEqual({ accepted: false, reason: 'not-pending' })
      expect(claimInteraction).not.toHaveBeenCalled()
    } finally {
      streamAbort.abort()
      await consuming
    }
  })

  it('never emits mux frames for a session denied by a later authorization read', async () => {
    const visibleId = SessionId('visible-session')
    const hiddenId = SessionId('private-session')
    const authority = controlledAuthority().authority
    const readableSessionIds = vi.fn((sessionIds: readonly SessionId[]) => Promise.resolve(new Set(
      sessionIds.filter(sessionId => sessionId === visibleId),
    )))
    authority.readableSessionIds = readableSessionIds
    const { ctx, api } = await harness(authority)
    const visible = ctx.sessions.create(visibleId)
    const hidden = ctx.sessions.create(hiddenId)
    const abort = new AbortController()
    const frames: MuxFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.mux(request({}), abort.signal)) {
        frames.push(envelope.payload)
      }
    })()

    await vi.waitFor(() => { expect(readableSessionIds).toHaveBeenCalled() })
    visible.append('turn/start', { turn: 1 })
    hidden.append('turn/start', { turn: 1 })

    try {
      await vi.waitFor(() => {
        expect(frames.some(frame => frame.type === 'session/event'
          && frame.sessionId === visibleId)).toBe(true)
        expect(readableSessionIds.mock.calls.length).toBeGreaterThanOrEqual(2)
      })
      expect(frames.some(frame => 'sessionId' in frame && frame.sessionId === hiddenId)).toBe(false)
    } finally {
      abort.abort()
      await consuming
    }
  })

  it.each(['mux', 'host'] as const)('closes the %s stream when its principal expires', async (kind) => {
    const authority: CollaborationAuthority = {
      ...controlledAuthority().authority,
      expiresAt: Date.now() + 25,
    }
    authority.readableSessionIds = sessionIds => Promise.resolve(new Set(sessionIds))
    const { api } = await harness(authority)
    const stream = kind === 'mux'
      ? api.events.mux(request({}), new AbortController().signal)
      : api.events.host(request({}), new AbortController().signal)
    const consuming = (async () => {
      for await (const _frame of stream) {
        // No initial frame is required; expiry itself must finish the iterator.
      }
    })()
    await expect(Promise.race([
      consuming.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(() => { resolve('timed-out') }, 1000)),
    ])).resolves.toBe('closed')
  })
})

describe('project collaboration read ACL', () => {
  it('filters lists, search, workspaces, attachments, exports, and root-inherited history', async () => {
    const rootId = SessionId('shared-root')
    const childId = SessionId('shared-child')
    const privateId = SessionId('private-root')
    const allowed = new Set([rootId, childId])
    const base = controlledAuthority().authority
    base.readableSessionIds = sessionIds => Promise.resolve(new Set(
      sessionIds.filter(sessionId => allowed.has(sessionId)),
    ))
    base.authorize = (sessionId) => {
      if (!allowed.has(sessionId)) return Promise.reject(new CollaborationError('forbidden'))
      return Promise.resolve({
        sessionId,
        rootSessionId: sessionId === childId ? rootId : sessionId,
        mode: 'rw',
        canRead: true,
        canWrite: true,
        canManage: sessionId === rootId,
        projectId: 41,
        visibility: 'project',
        creatorUserId: 7,
      })
    }
    const workspace = {
      id: 'workspace-1',
      path: '/tmp/project',
      title: 'Project',
      sessionIds: [rootId, privateId],
      createdAt: 1,
      updatedAt: 2,
    }
    const { ctx, api } = await harness(base, {
      list: () => [workspace],
      archivedSessionIds: [childId, privateId],
    })
    const root = ctx.sessions.create(rootId, { meta: { cwd: '/tmp/project' } })
    ctx.sessions.create(childId, { meta: { cwd: '/tmp/project', parentSession: rootId } })
    ctx.sessions.create(privateId, { meta: { cwd: '/tmp/project' } })
    root.append('turn/start', { turn: 1 })

    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({
        items: [privateId, rootId].map((sessionId, index) => ({
          header: ctx.sessions.get(sessionId)!.header,
          live: true,
          persisted: false,
          bestMatch: {
            sessionId,
            seq: index,
            type: 'user/message' as const,
            time: index + 1,
            surface: 'current' as const,
            snippet: String(sessionId),
          },
        })),
      }),
    } as never)

    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId).sort())
      .toEqual([childId, rootId].sort())
    expect(expectOk(await api.workspace.list(request({})))).toMatchObject({
      items: [{ workspaceId: 'workspace-1', sessionIds: [rootId] }],
      archivedSessionIds: [childId],
    })
    expect(expectOk(await api.sessions.search(
      request({ query: 'root' }),
      new AbortController().signal,
    )).items).toEqual([{ sessionId: rootId, snippet: rootId }])
    expect((await api.sessions.history(request({ sessionId: childId }))).result.ok).toBe(true)
    expect((await api.sessions.history(request({ sessionId: privateId }))).result).toMatchObject({
      ok: false,
      error: { code: 'collaboration-forbidden', details: { sessionId: privateId } },
    })
    expect((await api.sessions.attachment(request({
      sessionId: privateId,
      attachmentId: 'image-private' as never,
    }))).result).toMatchObject({
      ok: false,
      error: { code: 'collaboration-forbidden', details: { sessionId: privateId } },
    })
    expect((await api.downloads.sessionLog({
      sessionId: privateId,
      includeDescendants: true,
    }, new AbortController().signal)).status).toBe(403)
  })
})

describe('project collaboration host description', () => {
  it('counts only attached sessions readable by the captured principal', async () => {
    const visibleId = SessionId('visible')
    const authority = controlledAuthority().authority
    authority.readableSessionIds = sessionIds => Promise.resolve(new Set(
      sessionIds.filter(sessionId => sessionId === visibleId),
    ))
    const { ctx, api } = await harness(authority)
    const visible = ctx.sessions.create(visibleId)
    const hidden = ctx.sessions.create(SessionId('hidden'))
    ctx.agents.register(stubAgent(ctx, visible))
    ctx.agents.register(stubAgent(ctx, hidden))

    const described = expectOk(await api.host.describe(request({})))
    expect(described.attachedSessions).toBe(1)
  })

  it('never advertises native path opening to a project-scoped principal', async () => {
    const { api } = await harness(controlledAuthority().authority, undefined, {
      canOpenPath: () => true,
    })

    expect(expectOk(await api.host.describe(request({}))).canOpenPath).toBe(false)
  })
})

describe('read-write project scope containment', () => {
  it('rejects new sessions and workspaces outside the configured project root', async () => {
    const { api } = await harness(controlledAuthority().authority)

    expect((await api.sessions.create(request({ cwd: '/' }))).result)
      .toMatchObject(collaborationForbidden('write'))
    expect((await api.workspace.create(request({ path: '/' }))).result)
      .toMatchObject(collaborationForbidden('write'))
  })

  it('limits directory browsing and refuses native host path capabilities', async () => {
    const list = vi.fn(async (path?: string) => ({
      path: path ?? '/unexpected',
      home: path ?? '/unexpected',
      crumbs: [],
      entries: [],
      truncated: false,
    }))
    const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
    const openPath = vi.fn(async () => {})
    const { api } = await harness(controlledAuthority().authority, undefined, {
      directoryPicker: {
        capability: () => ({ kind: 'browse', list, createDirectory }),
      },
      canOpenPath: () => true,
      openPath,
    })
    const signal = new AbortController().signal

    expect((await api.host.listDirectory(request({}), signal)).result.ok).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    expect((await api.host.listDirectory(request({ path: '/' }), signal)).result)
      .toMatchObject(collaborationForbidden('read'))
    expect((await api.host.createDirectory(request({ path: '/', name: 'outside' }))).result)
      .toMatchObject(collaborationForbidden('write'))
    expect(createDirectory).not.toHaveBeenCalled()
    expect((await api.host.pickDirectory(request({}), signal)).result)
      .toMatchObject(collaborationForbidden('read'))
    expect((await api.host.openPath(request({ path: '/tmp/project' }), signal)).result)
      .toMatchObject(collaborationForbidden('write'))
    expect(openPath).not.toHaveBeenCalled()
  })

  it('allows preset discovery and selection but denies host-owned preset configuration', async () => {
    const recompose = vi.fn(async () => ({ id: 'standard' }))
    const presets = {
      defaultId: 'standard',
      authorable: true,
      list: async () => [{ id: 'standard', trust: 'system' }],
      recompose,
    }
    const { ctx, api } = await harness(controlledAuthority().authority, undefined, {
      agentPresets: presets,
      canOpenPath: () => true,
    })
    const session = ctx.sessions.create(SessionId('preset-session'), { meta: { cwd: '/tmp' } })
    ctx.agents.register(stubAgent(ctx, session))
    const signal = new AbortController().signal

    expect(expectOk(await api.agentPresets.list(request({})))).toMatchObject({
      presets: [{ id: 'standard', isDefault: true }],
      authorable: false,
      hasDocument: false,
    })
    expect(expectOk(await api.agentPresets.select(request({
      sessionId: session.id,
      agentPreset: 'standard',
    })))).toEqual({ agentPreset: 'standard' })
    expect(recompose).toHaveBeenCalledTimes(1)

    const denied: Array<Promise<RpcResponse<unknown>>> = [
      api.agentPresets.read(request({ agentPreset: 'standard' })),
      api.agentPresets.copy(request({ from: 'standard', agentPreset: 'copy' })),
      api.agentPresets.openDocument(request({ agentPreset: 'standard' }), signal),
      api.agentPresets.remove(request({ agentPreset: 'standard' })),
    ]
    for (const response of await Promise.all(denied)) {
      expect(response.result).toMatchObject(collaborationForbidden('write'))
    }
  })

  it('filters private sessions and project-external workspaces from mutation responses', async () => {
    const visibleId = SessionId('visible-session')
    const privateId = SessionId('private-session')
    const authority = controlledAuthority().authority
    authority.readableSessionIds = sessionIds => Promise.resolve(new Set(
      sessionIds.filter(sessionId => sessionId === visibleId),
    ))
    const inside = {
      id: 'inside-workspace',
      path: '/tmp/project',
      title: 'Project',
      sessionIds: [visibleId, privateId],
      createdAt: 1,
      updatedAt: 2,
    }
    const outside = {
      id: 'outside-workspace',
      path: '/',
      title: 'Outside',
      sessionIds: [privateId],
      createdAt: 1,
      updatedAt: 2,
    }
    const registry = {
      list: () => [inside, outside],
      archivedSessionIds: [],
      resolveByPath: async () => inside,
      create: async () => { throw new Error('unexpected create') },
      get: (workspaceId: string) => workspaceId === inside.id
        ? inside
        : workspaceId === outside.id ? outside : undefined,
      insertBefore: async () => [inside.id, outside.id],
    }
    const { api } = await harness(authority, registry)

    expect(expectOk(await api.workspace.create(request({ path: inside.path })))).toMatchObject({
      workspace: { workspaceId: inside.id, sessionIds: [visibleId] },
      created: false,
    })
    expect(expectOk(await api.workspace.insertBefore(request({
      workspaceId: inside.id as never,
    })))).toEqual({ workspaceIds: [inside.id] })
  })
})

describe('read-only project scope', () => {
  it('rejects every session-independent mutation before reaching its provider', async () => {
    const { api } = await harness(readOnlyAuthority())
    const signal = new AbortController().signal
    const calls: Array<[string, () => Promise<RpcResponse<unknown>>]> = [
      ['session.create', () => api.sessions.create(request({}))],
      ['workspace.create', () => api.workspace.create(request({ path: '/tmp/project' }))],
      ['workspace.rename', () => api.workspace.rename(request({ workspaceId: 'workspace' as never, title: 'Renamed' }))],
      ['workspace.delete', () => api.workspace.delete(request({ workspaceId: 'workspace' as never }))],
      ['workspace.insertBefore', () => api.workspace.insertBefore(request({ workspaceId: 'workspace' as never }))],
      ['host.createDirectory', () => api.host.createDirectory(request({ path: '/tmp', name: 'child' }))],
      ['settings.openDocument', () => api.settings.openDocument(request({}), signal)],
      ['settings.update', () => api.settings.update(request({ ns: 'ui-onboarding', patch: {} }))],
      ['settings.replace', () => api.settings.replace(request({ ns: 'ui-onboarding', section: {} }))],
      ['settings.mutate', () => api.settings.mutate(request({ ns: 'ui-onboarding', ops: [] }))],
      ['agentPreset.copy', () => api.agentPresets.copy(request({ from: 'base', agentPreset: 'copy' }))],
      ['agentPreset.read', () => api.agentPresets.read(request({ agentPreset: 'base' }))],
      ['agentPreset.openDocument', () => api.agentPresets.openDocument(request({ agentPreset: 'base' }), signal)],
      ['agentPreset.remove', () => api.agentPresets.remove(request({ agentPreset: 'base' }))],
    ]

    for (const [name, call] of calls) {
      const response = await call()
      expect(response.result, name).toMatchObject({
        ok: false,
        error: {
          code: 'collaboration-forbidden',
          details: { action: 'write', reason: 'forbidden' },
        },
      })
    }
  })

  it('rejects every session mutation through root-inherited authorization', async () => {
    const { api } = await harness(readOnlyAuthority())
    const sessionId = SessionId('shared')
    const childSessionId = SessionId('child')
    const signal = new AbortController().signal
    const goal = { id: 'goal' as never, revision: 0 }
    const calls: Array<[string, () => Promise<RpcResponse<unknown>>]> = [
      ['session.selectModel', () => api.sessions.selectModel(request({ sessionId, provider: 'p', model: 'm' }))],
      ['session.rename', () => api.sessions.rename(request({ sessionId, title: 'Renamed' }))],
      ['session.fork', () => api.sessions.fork(request({ sessionId }))],
      ['session.prompt', () => api.sessions.prompt(request({ sessionId, mode: 'queue', content: [{ type: 'text', text: 'hello' }] }))],
      ['session.updateQueue', () => api.sessions.updateQueue(request({ sessionId, itemId: 'message' as never, action: { kind: 'remove' } }))],
      ['session.cancel', () => api.sessions.cancel(request({ sessionId }))],
      ['subagent.prompt', () => api.subagents.prompt(request({ parentSessionId: sessionId, childSessionId, mode: 'continuable', content: [{ type: 'text', text: 'hello' }] }), signal)],
      ['subagent.interrupt', () => api.subagents.interrupt(request({ parentSessionId: sessionId, childSessionId, mode: 'continuable' }))],
      ['goal.create', () => api.goals.create(request({ sessionId, objective: 'Ship' }))],
      ['goal.edit', () => api.goals.edit(request({ sessionId, ref: goal, objective: 'Ship safely' }))],
      ['goal.pause', () => api.goals.pause(request({ sessionId, ref: goal }))],
      ['goal.resume', () => api.goals.resume(request({ sessionId, ref: goal }))],
      ['goal.complete', () => api.goals.complete(request({ sessionId, ref: goal }))],
      ['goal.clear', () => api.goals.clear(request({ sessionId, ref: goal }))],
      ['agentPreset.select', () => api.agentPresets.select(request({ sessionId, agentPreset: 'base' }))],
      ['workspace.insertSessionBefore', () => api.workspace.insertSessionBefore(request({ workspaceId: 'workspace' as never, sessionId }))],
      ['workspace.archiveSession', () => api.workspace.archiveSession(request({ sessionId }))],
    ]

    for (const [name, call] of calls) {
      const response = await call()
      expect(response.result.ok, name).toBe(false)
      if (response.result.ok) throw new Error(`${name} unexpectedly succeeded`)
      expect(response.result.error.code, name).toBe('collaboration-forbidden')
      if (response.result.error.code !== 'collaboration-forbidden') {
        throw new Error(`${name} returned the wrong error`)
      }
      expect(response.result.error.details, name).toMatchObject({ action: 'write', reason: 'forbidden' })
      expect(typeof response.result.error.details.sessionId, name).toBe('string')
    }
  })
})
