import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_DELETE_FAILED_CODE, DOCUMENT_NOT_FOUND_CODE, DOCUMENT_READ_FAILED_CODE, DOCUMENT_WRITE_FAILED_CODE,
} from '@deepseek-ai/dsh-userdoc'

// Storage failures other than "absent" are the paths a real disk produces and a
// temp directory cannot: a read that fails after its stat succeeded, a listing
// that fails mid-scan. Injecting the errno at the syscall keeps those arms
// deterministic on every platform, where a permission or device trick would
// depend on the runner's uid and filesystem.
const failures = vi.hoisted(() => ({
  lstat: undefined as NodeJS.ErrnoException | undefined,
  link: undefined as NodeJS.ErrnoException | undefined,
  readdir: undefined as NodeJS.ErrnoException | undefined,
  open: undefined as NodeJS.ErrnoException | undefined,
  readFile: undefined as NodeJS.ErrnoException | undefined,
  unlink: undefined as NodeJS.ErrnoException | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      if (failures.lstat !== undefined) throw failures.lstat
      return actual.lstat(...args)
    },
    async link(...args: Parameters<typeof actual.link>) {
      if (failures.link !== undefined) throw failures.link
      return actual.link(...args)
    },
    async readdir(...args: Parameters<typeof actual.readdir>) {
      if (failures.readdir !== undefined) throw failures.readdir
      return actual.readdir(...args)
    },
    async open(...args: Parameters<typeof actual.open>) {
      if (failures.open !== undefined) throw failures.open
      const handle = await actual.open(...args)
      if (failures.readFile !== undefined) {
        Object.defineProperty(handle, 'readFile', {
          value: async () => { throw failures.readFile },
        })
      }
      return handle
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      if (failures.unlink !== undefined) throw failures.unlink
      return actual.unlink(...args)
    },
  }
})

const { listDocFiles, readDocFile, removeDocFile, resolveDocTarget, saveDocFile, statDocFile } = await import('../src/store.ts')

const LIMITS = {
  maxFileBytes: 1024,
  maxFilesPerMessage: 4,
  maxMessageBytes: 4096,
  maxInlineTextBytes: 256,
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code })
}

let root: string
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-failures-'))
  root = join(scratch, 'uploads')
})

afterEach(async () => {
  failures.lstat = undefined
  failures.link = undefined
  failures.readdir = undefined
  failures.open = undefined
  failures.readFile = undefined
  failures.unlink = undefined
  await rm(scratch, { recursive: true, force: true })
})

describe('storage failures other than absence', () => {
  it('propagates a collision probe failure instead of treating it as a free name', async () => {
    failures.lstat = errno('EIO')
    await expect(resolveDocTarget(root, 'report.pdf', new Date())).rejects.toMatchObject({ code: 'EIO' })
  })

  it('fails the listing rather than reporting a partial set', async () => {
    failures.readdir = errno('EACCES')
    await expect(listDocFiles(root)).rejects.toMatchObject({ code: DOCUMENT_READ_FAILED_CODE })
  })

  it('reports an unreadable entry as a read failure, not as absence', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    failures.open = errno('EACCES')
    await expect(statDocFile(root, target.docId)).rejects.toMatchObject({ code: DOCUMENT_READ_FAILED_CODE })
  })

  it('reports a read that fails after its probe succeeded', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    failures.readFile = errno('EIO')
    await expect(readDocFile(root, target.docId)).rejects.toMatchObject({ code: DOCUMENT_READ_FAILED_CODE })
  })

  it('passes a caller signal through to the read', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    const controller = new AbortController()
    const stored = await readDocFile(root, target.docId, controller.signal)
    expect(new TextDecoder().decode(stored.data)).toBe('body')
  })

  it('surfaces cancellation of a read as the signal reason, not as a storage failure', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    const controller = new AbortController()
    controller.abort(new Error('caller went away'))
    failures.open = errno('EIO')
    await expect(readDocFile(root, target.docId, controller.signal)).rejects.toThrow(/caller went away/)
  })

  it('reports a failed deletion instead of claiming the document is gone', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    failures.unlink = errno('EPERM')
    await expect(removeDocFile(root, target.docId)).rejects.toMatchObject({ code: DOCUMENT_DELETE_FAILED_CODE })
  })

  it('treats a write failure as a storage failure and leaves no partial file', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(errno('EIO'))
      },
    })
    await expect(saveDocFile(root, target, body, LIMITS)).rejects.toMatchObject({ code: DOCUMENT_WRITE_FAILED_CODE })
    await expect(statDocFile(root, target.docId)).rejects.toMatchObject({ code: DOCUMENT_NOT_FOUND_CODE })
  })

  it('reports a publication failure that is not a target collision', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    failures.link = errno('EIO')

    await expect(saveDocFile(root, target, streamOf('body'), LIMITS))
      .rejects.toMatchObject({ code: DOCUMENT_WRITE_FAILED_CODE })
  })

  it('skips an in-progress partial file when listing', async () => {
    const target = await resolveDocTarget(root, 'notes.txt', new Date())
    await saveDocFile(root, target, streamOf('body'), LIMITS)
    await writeFile(`${target.path}.part`, 'half-written')
    const listed = await listDocFiles(root)
    expect(listed.map(ref => ref.name)).toEqual(['notes.txt'])
  })
})
