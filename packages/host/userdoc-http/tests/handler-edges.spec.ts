import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
  UserDocId,
  type UserDocErrorCode,
  type UserDocRef,
  type UserDocStore,
} from '@deepseek-ai/dsh-userdoc'
import { handleUserDocHttp, USERDOC_HTTP_PATH, USERDOC_UPLOAD_HEADER } from '../src/index.ts'

const LIMITS = {
  maxFileBytes: 8,
  maxFilesPerMessage: 2,
  maxMessageBytes: 16,
  maxInlineTextBytes: 8,
}

const REF: UserDocRef = {
  docId: UserDocId('2026-08-15/report.txt'),
  path: '/uploads/2026-08-15/report.txt',
  name: 'report.txt',
  bytes: 4,
  mediaType: 'text/plain',
  modifiedAt: 1,
}

type StoreOverrides = Partial<Pick<UserDocStore, 'list' | 'resolveTarget' | 'save' | 'openRead' | 'remove'>>

function stream(text = 'body'): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function store(overrides: StoreOverrides = {}): UserDocStore {
  return Object.assign({
    limits: LIMITS,
    list: async () => [],
    resolveTarget: async () => ({ docId: REF.docId, path: REF.path, name: REF.name }),
    save: async () => REF,
    openRead: async () => ({ ref: REF, body: stream() }),
    remove: async () => {},
  }, overrides) as unknown as UserDocStore
}

function context(userDocs: UserDocStore): Context {
  return { userDocs } as unknown as Context
}

function request(method: string, url?: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  Object.assign(req, { method, headers, ...(url === undefined ? {} : { url }) })
  return req
}

interface ResponseState {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string
  destroyError: Error | undefined
}

interface ResponseOptions {
  readonly initiallyDestroyed?: boolean
  readonly backpressure?: boolean
  readonly closeOnWrite?: boolean
}

function response(options: ResponseOptions = {}): { res: ServerResponse; state: ResponseState } {
  const state: ResponseState = {
    status: undefined,
    headers: undefined,
    body: '',
    destroyError: undefined,
  }
  const chunks: Buffer[] = []
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    writableEnded: false,
    destroyed: options.initiallyDestroyed === true,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers
      return this
    },
    write(this: { destroyed: boolean; writableEnded: boolean }, value: string | Uint8Array) {
      chunks.push(Buffer.from(value))
      if (options.closeOnWrite === true) {
        this.destroyed = true
        this.writableEnded = true
      }
      if (options.backpressure === true) {
        queueMicrotask(() => { emitter.emit(options.closeOnWrite === true ? 'close' : 'drain') })
        return false
      }
      return true
    },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      state.body = Buffer.concat(chunks).toString('utf8')
      this.writableEnded = true
      return this
    },
    destroy(this: { destroyed: boolean }, error?: Error) {
      this.destroyed = true
      state.destroyError = error
      emitter.emit('close')
      return this
    },
  }) as unknown as ServerResponse
  return { res, state }
}

