import { mkdtemp, lstat, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocId,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import type { UserDocLimits } from '@deepseek-ai/dsh-userdoc'
import {
  dayDirectory,
  listDocFiles,
  openDocFile,
  readDocFile,
  removeDocFile,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from '../src/store.ts'

const LIMITS: UserDocLimits = {
  maxFileBytes: 64,
  maxFilesPerMessage: 3,
  maxMessageBytes: 128,
  maxInlineTextBytes: 32,
}

const temporaries: string[] = []

async function root(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-userdoc-'))
  temporaries.push(base)
  return join(base, 'uploads')
}

/** One-chunk body; the common case for a small upload. */
function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** Multi-chunk body, so the streaming limit check is exercised mid-stream. */
function chunked(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(new TextEncoder().encode(chunk))
      index += 1
    },
  })
}

async function save(uploadRoot: string, name: string, text: string): Promise<Awaited<ReturnType<typeof saveDocFile>>> {
  const target = await resolveDocTarget(uploadRoot, name, new Date())
  return saveDocFile(uploadRoot, target, body(text), LIMITS)
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('dayDirectory', () => {
  it('formats the upload day zero-padded in UTC', () => {
    expect(dayDirectory(new Date('2026-08-14T22:00:00Z'))).toBe('2026-08-14')
    expect(dayDirectory(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05')
  })
})

describe('saveDocFile', () => {
  it('stores the document under its day directory and reports its real path', async () => {
    const uploadRoot = await root()
    const ref = await save(uploadRoot, '年报.pdf', 'hello')

    expect(ref.path).toBe(join(uploadRoot, dayDirectory(new Date()), '年报.pdf'))
    expect(ref.name).toBe('年报.pdf')
    expect(ref.bytes).toBe(5)
    expect(ref.mediaType).toBe('application/pdf')
    expect(await readFile(ref.path, 'utf8')).toBe('hello')
  })

  it('leaves no partial file behind once the write completes', async () => {
    const uploadRoot = await root()
    const ref = await save(uploadRoot, 'notes.txt', 'hello')

    const entries = await readdir(join(uploadRoot, dayDirectory(new Date())))
    expect(entries).toEqual(['notes.txt'])
    expect(ref.bytes).toBe(5)
  })

  it('writes the file owner-only', async () => {
    const uploadRoot = await root()
    const ref = await save(uploadRoot, 'secret.txt', 'hello')

    const info = await stat(ref.path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('suffixes a colliding name instead of overwriting the stored file', async () => {
    const uploadRoot = await root()
    const first = await save(uploadRoot, 'report.pdf', 'first')
    const second = await save(uploadRoot, 'report.pdf', 'second')

    expect(second.name).toBe('report (2).pdf')
    expect(await readFile(first.path, 'utf8')).toBe('first')
    expect(await readFile(second.path, 'utf8')).toBe('second')
  })

  it('cuts off a stream that exceeds the byte limit and removes the partial file', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'big.bin', new Date())
    // Three 32-byte chunks against a 64-byte limit: the limit is crossed
    // mid-stream, which is the case a declared content-length cannot catch.
    const oversized = chunked(['x'.repeat(32), 'x'.repeat(32), 'x'.repeat(32)])

    await expect(saveDocFile(uploadRoot, target, oversized, LIMITS)).rejects.toThrow(
      expect.objectContaining({ code: DOCUMENT_TOO_LARGE_CODE }) as Error,
    )
    expect(await readdir(join(uploadRoot, dayDirectory(new Date())))).toEqual([])
  })

  it('refuses a target outside the upload root', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'ok.txt', new Date())

    await expect(saveDocFile(uploadRoot, { ...target, path: join(uploadRoot, '..', 'escaped.txt') }, body('x'), LIMITS))
      .rejects.toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }) as Error)
  })

  it('refuses target metadata that does not describe one document', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'ok.txt', new Date())

    await expect(saveDocFile(uploadRoot, {
      ...target,
      path: join(dirname(target.path), 'other.txt'),
      name: 'other.txt',
    }, body('x'), LIMITS)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(saveDocFile(uploadRoot, { ...target, name: 'other.txt' }, body('x'), LIMITS))
      .rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
  })

  it('publishes the same resolved target at most once under concurrent saves', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'race.txt', new Date())
    const settled = await Promise.allSettled([
      saveDocFile(uploadRoot, target, body('first'), LIMITS),
      saveDocFile(uploadRoot, target, body('second'), LIMITS),
    ])

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: DOCUMENT_TARGET_CONFLICT_CODE }) }),
    ])
    expect(['first', 'second']).toContain(await readFile(target.path, 'utf8'))
    expect((await readdir(join(uploadRoot, dayDirectory(new Date())))).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('refuses a date directory replaced by a symlink outside the upload root', async () => {
    const uploadRoot = await root()
    const outside = join(uploadRoot, '..', 'outside')
    await mkdir(outside)
    await mkdir(uploadRoot)
    await symlink(outside, join(uploadRoot, dayDirectory(new Date())))
    const target = await resolveDocTarget(uploadRoot, 'escaped.txt', new Date())

    await expect(saveDocFile(uploadRoot, target, body('secret'), LIMITS)).rejects.toMatchObject({
      code: INVALID_DOCUMENT_REF_CODE,
    })
    await expect(readFile(join(outside, 'escaped.txt'))).rejects.toThrow()
  })

  it('preserves cancellation instead of reporting a storage failure', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'aborted.txt', new Date())
    const abort = new AbortController()
    abort.abort()

    await expect(saveDocFile(uploadRoot, target, body('x'), LIMITS, abort.signal)).rejects.toThrow(
      abort.signal.reason as Error,
    )
  })

  it('removes the partial file when cancelled mid-stream', async () => {
    const uploadRoot = await root()
    const target = await resolveDocTarget(uploadRoot, 'aborted.txt', new Date())
    const abort = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'))
        abort.abort()
      },
    })

    await expect(saveDocFile(uploadRoot, target, stream, LIMITS, abort.signal)).rejects.toThrow()
    expect(await readdir(join(uploadRoot, dayDirectory(new Date())))).toEqual([])
  })
})

