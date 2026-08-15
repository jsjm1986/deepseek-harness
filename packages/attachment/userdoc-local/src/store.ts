/** Real-file document storage below a per-user upload root. */

import { constants, type Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, link, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  DOCUMENT_DELETE_FAILED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_WRITE_FAILED_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import type { StoredUserDoc, UserDocId, UserDocLimits, UserDocRef, UserDocTarget } from '@deepseek-ai/dsh-userdoc'
import { mediaTypeFor } from './media-type.ts'
import { assertInside, docIdFor, pathForDocId, resolveTargetIn } from './name.ts'

/** Suffix identifying an unpublished random staging file. */
const PARTIAL_SUFFIX = '.part'
/* v8 ignore next -- the fallback runs only on platforms whose fs constants omit O_NOFOLLOW. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- O_NOFOLLOW is absent on platforms that do not expose the flag.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function assertRealParent(root: string, path: string): Promise<void> {
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(root),
    realpath(dirname(path)),
  ])
  assertInside(canonicalRoot, canonicalParent)
}

async function openDocument(root: string, path: string) {
  try {
    await assertRealParent(root, path)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close()
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    return { handle, info }
  } catch (error) {
    if (error instanceof UserDocError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') {
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  }
}

function documentRef(root: string, path: string, info: Pick<Stats, 'size' | 'mtimeMs'>): UserDocRef {
  const name = basename(path)
  return {
    docId: docIdFor(root, path),
    path,
    name,
    bytes: info.size,
    mediaType: mediaTypeFor(name),
    modifiedAt: info.mtimeMs,
  }
}

/**
 * Date-stamped subdirectory (`YYYY-MM-DD`) that groups one day's uploads.
 * @param now - upload time.
 * @returns the directory name.
 */
export function dayDirectory(now: Date): string {
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
}

async function exists(path: string): Promise<boolean> {
  try {
    // lstat, not stat: a dangling symlink is an existing directory entry that a
    // create would collide with, and following the link would report absence.
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Resolve where one upload will land inside the root.
 * @param root - absolute upload root.
 * @param name - client-supplied file name.
 * @param now - upload time, which selects the day subdirectory.
 * @returns the resolved target.
 * @throws UserDocError when the name is unusable.
 */
export async function resolveDocTarget(root: string, name: string, now: Date): Promise<UserDocTarget> {
  const directory = resolve(join(root, dayDirectory(now)))
  return resolveTargetIn(root, directory, name, exists)
}

/**
 * Stream one document to its resolved target and publish it atomically.
 *
 * The bytes land in a random sibling `.part` file created with `O_EXCL`. A
 * completed, synced staging inode is hard-linked to the resolved target, so an
 * occupied target fails instead of replacing an earlier upload.
 * A stream that exceeds `maxFileBytes` is cut off mid-flight and its partial
 * file removed, so an oversized upload cannot fill the disk by streaming past
 * the limit.
 * @param target - resolved write target.
 * @param body - upload byte stream.
 * @param limits - resolved storage policy.
 * @param root - absolute upload root, re-proved before the write.
 * @param signal - optional cancellation.
 * @returns the durable reference.
 * @throws UserDocError with `DOCUMENT_TOO_LARGE`, `DOCUMENT_TARGET_CONFLICT`, or `DOCUMENT_WRITE_FAILED`.
 */
export async function saveDocFile(
  root: string,
  target: UserDocTarget,
  body: ReadableStream<Uint8Array>,
  limits: UserDocLimits,
  signal?: AbortSignal,
): Promise<UserDocRef> {
  signal?.throwIfAborted()
  assertInside(root, target.path)
  if (pathForDocId(root, String(target.docId)) !== resolve(target.path)
    || basename(target.path) !== target.name) {
    throw new UserDocError('Resolved document target is inconsistent.', INVALID_DOCUMENT_REF_CODE)
  }
  await mkdir(dirname(target.path), { recursive: true, mode: 0o700 })
  await assertRealParent(root, target.path)
  const partial = join(dirname(target.path), `.userdoc-${randomBytes(12).toString('hex')}${PARTIAL_SUFFIX}`)
  let handle
  let bytes = 0
  try {
    handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
    const reader = body.getReader()
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > limits.maxFileBytes) {
          throw new UserDocError('Document exceeds the configured byte limit.', DOCUMENT_TOO_LARGE_CODE)
        }
        await handle.write(value)
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await assertRealParent(root, target.path)
    try {
      await link(partial, target.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UserDocError('Document target became occupied before publication.', DOCUMENT_TARGET_CONFLICT_CODE)
      }
      throw error
    }
    await unlink(partial)
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(
        /* v8 ignore next -- a close failure is superseded by the write failure that entered cleanup. */
        () => {},
      )
    }
    await unlink(partial).catch(
      /* v8 ignore next -- best-effort cleanup of a partial file a failed open never created. */
      () => {},
    )
    if (error instanceof UserDocError) throw error
    signal?.throwIfAborted()
    throw new UserDocError('Unable to store the uploaded document.', DOCUMENT_WRITE_FAILED_CODE, { cause: error })
  }
  const { handle: published, info } = await openDocument(root, target.path)
  await published.close()
  return {
    docId: target.docId,
    path: target.path,
    name: target.name,
    bytes,
    mediaType: mediaTypeFor(target.name),
    modifiedAt: info.mtimeMs,
  }
}

/**
 * List every stored document under the upload root, newest first.
 * @param root - absolute upload root.
 * @param signal - optional cancellation, observed between directory levels.
 * @returns the references, newest modification time first.
 */
export async function listDocFiles(root: string, signal?: AbortSignal): Promise<UserDocRef[]> {
  signal?.throwIfAborted()
  const refs: UserDocRef[] = []
  const pending = [resolve(root)]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    // The loop guard proves the array is non-empty.
    const directory = pending.pop() as string
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      // An absent root means nothing has been uploaded yet, which is an empty
      // list rather than a failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new UserDocError('Unable to list stored documents.', DOCUMENT_READ_FAILED_CODE, { cause: error })
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      // Only regular files are documents: a symlink is skipped rather than
      // followed, so a link planted inside the root cannot publish a reference
      // to a file outside it.
      if (!entry.isFile()) continue
      if (entry.name.endsWith(PARTIAL_SUFFIX)) continue
      const { handle, info } = await openDocument(root, path)
      await handle.close()
      refs.push(documentRef(root, path, info))
    }
  }
  return refs.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/**
 * Resolve one identifier to its stored reference.
 * @param root - absolute upload root.
 * @param docId - identifier from a client or session log.
 * @param signal - optional cancellation.
 * @returns the reference.
 * @throws UserDocError with `INVALID_DOCUMENT_REF`, `DOCUMENT_NOT_FOUND`, or `DOCUMENT_READ_FAILED`.
 */
