// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationShareAction, type ConversationShareActionProps } from '../src/client/ConversationShareAction.tsx'
import { ReadOnlyComposer, type ReadOnlyComposerProps } from '../src/client/ReadOnlyComposer.tsx'
import { ScopeControl, type ScopeControlProps } from '../src/client/ScopeControl.tsx'
import type {
  CollaborationContext, CollaborationSnapshot, ConversationDetail,
} from '../src/client/collaboration-client.ts'
import { zh, type CollaborationKey } from '../src/client/locales.ts'

afterEach(cleanup)

const projectContext: CollaborationContext = {
  user: { id: 7, username: 'lin', displayName: '林工', role: 'member' },
  scope: { kind: 'project', projectId: 9, projectName: '支付重构', mode: 'rw' },
  projects: [
    { projectId: 9, name: '支付重构', path: '/srv/pay', mode: 'rw' },
    { projectId: 10, name: '审计平台', path: '/srv/audit', mode: 'ro' },
  ],
}

const detail: ConversationDetail = {
  access: {
    sessionId: 'child', rootSessionId: 'root', projectId: 9,
    visibility: 'project', creatorUserId: 7, mode: 'rw',
    canRead: true, canWrite: true, canManage: true,
  },
  conversation: {
    sessionId: 'root', creatorUserId: 7, creatorDisplayName: '林工',
    visibility: 'project', updatedAt: 20,
    participants: [
      { userId: 7, displayName: '林工', contributionCount: 3, lastContributedAt: 10 },
      { userId: 8, displayName: '周工', contributionCount: 1, lastContributedAt: 11 },
    ],
  },
}

function t(key: CollaborationKey, params?: Record<string, string | number>): string {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function snapshot(partial: Partial<CollaborationSnapshot> = {}): CollaborationSnapshot {
  return {
    status: 'ready',
    context: projectContext,
    stagedVisibility: 'project',
    scopeBusy: false,
    conversations: {},
    ...partial,
  }
}

function scopeProps(state: CollaborationSnapshot, overrides: Partial<ScopeControlProps> = {}): ScopeControlProps {
  return {
    wide: true,
    useCollaboration: selector => selector(state),
    switchScope: vi.fn().mockResolvedValue(undefined),
    stageVisibility: vi.fn(),
    t,
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    ...overrides,
  } as ScopeControlProps
}

function conversationProps(
  state: CollaborationSnapshot,
  overrides: Partial<ConversationShareActionProps> = {},
): ConversationShareActionProps {
  return {
    sessionId: 'child' as never,
    useCollaboration: selector => selector(state),
    load: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    setVisibility: vi.fn().mockResolvedValue(undefined),
    t,
    useSession: vi.fn() as never,
    useProjection: vi.fn() as never,
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    ...overrides,
  } as ConversationShareActionProps
}

describe('ScopeControl', () => {
  it('hides before collaboration is ready and for personal users without projects', () => {
    const loading = render(<ScopeControl {...scopeProps(snapshot({ status: 'loading' }))} />)
    expect(loading.container.textContent).toBe('')
    loading.rerender(<ScopeControl {...scopeProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' }, projects: [] },
    }))} />)
    expect(loading.container.textContent).toBe('')
  })

  it('switches scopes and stages independent new-conversation visibility', () => {
    const switchScope = vi.fn().mockResolvedValue(undefined)
    const stageVisibility = vi.fn()
    render(<ScopeControl {...scopeProps(snapshot(), { switchScope, stageVisibility })} />)

    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    expect(trigger.textContent).toContain('支付重构')
    expect(trigger.textContent).toContain('可编辑')
    fireEvent.click(trigger)
    expect(screen.getByText('新对话可见范围')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /仅自己/ }))
    expect(stageVisibility).toHaveBeenCalledWith('private')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '个人空间' }))
    expect(switchScope).toHaveBeenCalledWith({ kind: 'personal' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /审计平台/ }))
    expect(switchScope).toHaveBeenCalledWith({ kind: 'project', projectId: 10 })

    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('新对话可见范围')).toBeNull()
  })

  it('renders a compact rail trigger and omits create visibility for read-only projects', () => {
    const context: CollaborationContext = {
      ...projectContext,
      scope: { kind: 'project', projectId: 10, projectName: '审计平台', mode: 'ro' },
    }
    const view = render(<ScopeControl {...scopeProps(snapshot({ context }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).textContent).toContain('只读')
    view.rerender(<ScopeControl {...scopeProps(snapshot({ context }), { wide: false })} />)
    const trigger = screen.getByRole('button', { name: '切换个人或项目空间' })
    expect(trigger.textContent).not.toContain('审计平台')
    fireEvent.click(trigger)
    expect(screen.queryByText('新对话可见范围')).toBeNull()
  })

  it('shows switching and failure states on the trigger', () => {
    const view = render(<ScopeControl {...scopeProps(snapshot({ scopeBusy: true }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).getAttribute('title')).toBe('正在切换空间')
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ScopeControl {...scopeProps(snapshot({ scopeError: 'switch-failed' }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).getAttribute('title')).toBe('空间切换失败，请重试')
  })

  it('shows personal scope when projects remain available', () => {
    render(<ScopeControl {...scopeProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' } },
    }))} />)
    expect(screen.getByRole('button', { name: '切换个人或项目空间' }).textContent).toContain('个人空间')
  })
})

