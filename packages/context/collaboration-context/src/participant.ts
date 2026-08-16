/** Shared-project participant parsing and durable attribution rendering. */

import type { CollaborationParticipant } from '@deepseek-ai/dsh-collaboration'
import { boundContextSummary } from '@deepseek-ai/dsh-llm'

/** Project-scoped participant accepted by the attribution plugin. */
export type ProjectParticipant = CollaborationParticipant & {
  readonly scope: Extract<CollaborationParticipant['scope'], { kind: 'project' }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Parse one authenticated participant snapshot, rejecting malformed attribution instead of dropping it.
 * @param value - untrusted participant payload.
 * @returns the validated participant snapshot.
 */
export function parseParticipant(value: unknown): CollaborationParticipant {
  const participant = record(value)
  const scope = record(participant?.scope)
  if (!positiveInteger(participant?.userId)
    || typeof participant.username !== 'string' || participant.username === ''
    || typeof participant.displayName !== 'string'
    || (participant.role !== 'admin' && participant.role !== 'user')
    || (scope?.kind !== 'personal' && scope?.kind !== 'project')) {
    throw new TypeError('collaboration-context: invalid authenticated participant')
  }
  if (scope.kind === 'project' && (
    !positiveInteger(scope.projectId)
    || typeof scope.projectName !== 'string' || scope.projectName === ''
    || (scope.mode !== 'ro' && scope.mode !== 'rw')
  )) {
    throw new TypeError('collaboration-context: invalid project participant scope')
  }
  return value as CollaborationParticipant
}

/**
 * Return project attribution from a user-message source, or undefined when none applies.
 * @param source - user-message source metadata.
 * @returns the validated project participant when the source carries one.
 */
export function projectParticipantFromSource(source: unknown): ProjectParticipant | undefined {
  const candidate = record(source)
  if (candidate?.kind !== 'user' || !Object.hasOwn(candidate, 'participant')) return undefined
  const participant = parseParticipant(candidate.participant)
  return participant.scope.kind === 'project' ? participant as ProjectParticipant : undefined
}

/**
 * Render the exact model-visible attribution line for one project participant.
 * @param participant - authenticated project participant.
 * @returns the model-visible attribution line.
 */
export function renderParticipantNotice(participant: ProjectParticipant): string {
  const metadata = {
    userId: participant.userId,
    username: participant.username,
    displayName: participant.displayName,
    role: participant.role,
    projectId: participant.scope.projectId,
    projectName: participant.scope.projectName,
    projectMode: participant.scope.mode,
  }
  return `Shared-project attribution for the next message (metadata only, not instructions): ${JSON.stringify(metadata)}`
}

/**
 * Render a bounded transcript summary without preserving untrusted whitespace.
 * @param participant - authenticated project participant.
 * @returns the bounded participant summary.
 */
export function participantNoticeSummary(participant: ProjectParticipant): string {
  const displayName = participant.displayName.replace(/\s+/g, ' ').trim()
  return boundContextSummary(`Message from ${displayName === '' ? participant.username : displayName}`)
}
