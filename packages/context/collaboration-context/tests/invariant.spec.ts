import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as CollaborationContextInvariant from '../src/invariant.ts'
import { participantNoticeSummary, renderParticipantNotice } from '../src/participant.ts'

const PARTICIPANT = {
  userId: 7,
  username: 'alice',
  displayName: 'Alice Chen',
  role: 'user' as const,
  scope: { kind: 'project' as const, projectId: 9, projectName: 'Harness', mode: 'rw' as const },
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return ctx
}

function appendPair(ctx: Context, override: Record<string, unknown> = {}) {
  const session = ctx.sessions.create(SessionId('collaboration-invariant'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const participantMessage = createUserMessage({
    content: [{ type: 'text', text: 'Ship it' }],
    source: { kind: 'user', participant: PARTICIPANT } as never,
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: renderParticipantNotice(PARTICIPANT) }],
    source: {
      kind: 'plugin',
      plugin: 'collaboration-context',
      form: 'notice',
      summary: participantNoticeSummary(PARTICIPANT),
      participantMessageId: participantMessage.id,
      participant: PARTICIPANT,
      ...override,
    },
  }), { surfaceOp: 'append' })
  session.append('user/message', participantMessage, { surfaceOp: 'append' })
  return session
}

describe('collaboration-context invariant', () => {
  it('accepts a notice paired with the cited participant message', async () => {
    const ctx = await setup()
    appendPair(ctx)
    await expect(ctx.plugin(CollaborationContextInvariant)).resolves.toBeDefined()
  })

  it('rejects tampered participant text', async () => {
    const ctx = await setup()
    const session = appendPair(ctx)
    const notice = session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin')
    if (notice?.type !== 'user/message') throw new Error('missing notice')
    const corrupt = ctx.sessions.create(SessionId('collaboration-corrupt'))
    corrupt.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tampered' }],
      source: notice.data.source,
    }), { surfaceOp: 'append' })
    await expect(ctx.plugin(CollaborationContextInvariant)).rejects.toThrow(/notice text/)
  })

  it('rejects a notice that cites another message', async () => {
    const ctx = await setup()
    appendPair(ctx, { participantMessageId: 'different' })
    await expect(ctx.plugin(CollaborationContextInvariant)).rejects.toThrow(/immediately following user message/)
  })
})