describe('user-document HTTP handler edges', () => {
  it.each([
    ['not-a-number', 'INVALID_CONTENT_LENGTH'],
    ['-1', 'INVALID_CONTENT_LENGTH'],
  ])('rejects the Content-Length value %s', async (declared, code) => {
    const req = request('POST', `${USERDOC_HTTP_PATH}?name=report.txt`, {
      [USERDOC_UPLOAD_HEADER]: '1',
      'content-length': declared,
    })
    const { res, state } = response()

    await handleUserDocHttp(context(store()), req, res)

    expect(state.status).toBe(400)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code } })
  })

  it('rejects an upload with no name query parameter', async () => {
    const req = request('POST', USERDOC_HTTP_PATH, { [USERDOC_UPLOAD_HEADER]: '1' })
    const { res, state } = response()

    await handleUserDocHttp(context(store()), req, res)

    expect(state.status).toBe(400)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: INVALID_DOCUMENT_NAME_CODE } })
  })

  it('uses the document root when IncomingMessage.url is absent', async () => {
    const { res, state } = response()

    await handleUserDocHttp(context(store()), request('GET'), res)

    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toMatchObject({ documents: [] })
  })

  it.each([
    [`${USERDOC_HTTP_PATH}/content`, 'GET'],
    [`${USERDOC_HTTP_PATH}?id=`, 'DELETE'],
  ])('requires a non-empty document id for %s', async (url, method) => {
    const { res, state } = response()

    await handleUserDocHttp(context(store()), request(method, url), res)

    expect(state.status).toBe(400)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: INVALID_DOCUMENT_REF_CODE } })
  })

  it.each<readonly [UserDocErrorCode, number]>([
    [DOCUMENT_NOT_FOUND_CODE, 404],
    [DOCUMENT_TOO_LARGE_CODE, 413],
    [DOCUMENT_TARGET_CONFLICT_CODE, 409],
    [DOCUMENT_NAME_EXHAUSTED_CODE, 409],
    [INVALID_DOCUMENT_NAME_CODE, 400],
    [INVALID_DOCUMENT_REF_CODE, 400],
    [DOCUMENT_READ_FAILED_CODE, 500],
  ])('maps the store error %s to HTTP %i', async (code, status) => {
    const userDocs = store({
      openRead: async () => { throw new UserDocError('store failure', code) },
    })
    const { res, state } = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(status)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code } })
  })

  it('maps a non-document failure to the stable internal response', async () => {
    const userDocs = store({ openRead: async () => { throw new Error('private failure') } })
    const { res, state } = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(500)
    expect(JSON.parse(state.body)).toEqual({
      error: { code: 'INTERNAL', message: 'Document operation failed.' },
    })
  })

  it('cancels a list when the client disconnects and writes no late response', async () => {
    const req = request('GET', USERDOC_HTTP_PATH)
    const { res, state } = response()
    let signal: AbortSignal | undefined
    const userDocs = store({
      list: async (candidate) => {
        signal = candidate
        req.emit('aborted')
        res.emit('close')
        return []
      },
    })

    await handleUserDocHttp(context(userDocs), req, res)

    expect(signal?.aborted).toBe(true)
    expect(state.status).toBeUndefined()
  })

  it('does not write an upload failure after the request has aborted', async () => {
    const req = request('POST', `${USERDOC_HTTP_PATH}?name=report.txt`, { [USERDOC_UPLOAD_HEADER]: '1' })
    const { res, state } = response()
    const userDocs = store({
      resolveTarget: async () => {
        req.emit('aborted')
        throw new Error('late store failure')
      },
    })

    await handleUserDocHttp(context(userDocs), req, res)

    expect(state.status).toBeUndefined()
  })

  it('does not replace a response that ended while a store failure settled', async () => {
    const { res, state } = response()
    const userDocs = store({
      list: async () => {
        res.end()
        throw new Error('late list failure')
      },
    })

    await handleUserDocHttp(context(userDocs), request('GET', USERDOC_HTTP_PATH), res)

    expect(state.status).toBeUndefined()
    expect(res.writableEnded).toBe(true)
  })

  it('stops a backpressured download when the response closes', async () => {
    const userDocs = store({ openRead: async () => ({ ref: REF, body: stream() }) })
    const { res, state } = response({ backpressure: true, closeOnWrite: true })

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(200)
    expect(res.destroyed).toBe(true)
    expect(res.writableEnded).toBe(true)
  })

  it('destroys an open response when the download stream fails', async () => {
    const failure = new Error('stream failed')
    const failed = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure) },
    })
    const userDocs = store({ openRead: async () => ({ ref: REF, body: failed }) })
    const first = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), first.res)

    expect(first.state.destroyError).toBe(failure)

    const alreadyDestroyed = response({ initiallyDestroyed: true })
    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), alreadyDestroyed.res)
    expect(alreadyDestroyed.state.destroyError).toBeUndefined()
  })
})
