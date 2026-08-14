/** Real-file document storage below a per-user upload root. */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { UserDocError } from '@deepseek-ai/dsh-userdoc'
import type { StoredUserDoc, UserDocLimits, UserDocRef, UserDocTarget } from '@deepseek-ai/dsh-userdoc'
import { mediaTypeFor } from './media-type.ts'
import { assertInside, docIdFor, pathForDocId, resolveTargetIn } from './name.ts'

/** Suffix of the in-progress file a streaming save writes before its atomic rename. */
const PARTIAL_SUFFIX = '.part'

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
 * The bytes land in a sibling `.part` file created with `O_EXCL` — which never
 * follows an existing symlink, so a pre-planted link cannot redirect the write
 * outside the root — and only a completed, synced file is renamed into place.
 * A stream that exceeds `maxFileBytes` is cut off mid-flight and its partial
 * file removed, so an oversized upload cannot fill the disk by streaming past
 * the limit.
 * @param target - resolved write target.
 * @param body - upload byte stream.
 * @param limits - resolved storage policy.
 * @param root - absolute upload root, re-proved before the write.
 * @param signal - optional cancellation.
 * @returns the durable reference.
 * @throws UserDocError with `DOC_TOO_LARGE`, or `DOC_WRITE_FAILED` for storage failures.
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
  await mkdir(dirname(target.path), { recursive: true, mode: 0o700 })
  const partial = `${target.path}${PARTIAL_SUFFIX}`
  let handle
  let bytes = 0
  try {
    handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const reader = body.getReader()
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > limits.maxFileBytes) {
          throw new UserDocError('Document exceeds the configured byte limit.', 'DOC_TOO_LARGE')
        }
        await handle.write(value)
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(partial, target.path)
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
    throw new UserDocError('Unable to store the uploaded document.', 'DOC_WRITE_FAILED', { cause: error })
  }
  const info = await stat(target.path)
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
      throw new UserDocError('Unable to list stored documents.', 'DOC_READ_FAILED', { cause: error })
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
      const info = await stat(path)
      refs.push({
        docId: docIdFor(root, path),
        path,
        name: entry.name,
        bytes: info.size,
        mediaType: mediaTypeFor(entry.name),
        modifiedAt: info.mtimeMs,
      })
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
 * @throws UserDocError with `INVALID_DOC_ID`, `DOC_OUTSIDE_ROOT`, or `DOC_NOT_FOUND`.
 */
export async function statDocFile(root: string, docId: string, signal?: AbortSignal): Promise<UserDocRef> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UserDocError('Document not found.', 'DOC_NOT_FOUND')
    }
    throw new UserDocError('Unable to read the stored document.', 'DOC_READ_FAILED', { cause: error })
  }
  if (!info.isFile()) throw new UserDocError('Document not found.', 'DOC_NOT_FOUND')
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
 * Read one stored document's bytes.
 * @param root - absolute upload root.
 * @param docId - identifier from a client or session log.
 * @param signal - optional cancellation.
 * @returns the reference and its bytes.
 * @throws UserDocError when the identifier is invalid or the file is unreadable.
 */
export async function readDocFile(root: string, docId: string, signal?: AbortSignal): Promise<StoredUserDoc> {
  const ref = await statDocFile(root, docId, signal)
  try {
    return { ref, data: new Uint8Array(await readFile(ref.path, signal === undefined ? undefined : { signal })) }
  } catch (error) {
    signal?.throwIfAborted()
    throw new UserDocError('Unable to read the stored document.', 'DOC_READ_FAILED', { cause: error })
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
  docId: string,
): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
  const ref = await statDocFile(root, docId)
  const handle = await open(ref.path, constants.O_RDONLY)
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
export async function removeDocFile(root: string, docId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UserDocError('Unable to delete the stored document.', 'DOC_DELETE_FAILED', { cause: error })
  }
}
