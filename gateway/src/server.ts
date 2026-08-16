import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { UserRow } from './auth.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import type { GatewayConfig } from './config.ts'
import type { ProjectRuntime } from './instances.ts'
import type { PrincipalScope } from './principal.ts'
import { loginPage, passwordPage } from './html.ts'
import type {
  Awaitable,
  GatewayAuditService,
  GatewayAuthService,
  GatewayCollaborationService,
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
  collaboration?: GatewayCollaborationService
  readiness?: () => Awaitable<void>
}

export const SESSION_COOKIE = 'hgw_session'
export const SCOPE_COOKIE = 'hgw_scope'

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

export function scopeCookie(scope: 'personal' | `project:${number}`, cfg: GatewayConfig): string {
  return `${SCOPE_COOKIE}=${scope}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(cfg.sessionAbsoluteTtlMs / 1000)}`
    + (cfg.secureCookies ? '; Secure' : '')
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? ''
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new BodyTooLargeError('body too large')
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

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function accountProjectError(error: unknown): { status: number; error: string } {
  if (error instanceof CollaborationDeniedError) {
    return { status: error.code === 'conversation-not-found' ? 404 : 403, error: error.code }
  }
  if (error instanceof Error) {
    const status = error.message === 'invitation-already-pending' || error.message === 'invitation-already-member' ? 409
      : error.message === 'invitation-not-found' || error.message === 'project-not-found' ? 404
        : error.message === 'invitation-forbidden' ? 403
          : error.message === 'invitation-expired' ? 410
            : error.message === 'invitation-not-pending' ? 409
              : error.message === 'owner-protected' || error.message === 'owner-must-be-rw' || error.message === 'user-disabled' ? 409
                : error.message.startsWith('duplicate ') ? 409 : 400
    return { status, error: error.message }
  }
  return { status: 400, error: String(error) }
}

export interface GatewayRequestContext {
  user: UserRow
  scope: PrincipalScope
  runtime: UserRow | ProjectRuntime
}

export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, context: GatewayRequestContext) => Promise<void>
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, context: GatewayRequestContext) => Promise<void>

export interface GatewayHandlers {
  proxy?: ProxyHandler
  upgrade?: UpgradeHandler
  admin?: (req: IncomingMessage, res: ServerResponse, user: UserRow, pathname: string, body: string) => Promise<boolean>
  runtime?: (req: IncomingMessage, res: ServerResponse, pathname: string, body: string) => Promise<boolean>
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

