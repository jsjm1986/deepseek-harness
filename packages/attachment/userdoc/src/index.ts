/** User-uploaded document storage seam (`ctx.userDocs`). @module @deepseek-ai/dsh-userdoc */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
} from './types.ts'
import type { UserDocId } from './brand.ts'

export { UserDocId } from './brand.ts'
export {
  DOCUMENT_DELETE_FAILED_CODE,
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_STORE_UNAVAILABLE_CODE,
  DOCUMENTS_TOO_LARGE_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_WRITE_FAILED_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  TOO_MANY_DOCUMENTS_CODE,
  UserDocError,
} from './error.ts'
export type { UserDocErrorCode } from './error.ts'
export type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocId as UserDocIdType,
  UserDocLimits,
  UserDocRef,
  UserDocPromptAttachment,
  UserDocPromptRepresentation,
  UserDocTarget,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userDocs: UserDocStore
  }
}

/**
 * Storage for documents a user uploads into their own workspace.
 *
 * The stored form is an ordinary named file, not an opaque object: a document
 * lands at a real path the agent's filesystem and shell tools can read, which
 * is what lets one uploaded file serve every format without this seam knowing
 * any of them. Nothing here inspects, parses, or whitelists content —
 * `mediaType` is recorded and never acted upon, so an unrecognized format is
 * stored exactly like a recognized one and the agent decides how to read it.
 *
 * Writes are two explicit steps. `resolveTarget` sanitizes the untrusted
 * client name and computes the path; `save` streams bytes to that path. Naming
 * policy therefore has one auditable home, and `save` never defaults a target
 * of its own.
 */
export abstract class UserDocStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userDocs')
  }

  /** Deployment-resolved upload policy, shared with client-side intake pre-checks. */
  abstract readonly limits: UserDocLimits

  /**
   * Resolve one untrusted client file name to the absolute path a `save` will
   * create. Implementations sanitize the name, keep the result inside the
   * upload root, and pick a leaf that no existing entry holds.
   * @param input - client-supplied name, treated as untrusted text.
   * @returns the resolved write target.
   * @throws UserDocError when no acceptable free name can be derived from the input.
   */
  abstract resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget>

  /**
   * Stream one document to a resolved target and publish its reference.
   *
   * Implementations enforce `maxFileBytes` while streaming, so an oversized
   * upload is cut off rather than buffered, and leave no partial file behind on
   * failure or cancellation. The recorded `mediaType` is derived from the stored
   * name, never taken from a client header: a declared type is unverifiable
   * here, and nothing in this seam acts on the value anyway.
   * @param target - a target from this store's own `resolveTarget`.
   * @param body - the upload byte stream.
   * @param signal - optional cancellation for the streaming write.
   * @returns the durable reference to the stored document.
   * @throws UserDocError when the stream exceeds `maxFileBytes` or the write fails.
   */
  abstract save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef>

  /**
   * List every stored document, newest modification first.
   * @param signal - optional cancellation for the directory scan.
   * @returns references to all stored documents; empty before the first upload.
   */
  abstract list(signal?: AbortSignal): Promise<UserDocRef[]>

  /**
   * Resolve one identifier to its current reference.
   *
   * Every read path takes this identifier rather than a `UserDocRef`, because a
   * reference carries an absolute path and a caller's copy of one is untrusted
   * input. Implementations re-derive the path from the identifier and re-prove
   * containment, so a tampered path cannot name a file outside the upload root.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation for the filesystem probe.
   * @returns the current reference.
   * @throws UserDocError when the identifier is malformed, escapes the upload root, or names no file.
   */
  abstract stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef>

  /**
   * Read one stored document in full.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation for the read.
   * @returns the bytes and the reference they were read through.
   * @throws the signal reason when aborted, or a UserDocError when the identifier does not resolve to a file.
   */
  abstract read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc>

  /**
   * Open one stored document as a byte stream, for a download response that must
   * not hold the whole file in memory.
   * @param docId - identifier from a previous `save` or `list`.
   * @returns the reference and its byte stream.
   * @throws UserDocError when the identifier does not resolve to a file.
   */
  abstract openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }>

  /**
   * Delete one stored document. Deleting an already-absent document succeeds, so
   * a client retrying a delete it already completed is not an error.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation.
   * @returns after the entry is gone.
   * @throws UserDocError when the identifier is malformed or escapes the upload
   * root, or the deletion fails for any reason other than absence.
   */
  abstract remove(docId: UserDocId, signal?: AbortSignal): Promise<void>
}

export default UserDocStore
