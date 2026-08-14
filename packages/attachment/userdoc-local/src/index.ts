/** Local real-file document backend rooted below the operating-system home. @module @deepseek-ai/dsh-userdoc-local */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { UserDocStore } from '@deepseek-ai/dsh-userdoc'
import type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
} from '@deepseek-ai/dsh-userdoc'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  listDocFiles,
  openDocFile,
  readDocFile,
  removeDocFile,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from './store.ts'

export { DEFAULT_MEDIA_TYPE, mediaTypeFor } from './media-type.ts'
export { docIdFor, isInside, pathForDocId, sanitizeName, suffixName } from './name.ts'
export {
  dayDirectory,
  listDocFiles,
  openDocFile,
  readDocFile,
  removeDocFile,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from './store.ts'

/** Default upload directory name below the operating-system home. */
export const DEFAULT_UPLOAD_DIR_NAME = 'uploads'
/** Default maximum bytes for one document. */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
/** Default maximum documents in one prompt. */
export const DEFAULT_MAX_FILES_PER_MESSAGE = 20
/** Default maximum aggregate document bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_BYTES = 200 * 1024 * 1024
/** Default maximum bytes of a document inlined into a prompt as text. */
export const DEFAULT_MAX_INLINE_TEXT_BYTES = 256 * 1024

/** Local document backend configuration. */
export interface Config {
  /**
   * Absolute upload root, `~`-expanded. Omitted uses `<home>/uploads`.
   *
   * The deployment must keep this inside a directory the tool authorization
   * policy already grants the session, because every stored reference carries
   * a real path the model is invited to read.
   */
  uploadRoot?: string
  /** Maximum bytes accepted for one document. */
  maxFileBytes?: number
  /** Maximum document count accepted in one submitted message. */
  maxFilesPerMessage?: number
  /** Maximum aggregate bytes accepted in one submitted message. */
  maxMessageBytes?: number
  /** Maximum bytes of a document inlined into a prompt as text. */
  maxInlineTextBytes?: number
}

/** Real-file local document store. */
export class LocalUserDocStore extends UserDocStore {
  static Config: z<Config> = z.object({
    uploadRoot: z.string(),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
    maxFilesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_FILES_PER_MESSAGE),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxInlineTextBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_TEXT_BYTES),
  })

  /** Absolute upload root. */
  readonly root: string
  readonly limits: UserDocLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(config.uploadRoot === undefined
      ? join(homedir(), DEFAULT_UPLOAD_DIR_NAME)
      : expandHomePath(config.uploadRoot))
    this.limits = Object.freeze({
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxFilesPerMessage: config.maxFilesPerMessage ?? DEFAULT_MAX_FILES_PER_MESSAGE,
      maxMessageBytes: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      maxInlineTextBytes: config.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES,
    })
  }

  async resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    return resolveDocTarget(this.root, input.name, new Date())
  }

  async save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef> {
    return saveDocFile(this.root, target, body, this.limits, signal)
  }

  async list(signal?: AbortSignal): Promise<UserDocRef[]> {
    return listDocFiles(this.root, signal)
  }

  async stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
    return statDocFile(this.root, docId, signal)
  }

  async read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    return readDocFile(this.root, docId, signal)
  }

  async openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    return openDocFile(this.root, docId)
  }

  async remove(docId: UserDocId, signal?: AbortSignal): Promise<void> {
    await removeDocFile(this.root, docId, signal)
  }
}

export default LocalUserDocStore
