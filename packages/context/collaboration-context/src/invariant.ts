/** Package-owned participant-attribution invariants. @module @deepseek-ai/dsh-collaboration-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { CollaborationNoticeSource } from './index.ts'
import {
  participantNoticeSummary,
  projectParticipantFromSource,
  renderParticipantNotice,
  parseParticipant,
} from './participant.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-collaboration-context'
const SOURCE_NAME = 'collaboration-context'

/** Cordis companion plugin name. */
export const name = 'collaboration-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function noticeSource(event: SessionEvent): CollaborationNoticeSource | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === SOURCE_NAME
    ? source as CollaborationNoticeSource
    : undefined
}

/** Validate one notice's self-contained snapshot and model-visible text. */
function validateNotice(event: SessionEvent<'user/message'>, fail: InvariantFailure): CollaborationNoticeSource {
  const source = noticeSource(event)
  /* v8 ignore next -- caller selects the exact package source. */
  if (source === undefined) fail('collaboration notice must retain package ownership')
  let participant
  try {
    participant = parseParticipant(source.participant)
  } catch (error: unknown) {
    fail(String(error))
  }
  if (participant.scope.kind !== 'project') fail('collaboration notice must name a project participant')
  const projectParticipant = participant as Extract<typeof participant, { scope: { kind: 'project' } }>
  const form: unknown = source.form
  if (form !== 'notice' || typeof source.participantMessageId !== 'string'
    || source.participantMessageId === '') {
    fail('collaboration notice source must carry notice form and a participant message id')
  }
  if (source.summary !== participantNoticeSummary(projectParticipant)) {
    fail('collaboration notice summary must match its participant snapshot')
  }
  const block = event.data.content[0]
  if (event.data.content.length !== 1 || block?.type !== 'text'
    || block.text !== renderParticipantNotice(projectParticipant)) {
    fail('collaboration notice text must match its participant snapshot')
  }
  return source
}

/** Validate the first following user message as the notice's attributed contribution. */
function validatePair(
  notice: SessionEvent<'user/message'>,
  message: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const source = validateNotice(notice, fail)
  if (message.data.id !== source.participantMessageId) {
    fail('collaboration notice must cite the immediately following user message')
  }
  const participant = projectParticipantFromSource(message.data.source)
  if (participant === undefined || JSON.stringify(participant) !== JSON.stringify(source.participant)) {
    fail('collaboration notice participant must match the cited user message')
  }
}

/** Validate every complete package-owned notice relation in one durable session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, candidate] of session.events.entries()) {
    if (noticeSource(candidate) === undefined) continue
    const notice = candidate as SessionEvent<'user/message'>
    validateNotice(notice, fail)
    const following = session.events.slice(index + 1).find(event =>
      event.type === 'user/message' || event.type === 'step/end' || event.type === 'turn/end')
    if (following?.type !== 'user/message') {
      fail('collaboration notice must be followed by its participant message before the step ends')
    }
    validatePair(notice, following, fail)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const source = noticeSource(event)
    if (source !== undefined) {
      validateNotice(event as SessionEvent<'user/message'>, fail)
      return
    }
    if (event.type !== 'user/message' || projectParticipantFromSource(event.data.source) === undefined) return
    const previous = [...session.events].reverse().find(candidate => candidate.type === 'user/message')
    if (previous?.type === 'user/message' && noticeSource(previous) !== undefined) {
      validatePair(previous, event, fail)
    }
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/** Register the collaboration-context invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
