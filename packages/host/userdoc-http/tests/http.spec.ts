import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalUserDocStore from '@deepseek-ai/dsh-userdoc-local'
import {
  DOCUMENT_TOO_LARGE_CODE,
  INVALID_DOCUMENT_NAME_CODE,
} from '@deepseek-ai/dsh-userdoc'
import {
  handleUserDocHttp,
  USERDOC_HTTP_PATH,
  USERDOC_UPLOAD_HEADER,
} from '../src/index.ts'

let root: string
let context: Context
let server: Server
let origin: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-http-'))
  context = new Context()
  await context.plugin(LocalUserDocStore, { uploadRoot: root, maxFileBytes: 8 })
  server = createServer((req, res) => { void handleUserDocHttp(context, req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  await context.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

async function upload(name: string, body: BodyInit, headers: HeadersInit = {}): Promise<Response> {
  const requestHeaders = new Headers(headers)
  requestHeaders.set(USERDOC_UPLOAD_HEADER, '1')
  return fetch(`${origin}${USERDOC_HTTP_PATH}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: requestHeaders,
    body,
  })
}

describe('user-document HTTP consumer', () => {
  it('streams an upload, lists it, downloads GET and HEAD, then deletes it idempotently', async () => {
    const created = await upload('年报.txt', 'hello')
    expect(created.status).toBe(201)
    const ref = await created.json() as { docId: string; path: string; name: string; bytes: number }
    expect(ref).toMatchObject({ name: '年报.txt', bytes: 5 })
    expect(await readFile(ref.path, 'utf8')).toBe('hello')

    const listed = await fetch(`${origin}${USERDOC_HTTP_PATH}`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      limits: { maxFileBytes: 8 },
      documents: [{ docId: ref.docId, name: '年报.txt', bytes: 5 }],
    })

    const url = `${origin}${USERDOC_HTTP_PATH}/content?id=${encodeURIComponent(ref.docId)}`
    const downloaded = await fetch(url)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('text/plain')
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(downloaded.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    expect(await downloaded.text()).toBe('hello')

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('5')
    expect(await head.text()).toBe('')

    const remove = `${origin}${USERDOC_HTTP_PATH}?id=${encodeURIComponent(ref.docId)}`
    expect((await fetch(remove, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(remove, { method: 'DELETE' })).status).toBe(204)
    expect(await (await fetch(`${origin}${USERDOC_HTTP_PATH}`)).json()).toMatchObject({ documents: [] })
  })

  it('requires the non-simple upload header before consuming a body', async () => {
    const response = await fetch(`${origin}${USERDOC_HTTP_PATH}?name=a.txt`, {
      method: 'POST', body: 'body',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'UPLOAD_HEADER_REQUIRED' } })
  })

  it('maps declared and streamed byte-limit failures to the stable public code', async () => {
    const declared = await upload('large.bin', '123456789')
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ error: { code: DOCUMENT_TOO_LARGE_CODE } })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'))
        controller.enqueue(new TextEncoder().encode('67890'))
        controller.close()
      },
    })
    const streamed = await fetch(`${origin}${USERDOC_HTTP_PATH}?name=stream.bin`, {
      method: 'POST',
      headers: { [USERDOC_UPLOAD_HEADER]: '1' },
      body: stream,
      // Node fetch requires duplex for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(streamed.status).toBe(413)
    expect(await streamed.json()).toMatchObject({ error: { code: DOCUMENT_TOO_LARGE_CODE } })
    expect(await (await fetch(`${origin}${USERDOC_HTTP_PATH}`)).json()).toMatchObject({ documents: [] })
  })

  it('returns stable validation errors without leaking an absolute path', async () => {
    const missing = await upload('', 'x')
    expect(missing.status).toBe(400)
    const body = await missing.text()
    expect(JSON.parse(body)).toMatchObject({ error: { code: INVALID_DOCUMENT_NAME_CODE } })
    expect(body).not.toContain(root)

    const badRef = await fetch(`${origin}${USERDOC_HTTP_PATH}/content?id=..%2Foutside`)
    expect(badRef.status).toBe(400)
    expect(await badRef.text()).not.toContain(root)
  })

  it('returns 404 for paths and methods outside the owned contract', async () => {
    expect((await fetch(`${origin}${USERDOC_HTTP_PATH}/other`)).status).toBe(404)
    expect((await fetch(`${origin}${USERDOC_HTTP_PATH}`, { method: 'PUT' })).status).toBe(404)
  })
})
