import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { loginPage, passwordPage } from './html.ts'
import type {
  Awaitable,
  GatewayAuditService,
  GatewayAuthService,
  GatewayInstanceService,
  GatewayModelGovernanceService,
  GatewayProjectService,
  GatewayUserService,
} from './services.ts'
import { isAdminPath, serveAdmin } from './static.ts'

export interface GatewayDeps {
  cfg: GatewayConfig
  auth: GatewayAuthService
  users: GatewayUserService
  projects: GatewayProjectService
  audit: GatewayAuditService
  instances: GatewayInstanceService
  governance?: GatewayModelGovernanceService
  readiness?: () => Awaitable<void>
}

export const SESSION_COOKIE = 'hgw_session'

export function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return map
}

export function sessionCookie(token: string, cfg: GatewayConfig, clear = false): string {
  const maxAge = clear ? 0 : Math.floor(cfg.sessionTtlMs / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (cfg.secureCookies ? '; Secure' : '')
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? ''
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function sendAdminGate(res: ServerResponse, pathname: string, error: string): void {
  if (pathname.startsWith('/admin/api')) {
    send(res, 403, JSON.stringify({ error }), 'application/json')
    return
  }
  send(res, 403, error, 'text/plain')
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, { location, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) })
  res.end()
}

function csrfOk(req: IncomingMessage, cfg: GatewayConfig, pathname: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  const origin = req.headers.origin
  if (origin !== undefined) return cfg.publicOrigins.includes(origin)
  return pathname.startsWith('/api')
}

export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, user: UserRow) => Promise<void>
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, user: UserRow) => Promise<void>

export interface GatewayHandlers {
  proxy?: ProxyHandler
  upgrade?: UpgradeHandler
  admin?: (req: IncomingMessage, res: ServerResponse, user: UserRow, pathname: string, body: string) => Promise<boolean>
  /** Override `serveAdmin` root (tests); default `gateway/public/admin`. */
  adminRoot?: string
}

export function createGatewayServer(deps: GatewayDeps, handlers: GatewayHandlers = {}): Server {
  const { cfg, auth, users, audit } = deps

  const currentUser = async (req: IncomingMessage): Promise<{ token: string; user: UserRow } | null> => {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (token === undefined) return null
    const user = await auth.validate(token)
    return user === null ? null : { token, user }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.writableEnded) send(res, 500, 'internal error', 'text/plain')
      console.error('[gateway] request failed:', error)
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname

    if (pathname === '/healthz') {
      try {
        await deps.readiness?.()
        send(res, 200, '{"ok":true}', 'application/json')
      } catch {
        send(res, 503, '{"ok":false}', 'application/json')
      }
      return
    }

    if (!csrfOk(req, cfg, pathname)) { sendAdminGate(res, pathname, 'origin not allowed'); return }

    if (pathname === '/login') {
      if (req.method === 'GET') { send(res, 200, loginPage()); return }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const username = form.get('username') ?? ''
        const result = await auth.login(username, form.get('password') ?? '', clientIp(req), req.headers['user-agent'] ?? '')
        if (result === 'locked') { await audit.write({ action: 'login.locked', ip: clientIp(req), detail: username }); send(res, 429, loginPage('尝试过于频繁，请 10 分钟后再试')); return }
        if (result === 'invalid') { await audit.write({ action: 'login.failed', ip: clientIp(req), detail: username }); send(res, 401, loginPage('用户名或密码错误')); return }
        await audit.write({ userId: result.user.id, action: 'login', ip: clientIp(req) })
        redirect(res, '/', [sessionCookie(result.token, cfg)])
        return
      }
    }

    const session = await currentUser(req)
    if (session === null) {
      if (wantsHtml(req)) { redirect(res, '/login'); return }
      send(res, 401, '{"error":"unauthorized"}', 'application/json')
      return
    }
    const { token, user } = session

    if (pathname === '/logout' && req.method === 'POST') {
      await auth.revoke(token)
      await audit.write({ userId: user.id, action: 'logout', ip: clientIp(req) })
      redirect(res, '/login', [sessionCookie('', cfg, true)])
      return
    }

    if (user.mustChangePassword && pathname !== '/account/password') {
      if (wantsHtml(req)) { redirect(res, '/account/password'); return }
      send(res, 403, '{"error":"password-change-required"}', 'application/json')
      return
    }

    if (pathname === '/account/api/usage' && req.method === 'GET') {
      if (deps.governance === undefined) { send(res, 503, '{"error":"usage-unavailable"}', 'application/json'); return }
      const month = new URL(req.url ?? '/', 'http://x').searchParams.get('month') ?? undefined
      send(res, 200, JSON.stringify(await deps.governance.summary(user.id, month)), 'application/json')
      return
    }

    if (pathname === '/account/password') {
      if (req.method === 'GET') { send(res, 200, passwordPage()); return }
      if (req.method === 'POST') {
        const password = new URLSearchParams(await readBody(req)).get('password') ?? ''
        if (password.length < 8) { send(res, 400, passwordPage('密码至少 8 位')); return }
        await users.changeOwnPassword(user.id, password)
        await audit.write({ userId: user.id, action: 'password.changed', ip: clientIp(req) })
        redirect(res, '/')
        return
      }
    }

    if (isAdminPath(pathname)) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      if (handlers.admin !== undefined && await handlers.admin(req, res, user, pathname, body)) return
      if (serveAdmin(req, res, pathname, handlers.adminRoot)) return
      send(res, 404, 'not found', 'text/plain')
      return
    }

    if (handlers.proxy !== undefined) { await handlers.proxy(req, res, user); return }
    send(res, 503, '{"error":"proxy-not-configured"}', 'application/json')
  }

  server.on('upgrade', (req, socket, head) => {
    const finish = async (): Promise<void> => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const origin = req.headers.origin
      if (origin !== undefined && !cfg.publicOrigins.includes(origin)) { socket.destroy(); return }
      const session = await currentUser(req)
      if (session === null || session.user.mustChangePassword) { socket.destroy(); return }
      if (handlers.upgrade === undefined || !pathname.startsWith('/api')) { socket.destroy(); return }
      await handlers.upgrade(req, socket, head, session.user)
    }
    void finish().catch(() => socket.destroy())
  })

  return server
}