describe('ConversationShareAction', () => {
  it('does not render or load in personal scope', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const view = render(<ConversationShareAction {...conversationProps(snapshot({
      context: { ...projectContext, scope: { kind: 'personal' } },
    }), { load })} />)
    expect(view.container.textContent).toBe('')
    expect(load).not.toHaveBeenCalled()
  })

  it('renders loading and retry states while requesting collaboration detail', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const view = render(<ConversationShareAction {...conversationProps(snapshot(), { load })} />)
    expect(screen.getByRole('button', { name: '管理对话共享范围' }).hasAttribute('disabled')).toBe(true)
    expect(load).toHaveBeenCalledOnce()

    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'error', saving: false, error: 'load-failed' } },
    }), { load })} />)
    const retry = screen.getByRole('button', { name: '管理对话共享范围' })
    expect(retry.hasAttribute('disabled')).toBe(false)
    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows visibility, creator, participants, and sends a visibility update', () => {
    const setVisibility = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)
    render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail } },
    }), { refresh, setVisibility })} />)
    const trigger = screen.getByRole('button', { name: '管理对话共享范围' })
    expect(trigger.textContent).toContain('项目公开')
    expect(trigger.textContent).toContain('2')
    fireEvent.click(trigger)
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByText('创建者：林工')).toBeTruthy()
    expect(screen.getByText('参与者（2）')).toBeTruthy()
    expect(screen.getByText('3 次参与')).toBeTruthy()
    expect(screen.getByText('1 次参与')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /仅自己/ }))
    expect(setVisibility).toHaveBeenCalledWith('private')
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('创建者：林工')).toBeNull()
  })

  it('refreshes participant detail when the current conversation gains a node', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const session = { tailSeq: undefined as number | undefined }
    const props = conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail } },
    }), {
      refresh,
      useSession: selector => selector({
        nodes: session.tailSeq === undefined ? [] : [{ seq: session.tailSeq }],
      } as never),
    })
    const view = render(<ConversationShareAction {...props} />)
    expect(refresh).not.toHaveBeenCalled()
    session.tailSeq = 8
    view.rerender(<ConversationShareAction {...props} />)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shows creator-only, empty-participant, permission, and update error states', () => {
    const privateDetail: ConversationDetail = {
      access: { ...detail.access, visibility: 'private', canManage: false },
      conversation: {
        ...detail.conversation!, visibility: 'private', participants: [],
      },
    }
    const view = render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail: privateDetail } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('暂无其他参与者')).toBeTruthy()
    expect(screen.getByText('只有创建者可以更改共享范围')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /项目公开/ }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail, error: 'visibility-locked' } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('已有其他成员参与，不能改为仅自己')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    view.rerender(<ConversationShareAction {...conversationProps(snapshot({
      conversations: { child: { status: 'ready', saving: false, detail, error: 'update-failed' } },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('共享范围更新失败，请重试')).toBeTruthy()
  })

  it('falls back to creator id when root metadata is absent and disables changes while saving', () => {
    render(<ConversationShareAction {...conversationProps(snapshot({
      conversations: {
        child: { status: 'ready', saving: true, detail: { ...detail, conversation: null } },
      },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: '管理对话共享范围' }))
    expect(screen.getByText('创建者：7')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /项目公开/ }).hasAttribute('disabled')).toBe(true)
  })
})

describe('ReadOnlyComposer', () => {
  it('renders the project read-only state', () => {
    const props = {
      matched: 'project-read-only', t,
      sessionId: 'child', useSession: vi.fn(), useProjection: vi.fn(),
      useSessions: vi.fn(), useWorkspaces: vi.fn(), interactions: [], session: undefined,
    } as unknown as ReadOnlyComposerProps
    render(<ReadOnlyComposer {...props} />)
    expect(screen.getByRole('status').textContent).toContain('只读项目')
    expect(screen.getByRole('status').textContent).toContain('当前成员权限不允许修改此对话。')
  })
})
