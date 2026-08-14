/** User-document vocabulary. @module @deepseek-ai/dsh-userdoc/types */

import type { UserDocId } from './brand.ts'

export type { UserDocId } from './brand.ts'

/**
 * Durable, serializable metadata for one uploaded document.
 *
 * Deliberately unlike `ImageAttachmentRef`: `path` is a real absolute host
 * path, because the point of this seam is that an uploaded document is an
 * ordinary file the agent's own filesystem and shell tools can reach. The
 * deployment is responsible for rooting uploads somewhere the tool
 * authorization policy already grants (the user's home directory under the
 * multi-user gateway), so publishing the path grants no access the session did
 * not already have.
 */
export interface UserDocRef {
  /** Store-scoped identifier; resolves to a path inside the upload root and nowhere else. */
  docId: UserDocId
  /** Absolute host path of the stored document. */
  path: string
  /** Display name: the sanitized leaf actually written, which may differ from what was uploaded. */
  name: string
  /** Exact byte length on disk. */
  bytes: number
  /**
   * Caller-declared media type, recorded verbatim and never verified against
   * the bytes. It is metadata for presentation only; no admission decision,
   * parse, or dispatch reads it.
   */
  mediaType: string
  /** Storage modification time in epoch milliseconds. */
  modifiedAt: number
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface UserDocLimits {
  /** Maximum bytes accepted for one document. */
  maxFileBytes: number
  /** Maximum documents accepted in one submitted message. */
  maxFilesPerMessage: number
  /** Maximum aggregate bytes accepted in one submitted message. */
  maxMessageBytes: number
  /**
   * Maximum bytes of a document inlined into a prompt as text. A document at
   * or below this size that decodes as UTF-8 text is inlined; everything else
   * reaches the model as its path only.
   */
  maxInlineTextBytes: number
}

/**
 * A resolved write target: the exact absolute path a `save` will create, plus
 * the sanitized leaf it will carry. Produced by an explicit `resolveTarget`
 * step so that name sanitization and root containment are decided in one
 * auditable place rather than defaulted inside `save`.
 */
export interface UserDocTarget {
  /** Absolute path to create; guaranteed to lie inside the store's upload root. */
  path: string
  /** Sanitized leaf name of `path`. */
  name: string
  /** Identifier that will resolve back to this path. */
  docId: UserDocId
}

/** Request to resolve one upload target. */
export interface ResolveUserDocTarget {
  /** Client-supplied file name, treated as untrusted text and never as a path. */
  name: string
}

/** Stored document bytes returned with the reference they were read through. */
export interface StoredUserDoc {
  ref: UserDocRef
  data: Uint8Array
}
