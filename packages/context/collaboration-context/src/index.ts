/** Durable participant attribution for shared project conversations. @module @deepseek-ai/dsh-collaboration-context */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CollaborationParticipant } from '@deepseek-ai/dsh-collaboration'
import {
  participantNoticeSummary,
  projectParticipantFromSource,
  renderParticipantNotice,
} from './participant.ts'

/** Cordis plugin name used in durable message provenance. */
export const name = 'collaboration-context'

/** The agent registry owns the pre-step attribution extension point. */
export const inject = ['agents']

/** Package-owned source fields tying one notice to its following participant message. */
export interface CollaborationNoticeSource {
  readonly kind: 'plugin'
  readonly plugin: typeof name
  readonly form: 'notice'
  readonly summary: string
  readonly participantMessageId: string
  readonly participant: CollaborationParticipant
}

/** Add one durable attribution notice immediately before every project participant message. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    return {
      kind: 'enter',
      messages: decision.messages.flatMap((message) => {
        const participant = projectParticipantFromSource(message.source)
        if (participant === undefined) return [message]
        const text = renderParticipantNotice(participant)
        const source: CollaborationNoticeSource = {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: participantNoticeSummary(participant),
          participantMessageId: message.id,
          participant,
        }
        return [createUserMessage({ content: [{ type: 'text', text }], source }), message]
      }),
    }
  }, { prepend: true })
}
