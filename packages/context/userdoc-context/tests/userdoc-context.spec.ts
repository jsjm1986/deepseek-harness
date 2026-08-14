import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { UserDocId } from '@deepseek-ai/dsh-userdoc'
import type {
  StoredUserDoc,
  UserDocLimits,
  UserDocPromptAttachment,
  UserDocRef,
  UserDocStore,
} from '@deepseek-ai/dsh-userdoc'
import * as userDocContext from '../src/index.ts'

const LIMITS: UserDocLimits = {
  maxFileBytes: 100,
  maxFilesPerMessage: 2,
  maxMessageBytes: 100,
  maxInlineTextBytes: 8,
}

function ref(id: string, bytes: number, name = `${id}.txt`): UserDocRef {
  return {
    docId: UserDocId(id),
    path: `/uploads/${id}`,
    name,
    bytes,
    mediaType: 'text/plain',
    modifiedAt: 1,
  }
}

function store(entries: readonly StoredUserDoc[]): UserDocStore {
  const byId = new Map(entries.map(entry => [String(entry.ref.docId), entry]))
  return {
    limits: LIMITS,
    stat: async (id: UserDocId) => byId.get(String(id))?.ref ?? (() => { throw new Error('missing') })(),
    read: async (id: UserDocId) => byId.get(String(id)) ?? (() => { throw new Error('missing') })(),
  } as unknown as UserDocStore
}

function agentFor(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function attachment(id: string, representation: UserDocPromptAttachment['representation']): UserDocPromptAttachment {
  return { ref: ref(id, representation.kind === 'inline' ? representation.text.length : 12), representation }
}

describe('user-document prompt context', () => {
  it('inlines strict UTF-8 documents at the configured threshold and keeps binary documents as paths', async () => {
    const text = new TextEncoder().encode('hello')
    const binary = new Uint8Array([0xff, 0xfe, 0xfd])
    const result = await userDocContext.prepareUserDocAttachments(
      store([
        { ref: ref('text', text.byteLength), data: text },
        { ref: ref('binary', binary.byteLength, 'binary.bin'), data: binary },
      ]),
      [UserDocId('text'), UserDocId('binary')],
    )

    expect(result).toEqual([
      expect.objectContaining({ representation: { kind: 'inline', text: 'hello' } }),
      expect.objectContaining({ representation: { kind: 'path' } }),
    ])
  })

  it('rejects a whole batch before reading any document when the aggregate limit is exceeded', async () => {
    let reads = 0
    const base = store([{ ref: ref('one', 60), data: new Uint8Array(60) }, { ref: ref('two', 60), data: new Uint8Array(60) }])
    const guarded = Object.assign({}, base, {
      read: async (...args: Parameters<UserDocStore['read']>) => { reads += 1; return base.read(...args) },
    })

    await expect(userDocContext.prepareUserDocAttachments(
      guarded,
      [UserDocId('one'), UserDocId('two')],
    )).rejects.toMatchObject({ code: 'DOCUMENTS_TOO_LARGE' })
    expect(reads).toBe(0)
  })

  it('records an attached event after the exact user message and replays the frozen model text', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(userDocContext)
    const session = Session.create(SessionId('userdoc-event'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const document = attachment('report', { kind: 'inline', text: 'frozen contents' })
    const message = createUserMessage({
      content: [{ type: 'text', text: userDocContext.renderUserDocAttachment(document) }],
      source: { kind: 'user', documents: [document] } as never,
    })
    const entered = session.append('user/message', message, { surfaceOp: 'append' })

    await agentEvents(ctx, agentFor(session)).serial('agent/message-entered', {
      event: entered,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    })

    expect(session.events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'userdoc/attached',
    ])
    const attached = session.events.at(-1)
    expect(attached?.type).toBe('userdoc/attached')
    expect(session.deriveMessages()[0]?.content).toEqual([
      { type: 'text', text: 'Uploaded document "report.txt" at "/uploads/report"; contents inlined verbatim:\nfrozen contents' },
    ])

    const replayed = Session.create(SessionId('userdoc-replay'), session.events)
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
    expect(replayed.events.find(event => event.type === 'userdoc/attached')?.data).toEqual(attached?.data)
  })
})
