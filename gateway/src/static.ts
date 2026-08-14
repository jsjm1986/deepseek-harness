import { readFileSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const gatewayRoot = resolve(import.meta.dirname, '..')

/** Default Vite `outDir` for the admin SPA. */
export const DEFAULT_ADMIN_ROOT = join(gatewayRoot, 'public/admin')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

function inside(rootReal: string, fileReal: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  return fileReal === rootReal || fileReal.startsWith(prefix)
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

/**
 * True for `/admin` and `/admin/...` only. `/adminfoo` is not admin.
 * @param pathname - already-parsed URL pathname
 * @returns whether the path is the admin SPA or `/admin/api`
 */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

/**
 * Serves the admin SPA shell and `/admin/assets/*` from `root`.
 * @param req - used for GET/HEAD only
 * @param res - written on a hit (200 or 404)
 * @param pathname - already-parsed URL pathname
 * @param root - asset directory; default `gateway/public/admin`
 * @returns true when a response was written
 */
export function serveAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  root = DEFAULT_ADMIN_ROOT,
): boolean {
  if (!isAdminPath(pathname) || pathname.startsWith('/admin/api')) return false
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false

  let rootReal: string
  try { rootReal = realpathSync(root) } catch {
    return false
  }

  const spa = extname(pathname) === ''
  const rel = spa
    ? 'index.html'
    : pathname.startsWith('/admin/assets/')
      ? pathname.slice('/admin/'.length)
      : null
  if (rel === null) return false

  let fileReal: string
  try { fileReal = realpathSync(join(rootReal, rel)) } catch {
    if (spa) return false
    send(res, 404, 'not found', 'text/plain')
    return true
  }
  if (!inside(rootReal, fileReal)) {
    send(res, 404, 'not found', 'text/plain')
    return true
  }

  const type = TYPES[extname(fileReal)] ?? 'application/octet-stream'
  send(res, 200, method === 'HEAD' ? '' : readFileSync(fileReal), type)
  return true
}