export async function statDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  await handle.close()
  return documentRef(root, path, info)
}

/**
 * Read one stored document's bytes.
 * @param root - absolute upload root.
 * @param docId - identifier from a client or session log.
 * @param signal - optional cancellation.
 * @returns the reference and its bytes.
 * @throws UserDocError when the identifier is invalid or the file is unreadable.
 */
export async function readDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  const ref = documentRef(root, path, info)
  try {
    return { ref, data: new Uint8Array(await handle.readFile(signal === undefined ? undefined : { signal })) }
  } catch (error) {
    signal?.throwIfAborted()
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  } finally {
    await handle.close()
  }
}

/**
 * Open one stored document as a byte stream.
 *
 * The download route needs this rather than {@link readDocFile}: a 100MB upload
 * read into a buffer to answer one request is a memory cost per concurrent
 * download, while a stream hands the bytes to the socket as they arrive.
 * @param root - absolute upload root.
 * @param docId - identifier from a client or session log.
 * @returns the reference and its byte stream.
 * @throws UserDocError when the identifier is invalid or names no file.
 */
export async function openDocFile(
  root: string,
  docId: UserDocId,
): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  const ref = documentRef(root, path, info)
  // The handle's own stream closes the descriptor when the consumer cancels or
  // reaches the end, so an abandoned download cannot leak it.
  return { ref, body: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array> }
}

/**
 * Delete one stored document.
 * @param root - absolute upload root.
 * @param docId - identifier from a client or session log.
 * @param signal - optional cancellation.
 * @returns after the entry is gone; an already-absent document is a success, so
 * a repeated delete from a retrying client is not an error.
 * @throws UserDocError when the identifier is invalid or deletion fails for any
 * reason other than absence.
 */
export async function removeDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UserDocError('Unable to delete the stored document.', DOCUMENT_DELETE_FAILED_CODE, { cause: error })
  }
}
