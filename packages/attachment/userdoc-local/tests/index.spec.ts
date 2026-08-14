import { Context } from '@deepseek-ai/cordis'
import { DOCUMENT_TOO_LARGE_CODE, INVALID_DOCUMENT_REF_CODE, UserDocId } from '@deepseek-ai/dsh-userdoc'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import LocalUserDocStore, {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
  DEFAULT_MAX_INLINE_TEXT_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_UPLOAD_DIR_NAME,
} from '../src/index.ts'

const roots: string[] = []

async function store(config: Record<string, unknown> = {}): Promise<LocalUserDocStore> {
  const uploadRoot = await mkdtemp(join(tmpdir(), 'dsh-userdoc-service-'))
  roots.push(uploadRoot)
  return new LocalUserDocStore(new Context(), { uploadRoot, ...config })
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local user-document service', () => {
  it('resolves every omitted limit explicitly', async () => {
    const service = await store()
    expect(service.limits).toEqual({
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxFilesPerMessage: DEFAULT_MAX_FILES_PER_MESSAGE,
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
      maxInlineTextBytes: DEFAULT_MAX_INLINE_TEXT_BYTES,
    })
  })

  it('roots uploads under the operating-system home when no root is configured', () => {
    const service = new LocalUserDocStore(new Context(), {})
    expect(service.root).toBe(join(homedir(), DEFAULT_UPLOAD_DIR_NAME))
  })

  it('expands a tilde-prefixed configured root', () => {
    const service = new LocalUserDocStore(new Context(), { uploadRoot: '~/docs-under-test' })
    expect(service.root).toBe(join(homedir(), 'docs-under-test'))
  })

  it('carries one document through save, stat, read, list, and remove', async () => {
    const service = await store()
    const target = await service.resolveTarget({ name: '年报.txt' })
    const ref = await service.save(target, stream('hello'))
    expect(ref.name).toBe('年报.txt')
    expect(ref.bytes).toBe(5)
    expect(ref.mediaType).toBe('text/plain')

    await expect(service.stat(ref.docId)).resolves.toMatchObject({ docId: ref.docId, bytes: 5 })
    const read = await service.read(ref.docId)
    expect(new TextDecoder().decode(read.data)).toBe('hello')
    await expect(service.list()).resolves.toHaveLength(1)

    await service.remove(ref.docId)
    await expect(service.list()).resolves.toEqual([])
  })

  it('streams a download without buffering and closes over the whole file', async () => {
    const service = await store()
    const target = await service.resolveTarget({ name: 'big.bin' })
    const ref = await service.save(target, stream('0123456789'))
    const opened = await service.openRead(ref.docId)
    expect(opened.ref.docId).toBe(ref.docId)
    const chunks: Uint8Array[] = []
    for await (const chunk of opened.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('0123456789')
  })

  it('refuses an identifier that escapes the upload root through the service face', async () => {
    const service = await store()
    const outside = join(service.root, '..', 'outside.txt')
    await writeFile(outside, 'secret')
    roots.push(outside)
    const outsideId = UserDocId('../outside.txt')
    await expect(service.stat(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.read(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.openRead(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.remove(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
  })

  it('cuts off a stream that exceeds the configured single-file limit', async () => {
    const service = await store({ maxFileBytes: 4 })
    const target = await service.resolveTarget({ name: 'over.txt' })
    await expect(service.save(target, stream('12345'))).rejects.toMatchObject({ code: DOCUMENT_TOO_LARGE_CODE })
    await expect(service.list()).resolves.toEqual([])
  })
})
