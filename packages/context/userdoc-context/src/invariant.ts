/** Durable relation checks for user-document prompt admission. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { UserDocPromptAttachment } from '@deepseek-ai/dsh-userdoc'
import { renderUserDocAttachment, type UserDocAttachedEventData } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-userdoc-context'
const SOURCE_KIND = 'user'

export const name = 'userdoc-context-invariant'
export const inject = ['invariants']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameRef(left: UserDocAttachedEventData['ref'], right: UserDocAttachedEventData['ref']): boolean {
  return left.docId === right.docId
    && left.path === right.path
    && left.name === right.name
    && left.bytes === right.bytes
    && left.mediaType === right.mediaType
    && left.modifiedAt === right.modifiedAt
}

function sameAttachment(left: UserDocAttachedEventData, right: UserDocPromptAttachment): boolean {
  return sameRef(left.ref, right.ref)
    && (left.representation.kind === 'inline'
      ? right.representation.kind === 'inline' && left.representation.text === right.representation.text
      : right.representation.kind === 'path')
}

type UserMessageWithDocuments = UserMessage & {
  readonly source: UserMessage['source'] & {
    readonly kind: 'user'
    readonly documents: readonly UserDocPromptAttachment[]
  }
}

function hasDocumentSource(message: UserMessage): message is UserMessageWithDocuments {
  const source = message.source
  return source.kind === SOURCE_KIND
    && 'documents' in source
    && Array.isArray(source.documents)
}

function attachedData(value: unknown, fail: InvariantFailure): UserDocAttachedEventData {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.messageId !== 'string'
    || value.messageId.length === 0
    || !Number.isSafeInteger(value.index)
    || (value.index as number) < 0
    || !isRecord(value.ref)
    || !isRecord(value.representation)
    || (value.representation.kind !== 'inline' && value.representation.kind !== 'path')) {
    fail('userdoc/attached carries an invalid snapshot envelope')
  }
  const data = value as unknown as UserDocAttachedEventData
  if (data.representation.kind === 'inline' && typeof data.representation.text !== 'string') {
    fail('inline userdoc/attached snapshots must carry text')
  }
  return data
}

function validateAttached(history: readonly SessionEvent[], event: SessionEvent<'userdoc/attached'>, fail: InvariantFailure): void {
  const data = attachedData(event.data, fail)
  const message = history.find((candidate): candidate is SessionEvent<'user/message'> =>
    candidate.type === 'user/message' && candidate.data.id === data.messageId)
  if (message === undefined) fail('userdoc/attached must cite an earlier user/message')
  /* v8 ignore next -- Session accepts only contiguous seq values, so an earlier event cannot have a later seq. */
  if (message.seq >= event.seq) fail('userdoc/attached must follow its cited user/message')
  if (!hasDocumentSource(message.data)) {
    fail('userdoc/attached message source must carry admitted documents')
  }
  const expected = message.data.source.documents[data.index]
  if (expected === undefined || !sameAttachment(data, expected)) {
    fail('userdoc/attached must match the indexed document snapshot on its user/message')
  }
  const rendered = renderUserDocAttachment(data)
  if (!message.data.content.some(block => block.type === 'text' && block.text === rendered)) {
    fail('userdoc/attached representation must appear verbatim on its user/message surface')
  }
}

function validateSession(session: Session, fail: InvariantFailure): void {
  const attachedByMessage = new Set<string>()
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'userdoc/attached') {
      validateAttached(session.events.slice(0, index), event, fail)
      const data = event.data
      const key = `${data.messageId}:${String(data.index)}`
      if (attachedByMessage.has(key)) fail('one document index must have at most one userdoc/attached event')
      attachedByMessage.add(key)
    }
  }
  for (const event of session.events) {
    if (event.type !== 'user/message' || event.data.source.kind !== SOURCE_KIND
      || !('documents' in event.data.source) || !Array.isArray(event.data.source.documents)) continue
    event.data.source.documents.forEach((_attachment, index) => {
      if (!attachedByMessage.has(`${event.data.id}:${String(index)}`)) {
        fail('every admitted document must have one userdoc/attached event')
      }
    })
  }
}

function validateExistingSessions(sessions: readonly Session[], fail: InvariantFailure): void {
  for (const session of sessions) validateSession(session, fail)
}

function installCreatedSessionCheck(ctx: Context, fail: InvariantFailure): void {
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
}

function installAttachedEventCheck(ctx: Context, fail: InvariantFailure): void {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'userdoc/attached') validateAttached(session.events, event, fail)
  }, { global: true })
}

function installUserDocInvariant(ctx: Context, fail: InvariantFailure): void {
  validateExistingSessions(ctx.sessions.list(), fail)
  installCreatedSessionCheck(ctx, fail)
  installAttachedEventCheck(ctx, fail)
}

const install: InvariantInstaller = Object.assign(installUserDocInvariant, { inject: ['sessions'] })

/**
 * Register the package-owned durable relation checks.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
