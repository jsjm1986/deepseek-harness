import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { UserDocId } from '@deepseek-ai/dsh-userdoc'
import * as UserDocContextInvariant from '../src/invariant.ts'
import { renderUserDocAttachment, type UserDocAttachedEventData } from '../src/index.ts'

function eventData(): UserDocAttachedEventData {
  return {
    version: 1,
    messageId: 'message-1' as never,
    index: 0,
    ref: {
      docId: UserDocId('2026-08-14/report.txt'),
      path: '/uploads/report.txt',
      name: 'report.txt',
      bytes: 7,
      mediaType: 'text/plain',
      modifiedAt: 1,
    },
    representation: { kind: 'inline', text: 'contents' },
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return ctx
}

function openSession(ctx: Context) {
  const session = ctx.sessions.create(SessionId('userdoc-invariant'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const data = eventData()
  const message = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: renderUserDocAttachment(data) }],
    source: { kind: 'user', documents: [data] } as never,
  }), { surfaceOp: 'append' })
  return { session, data, message }
}

describe('user-document context invariant', () => {
  it('accepts a message and attached event that carry the same frozen snapshot', async () => {
    const ctx = await setup()
    const { session, data, message } = openSession(ctx)
    session.append('userdoc/attached', { ...data, messageId: message.data.id })
    await expect(ctx.plugin(UserDocContextInvariant)).resolves.toBeDefined()
  })

  it('rejects a durable message that carries documents without relation events', async () => {
    const ctx = await setup()
    openSession(ctx)
    await expect(ctx.plugin(UserDocContextInvariant)).rejects.toThrow(/every admitted document/)
  })

  it('rejects an attached snapshot that does not match the indexed message document', async () => {
    const ctx = await setup()
    const { session, data, message } = openSession(ctx)
    session.append('userdoc/attached', {
      ...data,
      messageId: message.data.id,
      representation: { kind: 'inline', text: 'tampered' },
    })
    await expect(ctx.plugin(UserDocContextInvariant)).rejects.toThrow(/must match the indexed document/)
  })
})
