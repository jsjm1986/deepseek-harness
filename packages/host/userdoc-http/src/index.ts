/** Streaming HTTP consumer for user-uploaded documents. @module @deepseek-ai/dsh-host-userdoc-http */

import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import {
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
  UserDocId,
  type UserDocErrorCode,
  type UserDocRef,
} from '@deepseek-ai/dsh-userdoc'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Prefix owned by the document HTTP consumer below Connection's trusted route. */
export const USERDOC_HTTP_PATH = '/api/documents'
/** Non-simple request header required before an upload body is accepted. */
export const USERDOC_UPLOAD_HEADER = 'x-dsh-document-upload'

export const name = 'host-userdoc-http'
export const inject = ['connection', 'userDocs']

interface ErrorBody { error: { code: string; message: string } }

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function errorStatus(code: UserDocErrorCode): number {
  if (code === DOCUMENT_NOT_FOUND_CODE) return 404
  if (code === DOCUMENT_TOO_LARGE_CODE) return 413
  if (code === DOCUMENT_TARGET_CONFLICT_CODE || code === DOCUMENT_NAME_EXHAUSTED_CODE) return 409
  if (code === INVALID_DOCUMENT_NAME_CODE || code === INVALID_DOCUMENT_REF_CODE) return 400
  return 500
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof UserDocError) {
    json(res, errorStatus(error.code), { error: { code: error.code, message: error.message } } satisfies ErrorBody)
    return
  }
  json(res, 500, { error: { code: 'INTERNAL', message: 'Document operation failed.' } } satisfies ErrorBody)
}

function query(req: IncomingMessage): URL {
  return new URL(req.url ?? USERDOC_HTTP_PATH, 'http://dsh.internal')
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value === '') {
    throw new UserDocError(`Missing ${name}.`, INVALID_DOCUMENT_REF_CODE)
  }
  return value
}

function abortFor(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController()
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(new Error('HTTP client disconnected.')) }
  req.once('aborted', abort)
  res.once('close', () => { if (!res.writableEnded) abort() })
  return controller
}

function publicRef(ref: UserDocRef): UserDocRef {
  return { ...ref }
}

async function upload(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.headers[USERDOC_UPLOAD_HEADER] !== '1') {
    json(res, 400, { error: { code: 'UPLOAD_HEADER_REQUIRED', message: `${USERDOC_UPLOAD_HEADER}: 1 is required.` } } satisfies ErrorBody)
    return
  }
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      json(res, 400, { error: { code: 'INVALID_CONTENT_LENGTH', message: 'Content-Length must be a non-negative integer.' } } satisfies ErrorBody)
      return
    }
    if (bytes > ctx.userDocs.limits.maxFileBytes) {
      req.resume()
      json(res, 413, { error: { code: DOCUMENT_TOO_LARGE_CODE, message: 'Document exceeds the configured byte limit.' } } satisfies ErrorBody)
      return
    }
  }
  const filename = url.searchParams.get('name')
  if (filename === null) {
    req.resume()
    json(res, 400, { error: { code: INVALID_DOCUMENT_NAME_CODE, message: 'Missing name.' } } satisfies ErrorBody)
    return
  }
  const abort = abortFor(req, res)
  try {
    // IncomingMessage is consumed directly; no Connection/body-envelope buffer exists on this path.
    const target = await ctx.userDocs.resolveTarget({ name: filename })
    const body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    const ref = await ctx.userDocs.save(target, body, abort.signal)
    json(res, 201, publicRef(ref))
  } catch (error) {
    req.resume()
    if (!res.writableEnded && !abort.signal.aborted) failure(res, error)
  }
}

async function download(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const docId = UserDocId(requiredQuery(url, 'id'))
  const opened = await ctx.userDocs.openRead(docId)
  const headers = {
    'content-type': opened.ref.mediaType,
    'content-length': String(opened.ref.bytes),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.ref.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    await opened.body.cancel()
    res.end()
    return
  }
  try {
    for await (const chunk of opened.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')])
      if (res.destroyed) break
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (!res.destroyed) res.destroy(error as Error)
  }
}

/**
 * Handle the document subtree after Connection has admitted the request authority.
 * @param ctx - Host context containing Connection and the document store.
 * @param req - incoming HTTP request.
 * @param res - response that the route owns.
 */
export async function handleUserDocHttp(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = query(req)
  try {
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'GET') {
      const abort = abortFor(req, res)
      const documents = await ctx.userDocs.list(abort.signal)
      if (!abort.signal.aborted) json(res, 200, { limits: ctx.userDocs.limits, documents: documents.map(publicRef) })
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'POST') {
      await upload(ctx, req, res, url)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/content` && (req.method === 'GET' || req.method === 'HEAD')) {
      await download(ctx, req, res, url)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'DELETE') {
      await ctx.userDocs.remove(UserDocId(requiredQuery(url, 'id')))
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(404)
    res.end('not found')
  } catch (error) {
    if (!res.writableEnded) failure(res, error)
  }
}

/** Register the streaming document subtree in the current Connection transport. */
export function apply(ctx: Context): void {
  ctx.connection.http.handlePrefix(
    USERDOC_HTTP_PATH,
    (req, res) => handleUserDocHttp(ctx, req, res),
    { authority: 'trusted-host' },
  )
}
