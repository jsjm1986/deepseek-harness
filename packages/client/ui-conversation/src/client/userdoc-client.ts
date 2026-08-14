/** Browser HTTP client for the optional Host user-document service. */
import type { UserDocIdType, UserDocLimits, UserDocRef } from '@deepseek-ai/dsh-userdoc'

/** Stable error surfaced when the deployment does not mount the document route. */
export class UserDocServiceUnavailableError extends Error {
  /** HTTP status that indicated the route was absent, when known. */
  readonly status: number | undefined

  /** @param status - HTTP status that indicated the route was absent. */
  constructor(status?: number) {
    super('Document upload service is unavailable.')
    this.name = 'UserDocServiceUnavailableError'
    this.status = status
  }
}

/** HTTP failure returned by the document route. */
export class UserDocHttpError extends Error {
  /** HTTP status code. */
  readonly status: number
  /** Stable host error code, when the response carried one. */
  readonly code: string | undefined

  /** @param status - HTTP status code. @param message - response message. @param code - host error code. */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'UserDocHttpError'
    this.status = status
    this.code = code
  }
}

/** Response from the document list endpoint. */
export interface UserDocListResponse {
  readonly limits: UserDocLimits
  readonly documents: readonly UserDocRef[]
}

/** Progress callback for one streaming browser upload. */
export type UserDocUploadProgress = (loaded: number, total: number) => void

/** Optional document route client; all paths are relative to the current host. */
export interface UserDocClient {
  list(signal?: AbortSignal): Promise<UserDocListResponse>
  upload(file: File, signal?: AbortSignal, onProgress?: UserDocUploadProgress): Promise<UserDocRef>
  remove(docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  contentUrl(docId: UserDocIdType): string
}

const ROOT = '/api/documents'
const UPLOAD_HEADER = 'x-dsh-document-upload'

function contentUrl(docId: UserDocIdType): string {
  return `${ROOT}/content?id=${encodeURIComponent(docId)}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: { message: text } }
  }
}

function errorFrom(status: number, body: unknown): Error {
  if (status === 404) return new UserDocServiceUnavailableError(status)
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as { message?: unknown; code?: unknown }
      const message = typeof record.message === 'string' ? record.message : 'Document operation failed.'
      const code = typeof record.code === 'string' ? record.code : undefined
      return new UserDocHttpError(status, message, code)
    }
  }
  return new UserDocHttpError(status, 'Document operation failed.')
}

async function requestJson<T>(input: RequestInfo | URL, init: RequestInit | undefined): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, { cache: 'no-store', ...init })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw error instanceof Error ? error : new Error(String(error))
  }
  const body = await parseResponse(response)
  if (!response.ok) throw errorFrom(response.status, body)
  return body as T
}

function requestInit(method: string, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? { method } : { method, signal }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function xhrUpload(file: File, signal?: AbortSignal, onProgress?: UserDocUploadProgress): Promise<UserDocRef> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      fn()
    }
    const abort = (): void => {
      xhr.abort()
      finish(() => { reject(abortError(signal)) })
    }
    signal?.addEventListener('abort', abort, { once: true })
    xhr.open('POST', `${ROOT}?name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader(UPLOAD_HEADER, '1')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total)
      else onProgress?.(event.loaded, file.size)
    }
    xhr.onerror = () => { finish(() => { reject(new Error('Document upload failed.')) }) }
    xhr.onabort = () => { finish(() => { reject(abortError(signal)) }) }
    xhr.onload = () => {
      let body: unknown
      try { body = xhr.responseText === '' ? undefined : JSON.parse(xhr.responseText) as unknown } catch { body = undefined }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(() => { reject(errorFrom(xhr.status, body)) })
        return
      }
      finish(() => { resolve(body as UserDocRef) })
    }
    try {
      xhr.send(file)
    } catch (error) {
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

/**
 * Create the default relative-path document client.
 * @returns a client targeting the current host's document route.
 */
export function createUserDocClient(): UserDocClient {
  return {
    list: signal => requestJson<UserDocListResponse>(ROOT, requestInit('GET', signal)),
    upload: (file, signal, onProgress) => xhrUpload(file, signal, onProgress),
    remove: async (docId, signal) => {
      try {
        await requestJson<undefined>(`${ROOT}?id=${encodeURIComponent(docId)}`, requestInit('DELETE', signal))
      } catch (error) {
        // Delete is idempotent; a missing route means there is no durable object
        // to clean up, and a 404 from the route has the same convergence result.
        if (error instanceof UserDocServiceUnavailableError) return
        if (error instanceof UserDocHttpError && error.status === 404) return
        throw error
      }
    },
    contentUrl,
  }
}