describe('listDocFiles', () => {
  it('reports an empty list before the first upload', async () => {
    expect(await listDocFiles(await root())).toEqual([])
  })

  it('lists documents across day directories, newest modification first', async () => {
    const uploadRoot = await root()
    const older = await resolveDocTarget(uploadRoot, 'older.txt', new Date('2026-08-01T00:00:00Z'))
    await saveDocFile(uploadRoot, older, body('old'), LIMITS)
    const newer = await save(uploadRoot, 'newer.txt', 'new')

    const refs = await listDocFiles(uploadRoot)
    expect(refs.map(ref => ref.name)).toEqual(['newer.txt', 'older.txt'])
    expect(refs[0]?.docId).toBe(newer.docId)
  })

  it('skips a symlink planted inside the root rather than publishing what it points at', async () => {
    const uploadRoot = await root()
    await save(uploadRoot, 'real.txt', 'real')
    const outside = join(uploadRoot, '..', 'outside.txt')
    await writeFile(outside, 'secret')
    await symlink(outside, join(uploadRoot, dayDirectory(new Date()), 'link.txt'))

    const refs = await listDocFiles(uploadRoot)
    expect(refs.map(ref => ref.name)).toEqual(['real.txt'])
  })

  it('hides an in-progress partial file from the listing', async () => {
    const uploadRoot = await root()
    await save(uploadRoot, 'real.txt', 'real')
    await writeFile(join(uploadRoot, dayDirectory(new Date()), 'inflight.txt.part'), 'partial')

    expect((await listDocFiles(uploadRoot)).map(ref => ref.name)).toEqual(['real.txt'])
  })

  it('observes cancellation', async () => {
    const uploadRoot = await root()
    const abort = new AbortController()
    abort.abort()

    await expect(listDocFiles(uploadRoot, abort.signal)).rejects.toThrow(abort.signal.reason as Error)
  })
})