  const requestContext = async (req: IncomingMessage, user: UserRow): Promise<{
    context: GatewayRequestContext
    resetScope: boolean
  }> => {
    const raw = parseCookies(req.headers.cookie).get(SCOPE_COOKIE)
    const match = raw?.match(/^project:([1-9][0-9]*)$/)
    if (match === null || match === undefined || deps.collaboration === undefined) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: raw !== undefined && raw !== 'personal' }
    }
    const projectId = Number(match[1])
    if (!Number.isSafeInteger(projectId)) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: true }
    }
    const project = await deps.collaboration.projectForUser(projectId, user.id)
    if (project === null) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: true }
    }
    return {
      context: {
        user,
        scope: { kind: 'project', projectId, projectName: project.name, mode: project.mode },
        runtime: { kind: 'project', id: projectId, name: project.name, path: project.path },
      },
      resetScope: false,
    }
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

    if (pathname.startsWith('/internal/runtime/')) {
      let body = ''
      try {
        body = req.method === 'GET' || req.method === 'HEAD'
          ? ''
          : await readBody(req, cfg.runtimeApiBodyLimitBytes)
      } catch (error: unknown) {
        if (!(error instanceof BodyTooLargeError)) throw error
        send(res, 413, '{"error":"runtime-request-too-large"}', 'application/json')
        return
      }
      if (handlers.runtime !== undefined && await handlers.runtime(req, res, pathname, body)) return
      send(res, 404, '{"error":"not-found"}', 'application/json')
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
      const resolvedUsage = await requestContext(req, user)
      if (resolvedUsage.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))
      const subject = resolvedUsage.context.scope.kind === 'project'
        ? { kind: 'project' as const, id: resolvedUsage.context.scope.projectId }
        : { kind: 'user' as const, id: user.id }
      send(res, 200, JSON.stringify(await deps.governance.summary(subject, month)), 'application/json')
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

    if (pathname === '/account/api/scope' && req.method === 'POST') {
      let requested: unknown
      try {
        requested = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, '{"error":"invalid-json"}', 'application/json')
        return
      }
      if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) {
        send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const value = requested as { kind?: unknown; projectId?: unknown }
      if (value.kind === 'personal') {
        res.writeHead(204, { 'set-cookie': scopeCookie('personal', cfg) })
        res.end()
        return
      }
      if (value.kind !== 'project' || typeof value.projectId !== 'number'
        || !Number.isSafeInteger(value.projectId) || value.projectId <= 0) {
        send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const project = await deps.collaboration?.projectForUser(value.projectId, user.id)
      if (project === undefined || project === null) {
        send(res, 403, '{"error":"not-member"}', 'application/json')
        return
      }
      res.writeHead(204, { 'set-cookie': scopeCookie(`project:${value.projectId}`, cfg) })
      res.end()
      return
    }

    const resolved = await requestContext(req, user)
    if (resolved.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))

    if (pathname === '/account/api/context' && req.method === 'GET') {
      const scopes = await deps.collaboration?.projectsForUser(user.id) ?? []
      const projects = await Promise.all(scopes.map(async (scope) => {
        const detail = await deps.projects.getById(scope.projectId)
        const canManage = user.role === 'admin' || detail?.owner?.id === user.id
        return canManage ? { ...scope, canManage: true } : scope
      }))
      send(res, 200, JSON.stringify({
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        },
        scope: resolved.context.scope,
        projects,
        // The shared project runtime remains confined to its project path;
        // this flag only advertises the administrator-only preset choice.
        fullAccess: user.role === 'admin',
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/projects') {
      try {
        if (req.method === 'GET') {
          const scopes = await deps.collaboration?.projectsForUser(user.id) ?? []
          const details = await Promise.all(scopes.map(scope => deps.projects.getById(scope.projectId)))
          send(res, 200, JSON.stringify(details.filter((project): project is NonNullable<typeof project> => project !== null).map(project => ({
            ...project,
            canManage: user.role === 'admin' || project.owner?.id === user.id,
          }))), 'application/json')
          return
        }
        if (req.method === 'POST') {
          const input = jsonObject(await readBody(req))
          const name = stringField(input?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          if (deps.projects.createManaged === undefined) {
            send(res, 503, '{"error":"managed-projects-unavailable"}', 'application/json'); return
          }
          const project = await deps.projects.createManaged({ name, ownerUserId: user.id })
          await audit.write({ userId: user.id, action: 'projects.create', detail: JSON.stringify({ id: project.id, origin: 'user' }), ip: clientIp(req) })
          send(res, 201, JSON.stringify(project), 'application/json')
          return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/invitations' && req.method === 'GET') {
      if (deps.projects.listInvitations === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      send(res, 200, JSON.stringify(await deps.projects.listInvitations(user.id)), 'application/json')
      return
    }

    const invitationAccept = pathname.match(/^\/account\/api\/invitations\/([^/]+)\/accept$/)
    if (invitationAccept !== null && req.method === 'POST') {
      if (deps.projects.acceptInvitation === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      try {
        await deps.projects.acceptInvitation(decodeURIComponent(invitationAccept[1] ?? ''), user.id)
        await audit.write({ userId: user.id, action: 'projects.invitation.accept', ip: clientIp(req) })
        res.writeHead(204); res.end()
      } catch (error) {
        if (error instanceof URIError) {
          send(res, 400, JSON.stringify({ error: 'invalid-invitation-id' }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const accountProjectPath = pathname.match(/^\/account\/api\/projects\/(\d+)(?:\/(invitations))?$/)
    if (accountProjectPath !== null) {
      const projectId = Number(accountProjectPath[1])
      const isInvitationPath = accountProjectPath[2] !== undefined
      try {
        const project = await deps.projects.getById(projectId)
        if (project === null) { send(res, 404, '{"error":"project-not-found"}', 'application/json'); return }
        const authority = await deps.collaboration?.projectForUser(projectId, user.id)
        if (authority === null || authority === undefined) { send(res, 403, '{"error":"not-member"}', 'application/json'); return }
        const canManage = user.role === 'admin' || authority.administrator || project.owner?.id === user.id
        if (isInvitationPath) {
          if (req.method === 'GET') {
            if (deps.projects.listInvitations === undefined) { send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return }
            send(res, 200, JSON.stringify(await deps.projects.listInvitations(user.id, projectId)), 'application/json'); return
          }
          if (req.method === 'POST') {
            if (!canManage || deps.projects.createInvitation === undefined) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
            const input = jsonObject(await readBody(req))
            const username = stringField(input?.username)
            const mode = input?.mode === 'ro' || input?.mode === 'rw' ? input.mode : undefined
            if (username === undefined || mode === undefined) { send(res, 400, '{"error":"username and mode required"}', 'application/json'); return }
            const invitee = await users.getByUsername(username)
            if (invitee === null) { send(res, 404, '{"error":"user-not-found"}', 'application/json'); return }
            if (invitee.id === user.id) { send(res, 400, '{"error":"cannot-invite-self"}', 'application/json'); return }
            const invitation = await deps.projects.createInvitation({ projectId, inviteeUserId: invitee.id, inviterUserId: user.id, mode })
            await audit.write({ userId: user.id, action: 'projects.invitation.create', detail: JSON.stringify({ projectId, inviteeUserId: invitee.id, mode }), ip: clientIp(req) })
            send(res, 201, JSON.stringify(invitation), 'application/json'); return
          }
          send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return
        }
        if (req.method === 'GET') {
          send(res, 200, JSON.stringify({ ...project, canManage }), 'application/json'); return
        }
        if (req.method === 'PATCH') {
          if (!canManage) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
          const name = stringField(jsonObject(await readBody(req))?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          await deps.projects.rename(projectId, name)
          await audit.write({ userId: user.id, action: 'projects.rename', detail: JSON.stringify({ projectId, name }), ip: clientIp(req) })
          res.writeHead(204); res.end(); return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/conversations' && req.method === 'GET') {
      if (resolved.context.scope.kind !== 'project' || deps.collaboration === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      send(res, 200, JSON.stringify({
        items: await deps.collaboration.listConversations(user.id, resolved.context.scope.projectId),
      }), 'application/json')
      return
    }

    const conversationRoute = pathname.match(/^\/account\/api\/conversations\/([^/]+)$/)
    if (conversationRoute !== null && deps.collaboration !== undefined) {
      try {
        const sessionId = decodeURIComponent(conversationRoute[1] ?? '')
        if (req.method === 'GET') {
          const access = await deps.collaboration.access(user.id, sessionId, 'read')
          const items = await deps.collaboration.listConversations(user.id, access.projectId)
          send(res, 200, JSON.stringify({ access, conversation: items.find(item => item.sessionId === access.rootSessionId) ?? null }), 'application/json')
          return
        }
        if (req.method === 'PATCH') {
          const body = JSON.parse(await readBody(req)) as { visibility?: unknown }
          if (body.visibility !== 'project' && body.visibility !== 'private') {
            send(res, 400, '{"error":"invalid-visibility"}', 'application/json')
            return
          }
          await deps.collaboration.setVisibility(user.id, sessionId, body.visibility)
          res.writeHead(204)
          res.end()
          return
        }
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          const status = error.code === 'conversation-not-found' ? 404
            : error.code === 'visibility-locked' ? 409 : 403
          send(res, status, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        if (error instanceof SyntaxError) {
          send(res, 400, '{"error":"invalid-json"}', 'application/json')
          return
        }
        if (error instanceof URIError) {
          send(res, 400, '{"error":"invalid-session-id"}', 'application/json')
          return
        }
        throw error
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

    if (handlers.proxy !== undefined) { await handlers.proxy(req, res, resolved.context); return }
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
      const resolved = await requestContext(req, session.user)
      await handlers.upgrade(req, socket, head, resolved.context)
    }
    void finish().catch(() => socket.destroy())
  })

  return server
}
