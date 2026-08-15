import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as CollaborationContext from '../src/index.ts'
import { renderParticipantNotice } from '../src/participant.ts'

const SIGNAL = new AbortController().signal
const PARTICIPANT = {
  userId: 7,
  username: 'alice',
  displayName: 'Alice Chen',
  role: 'user' as const,
  scope: {
    kind: 'project' as const,
    projectId: 9,
    projectName: 'Harness',
    mode: 'rw' as const,
  },
}

function projectMessage(text = 'Ship it') {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user', participant: PARTICIPANT } as never,
  })
}

function sessionAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CollaborationContext)
  const agent = sessionAgent(Session.create(SessionId('collaboration-context')))
  return { ctx, agent }
}

describe('collaboration context', () => {
  it('prepends a durable notice to each final project participant message', async () => {
    const { ctx, agent } = await setup()
    const first = projectMessage('First')
    const second = projectMessage('Second')
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, second], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, second] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(4)
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: renderParticipantNotice(PARTICIPANT) }])
    expect(decision.messages[1]).toBe(first)
    expect(decision.messages[2]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'collaboration-context',
      form: 'notice',
      participantMessageId: second.id,
      participant: PARTICIPANT,
    })
    expect(decision.messages[3]).toBe(second)
  })

  it('leaves ordinary and personal messages unchanged', async () => {
    const { ctx, agent } = await setup()
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })
    const personal = createUserMessage({
      content: [{ type: 'text', text: 'Personal' }],
      source: { kind: 'user', participant: { ...PARTICIPANT, scope: { kind: 'personal' } } } as never,
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [ordinary, personal], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [ordinary, personal] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [ordinary, personal] })
  })

  it('delegates before attributing and preserves rejection', async () => {
    const { ctx, agent } = await setup()
    const original = projectMessage('Original')
    const replacement = projectMessage('Replacement')
    const entered = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [original], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [replacement] }),
    )
    expect(entered.kind === 'enter' && entered.messages[1]).toBe(replacement)

    const rejected = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [original], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'blocked' }),
    )
    expect(rejected).toEqual({ kind: 'reject', reason: 'blocked' })
  })

  it('fails loud when a message claims malformed project attribution', async () => {
    const { ctx, agent } = await setup()
    const malformed = createUserMessage({
      content: [{ type: 'text', text: 'Bad' }],
      source: { kind: 'user', participant: { ...PARTICIPANT, userId: 0 } } as never,
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [malformed], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [malformed] }),
    )).rejects.toThrow(/invalid authenticated participant/)
  })
})