describe('statDocFile', () => {
  it('resolves a stored identifier to its current reference', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.md', 'hello')

    const ref = await statDocFile(uploadRoot, saved.docId)
    expect(ref.path).toBe(saved.path)
    expect(ref.mediaType).toBe('text/markdown')
  })

  it('rejects a traversal identifier', async () => {
    const uploadRoot = await root()

    await expect(statDocFile(uploadRoot, UserDocId('../outside.txt'))).rejects.toThrow(
      expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }) as Error,
    )
  })

  it('reports a missing document', async () => {
    const uploadRoot = await root()

    await expect(statDocFile(uploadRoot, UserDocId('2026-08-14/absent.txt'))).rejects.toThrow(
      expect.objectContaining({ code: DOCUMENT_NOT_FOUND_CODE }) as Error,
    )
  })

  it('refuses a directory named as a document', async () => {
    const uploadRoot = await root()
    await save(uploadRoot, 'real.txt', 'real')

    await expect(statDocFile(uploadRoot, UserDocId(dayDirectory(new Date())))).rejects.toThrow(
      expect.objectContaining({ code: DOCUMENT_NOT_FOUND_CODE }) as Error,
    )
  })

  it('observes cancellation', async () => {
    const uploadRoot = await root()
    const abort = new AbortController()
    abort.abort()

    await expect(statDocFile(uploadRoot, UserDocId('x.txt'), abort.signal)).rejects.toThrow(abort.signal.reason as Error)
  })
})


it('refuses a document leaf replaced by a symlink', async () => {
  const uploadRoot = await root()
  const saved = await save(uploadRoot, 'linked.txt', 'inside')
  const outside = join(uploadRoot, '..', 'outside.txt')
  await writeFile(outside, 'outside')
  await rm(saved.path)
  await symlink(outside, saved.path)

  await expect(statDocFile(uploadRoot, saved.docId)).rejects.toMatchObject({
    code: DOCUMENT_NOT_FOUND_CODE,
  })
  await expect(readDocFile(uploadRoot, saved.docId)).rejects.toMatchObject({
    code: DOCUMENT_NOT_FOUND_CODE,
  })
  await expect(openDocFile(uploadRoot, saved.docId)).rejects.toMatchObject({
    code: DOCUMENT_NOT_FOUND_CODE,
  })
})

describe('readDocFile', () => {
  it('returns the stored bytes with the reference they were read through', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.txt', 'hello')

    const stored = await readDocFile(uploadRoot, saved.docId)
    expect(new TextDecoder().decode(stored.data)).toBe('hello')
    expect(stored.ref.docId).toBe(saved.docId)
  })

  it('preserves cancellation', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.txt', 'hello')
    const abort = new AbortController()
    abort.abort()

    await expect(readDocFile(uploadRoot, saved.docId, abort.signal)).rejects.toThrow(
      abort.signal.reason as Error,
    )
  })
})

describe('openDocFile', () => {
  it('streams the stored bytes', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.txt', 'hello')

    const { ref, body: stream } = await openDocFile(uploadRoot, saved.docId)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello')
    expect(ref.bytes).toBe(5)
  })

  it('rejects an identifier that escapes the upload root', async () => {
    const uploadRoot = await root()

    await expect(openDocFile(uploadRoot, UserDocId('../outside.txt'))).rejects.toThrow(
      expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }) as Error,
    )
  })
})

describe('removeDocFile', () => {
  it('deletes the stored file', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.txt', 'hello')

    await removeDocFile(uploadRoot, saved.docId)
    await expect(lstat(saved.path)).rejects.toThrow()
  })

  it('succeeds when the document is already gone', async () => {
    const uploadRoot = await root()
    const saved = await save(uploadRoot, 'notes.txt', 'hello')
    await removeDocFile(uploadRoot, saved.docId)

    await expect(removeDocFile(uploadRoot, saved.docId)).resolves.toBeUndefined()
  })

  it('rejects a traversal identifier before touching the filesystem', async () => {
    const uploadRoot = await root()
    const outside = join(uploadRoot, '..', 'outside.txt')
    await writeFile(outside, 'keep')

    await expect(removeDocFile(uploadRoot, UserDocId('../outside.txt'))).rejects.toThrow(UserDocError)
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('observes cancellation', async () => {
    const uploadRoot = await root()
    const abort = new AbortController()
    abort.abort()

    await expect(removeDocFile(uploadRoot, UserDocId('x.txt'), abort.signal)).rejects.toThrow(abort.signal.reason as Error)
  })
})
