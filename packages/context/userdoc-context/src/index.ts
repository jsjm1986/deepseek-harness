/** Durable prompt context for user-uploaded documents. @module @deepseek-ai/dsh-userdoc-context */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserDocId, UserDocPromptAttachment, UserDocRef, UserDocStore } from '@deepseek-ai/dsh-userdoc'
import {
  DOCUMENTS_TOO_LARGE_CODE,
  TOO_MANY_DOCUMENTS_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'

/** Durable relation between one entered prompt and one admitted document snapshot. */
export interface UserDocAttachedEventData extends UserDocPromptAttachment {
  readonly version: 1
  /** Exact entered user message whose content contains this representation. */
  readonly messageId: MessageId
  /** Zero-based position among document parts in that message. */
  readonly index: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact document representation admitted into one entered user message. */
    'userdoc/attached': UserDocAttachedEventData
  }
}

/** Strict decoder: malformed UTF-8 falls back to a path instead of replacement characters. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Render the exact text block inserted for one admitted document.
 * @param attachment - host-admitted document snapshot.
 * @returns the model-facing text block.
 */
export function renderUserDocAttachment(attachment: UserDocPromptAttachment): string {
  const name = JSON.stringify(attachment.ref.name)
  const path = JSON.stringify(attachment.ref.path)
  if (attachment.representation.kind === 'inline') {
    return `Uploaded document ${name} at ${path}; contents inlined verbatim:\n${attachment.representation.text}`
  }
  return `Uploaded document ${name} is available at ${path}. Use the filesystem tools to read it.`
}

/**
 * Resolve and freeze one whole document batch before any prompt event is committed.
 * @param store - document store that owns the supplied ids.
 * @param docIds - ordered document ids from the prompt.
 * @param signal - optional cancellation for admission reads.
 * @returns frozen document metadata and prompt representations.
 */
export async function prepareUserDocAttachments(
  store: UserDocStore,
  docIds: readonly UserDocId[],
  signal?: AbortSignal,
): Promise<UserDocPromptAttachment[]> {
  signal?.throwIfAborted()
  if (docIds.length > store.limits.maxFilesPerMessage) {
    throw new UserDocError('Prompt references too many documents.', TOO_MANY_DOCUMENTS_CODE)
  }
  const refs = await Promise.all(docIds.map(docId => store.stat(docId, signal)))
  if (refs.reduce((sum, ref) => sum + ref.bytes, 0) > store.limits.maxMessageBytes) {
    throw new UserDocError('Prompt documents exceed the aggregate byte limit.', DOCUMENTS_TOO_LARGE_CODE)
  }
  const attachments: UserDocPromptAttachment[] = []
  for (const ref of refs) {
    signal?.throwIfAborted()
    let current: UserDocRef = ref
    let representation: UserDocPromptAttachment['representation'] = { kind: 'path' }
    if (ref.bytes <= store.limits.maxInlineTextBytes) {
      const stored = await store.read(ref.docId, signal)
      current = stored.ref
      if (stored.data.byteLength <= store.limits.maxInlineTextBytes) {
        try {
          representation = { kind: 'inline', text: UTF8.decode(stored.data) }
        } catch {
          // Valid storage bytes that are not strict UTF-8 remain ordinary path-referenced files.
        }
      }
    }
    attachments.push({ ref: current, representation })
  }
  if (attachments.reduce((sum, attachment) => sum + attachment.ref.bytes, 0)
    > store.limits.maxMessageBytes) {
    throw new UserDocError('Prompt documents exceed the aggregate byte limit.', DOCUMENTS_TOO_LARGE_CODE)
  }
  return attachments
}

/** Cordis plugin name. */
export const name = 'userdoc-context'
/** The Agent event and Session event vocabulary are supplied by these services. */
export const inject = ['agents', 'sessions']

/** Record document relations after the final user message enters the durable surface. */
export function apply(ctx: Context): void {
  ctx.on('agent/message-entered', ({ agent, event }) => {
    const source = event.data.source
    if (source.kind !== 'user' || !('documents' in source) || !Array.isArray(source.documents)) return
    const documents = source.documents as readonly UserDocPromptAttachment[]
    documents.forEach((attachment, index) => {
      agent.session.append('userdoc/attached', {
        version: 1,
        messageId: event.data.id,
        index,
        ...attachment,
      })
    })
  })
}
