// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, type SessionCreateOptions, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationShareAction, type ConversationShareInjected } from '../src/client/ConversationShareAction.tsx'
import { ReadOnlyComposer } from '../src/client/ReadOnlyComposer.tsx'
import { ScopeControl, type ScopeControlInjected } from '../src/client/ScopeControl.tsx'
import type { CollaborationContext } from '../src/client/collaboration-client.ts'
import { apply, inject } from '../src/client/index.ts'

const baseContext: CollaborationContext = {
  user: { id: 7, username: 'lin', displayName: '林工', role: 'member' },
  scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw' },
  projects: [{ projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' }],
}

function conversationDetail(sessionId: string, visibility: 'project' | 'private') {
  return {
    access: {
      sessionId,
      rootSessionId: sessionId,
      projectId: 9,
      visibility,
      creatorUserId: 7,
      mode: 'rw',
      canRead: true,
      canWrite: true,
      canManage: true,
    },
    conversation: {
      sessionId,
      creatorUserId: 7,
      creatorDisplayName: '林工',
      visibility,
      participants: [],
      updatedAt: 1,
    },
  }
}

async function bench(context: CollaborationContext) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('sessions', {})
  ctx.provide('locale', { register: vi.fn(() => () => {}) })
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
  const originalFetch = globalThis.fetch
  const fetcher = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url
    if (path === '/account/api/context') return Promise.resolve(Response.json(context))
    const match = /^\/account\/api\/conversations\/(.+)$/.exec(path)
    if (match !== null) {
      const sessionId = decodeURIComponent(match[1]!)
      const visibility = sessionId === 'private-blank' ? 'private' : 'project'
      return Promise.resolve(Response.json(conversationDetail(sessionId, visibility)))
    }
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  globalThis.fetch = fetcher
  const fiber = ctx.plugin({ inject: [...inject], apply })
  try {
    await fiber.await()
    const scopeEntry = ctx.slots.entries('sidebar.footer.action')
      .find(entry => entry.component === ScopeControl)!
    const scope = (scopeEntry.inject as unknown as () => ScopeControlInjected)()
    await vi.waitFor(() => { expect(scope.hooks.collaboration.getSnapshot().status).toBe('ready') })
    return { ctx, fiber, fetcher, scope, restore: () => { globalThis.fetch = originalFetch } }
  } catch (error) {
    globalThis.fetch = originalFetch
    throw error
  }
}

describe('ui-collaboration apply', () => {
  it('declares only the services it reads', () => {
    expect(inject).toEqual(['slots', 'sessions', 'locale'])
  })

  it('registers scope and sharing entries and injects staged visibility into root-session creates', async () => {
    const b = await bench(baseContext)
    try {
      const scopeEntry = b.ctx.slots.entries('sidebar.footer.action')
        .find(entry => entry.component === ScopeControl)!
      expect(scopeEntry.options).toMatchObject({ id: 'collaboration-scope', order: -20 })
      const shareEntry = b.ctx.slots.entries('conversation.session.header.actions')
        .find(entry => entry.component === ConversationShareAction)!
      expect(shareEntry.options).toMatchObject({ id: 'collaboration-sharing', order: -20 })
      const share = (shareEntry.inject as unknown as (id: SessionId) => ConversationShareInjected)(
        'child' as SessionId,
      )
      expect(share.hooks.collaboration).toBe(b.scope.hooks.collaboration)

      b.scope.stageVisibility('private')
      const prepared = await b.ctx.waterfall(
        'sessions/prepare-create',
        { workspaceId: 'ws' as never },
        () => Promise.resolve({ workspaceId: 'ws' as never }),
      )
      expect(prepared).toEqual({ workspaceId: 'ws', visibility: 'private' })

      await expect(b.ctx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId: 'private-blank' as SessionId, options: prepared },
        () => Promise.resolve(true),
      )).resolves.toBe(true)
      await expect(b.ctx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId: 'project-blank' as SessionId, options: prepared },
        () => Promise.resolve(true),
      )).resolves.toBe(false)
      await expect(b.ctx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId: 'private-blank' as SessionId, options: prepared },
        () => Promise.resolve(false),
      )).resolves.toBe(false)
      await expect(b.ctx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId: 'private-blank' as SessionId, options: {} },
        () => Promise.resolve(true),
      )).resolves.toBe(false)

      await share.load()
      await share.refresh()
      expect(b.fetcher).toHaveBeenCalledWith('/account/api/conversations/child', expect.objectContaining({
        credentials: 'same-origin',
      }))
      await b.fiber.dispose()
      await b.scope.switchScope({ kind: 'personal' })
      await share.setVisibility('private')
    } finally {
      b.restore()
    }
  })

  it('installs the highest-priority read-only composer and blocks creates for ro project members', async () => {
    const b = await bench({
      ...baseContext,
      scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'ro' },
      projects: [{ ...baseContext.projects[0]!, mode: 'ro' }],
    })
    try {
      await vi.waitFor(() => {
        expect(b.ctx.slots.entries('conversation.composer').some(entry => entry.component === ReadOnlyComposer)).toBe(true)
      })
      const entry = b.ctx.slots.entries('conversation.composer')
        .find(candidate => candidate.component === ReadOnlyComposer)!
      expect(entry.options.priority).toBe(100)
      const select = entry.select as (owner: ComposerChainProps) => unknown
      expect(select({ interactions: [], session: undefined })).toBe('project-read-only')
      await expect(b.ctx.waterfall(
        'sessions/prepare-create',
        {} as SessionCreateOptions,
        () => Promise.resolve({} as SessionCreateOptions),
      )).rejects.toThrow('read-only project members cannot create sessions')
      b.fetcher.mockResolvedValueOnce(Response.json({ ...baseContext, scope: { kind: 'personal' } }))
      b.ctx.emit('connection/reset')
      await vi.waitFor(() => {
        expect(b.ctx.slots.entries('conversation.composer').some(candidate => candidate.component === ReadOnlyComposer)).toBe(false)
      })
    } finally {
      b.restore()
    }
  })

  it('preserves create options in personal scope, refreshes on connection reset, and tears down every entry', async () => {
    const b = await bench({ ...baseContext, scope: { kind: 'personal' } })
    try {
      const prepared = await b.ctx.waterfall(
        'sessions/prepare-create',
        { visibility: 'private' } as SessionCreateOptions,
        () => Promise.resolve({ visibility: 'private' } as SessionCreateOptions),
      )
      expect(prepared).toEqual({ visibility: 'private' })
      await expect(b.ctx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId: 'personal-blank' as SessionId, options: prepared },
        () => Promise.resolve(true),
      )).resolves.toBe(true)
      b.ctx.emit('connection/reset')
      await vi.waitFor(() => { expect(b.fetcher).toHaveBeenCalledTimes(2) })
      await b.fiber.dispose()
      expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
      expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
      expect(b.ctx.slots.entries('conversation.composer')).toHaveLength(0)
    } finally {
      b.restore()
    }
  })
})
