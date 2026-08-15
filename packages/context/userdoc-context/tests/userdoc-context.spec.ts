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
  it('renders a path reference when a document is not inlined', () => {
    expect(userDocContext.renderUserDocAttachment(attachment('report', { kind: 'path' })))
      .toBe('Uploaded document "report.txt" is available at "/uploads/report". Use the filesystem tools to read it.')
  })

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

  it('keeps a document above the inline threshold as a path without reading it', async () => {
    let reads = 0
    const base = store([{ ref: ref('large', LIMITS.maxInlineTextBytes + 1), data: new Uint8Array(9) }])
    const guarded = Object.assign({}, base, {
      read: async (...args: Parameters<UserDocStore['read']>) => { reads += 1; return base.read(...args) },
    })

    await expect(userDocContext.prepareUserDocAttachments(guarded, [UserDocId('large')]))
      .resolves.toEqual([expect.objectContaining({ representation: { kind: 'path' } })])
    expect(reads).toBe(0)
  })

  it('rejects more document ids than the store admits per message', async () => {
    await expect(userDocContext.prepareUserDocAttachments(store([]), [
      UserDocId('one'), UserDocId('two'), UserDocId('three'),
    ])).rejects.toMatchObject({ code: 'TOO_MANY_DOCUMENTS' })
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

  it('rejects a batch whose stored snapshots grow beyond the aggregate limit during admission', async () => {
    const before = ref('changed', 1)
    const after = ref('changed', LIMITS.maxMessageBytes + 1)
    const changed = {
      limits: LIMITS,
      stat: async () => before,
      read: async () => ({ ref: after, data: new Uint8Array(LIMITS.maxInlineTextBytes + 1) }),
    } as unknown as UserDocStore

    await expect(userDocContext.prepareUserDocAttachments(changed, [before.docId]))
      .rejects.toMatchObject({ code: 'DOCUMENTS_TOO_LARGE' })
  })

  it('ignores entered user messages that carry no admitted document batch', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(userDocContext)
    const session = Session.create(SessionId('userdoc-empty-event'))
    const entered = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await agentEvents(ctx, agentFor(session)).serial('agent/message-entered', {
      event: entered,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    })

    expect(session.events.map(event => event.type)).toEqual(['user/message'])
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
