import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyGrantsToUser } from './apply-grants.ts'
import type { UserRow } from './auth.ts'
import type { GrantMode } from './projects.ts'
import type { GatewayDeps, GatewayHandlers } from './server.ts'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error })
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204)
  res.end()
}

function parseObject(body: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(body) } catch { throw new Error('invalid json') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json')
  return value as Record<string, unknown>
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function mapError(error: unknown): { status: number; error: string } {
  if (error instanceof Error && error.message === 'cannot-remove-last-admin') {
    return { status: 409, error: 'cannot-remove-last-admin' }
  }
  if (error instanceof Error && error.message === 'invalid json') {
    return { status: 400, error: 'invalid json' }
  }
  if (error instanceof Error && error.message.startsWith('duplicate ')) {
    return { status: 409, error: error.message }
  }
  if (isCodedError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return { status: 409, error: 'duplicate' }
  }
  return { status: 400, error: error instanceof Error ? error.message : String(error) }
}

/**
 * JSON router for `/admin/api/*`. Other `/admin` paths return false so static hosting can serve them.
 * @param deps - users, projects, audit, instances
 * @returns admin handler that writes 200 JSON, 204, or `{ error }` at 400/404/409
 */
export function createAdminApiHandler(deps: GatewayDeps): NonNullable<GatewayHandlers['admin']> {
  return async (req: IncomingMessage, res: ServerResponse, admin: UserRow, pathname: string, body: string): Promise<boolean> => {
    if (!pathname.startsWith('/admin/api')) return false
    try {
      const ok = await dispatch(deps, req, res, admin, pathname, body)
      if (!ok) sendError(res, 404, 'not found')
    } catch (error) {
      if (res.writableEnded) throw error
      const mapped = mapError(error)
      sendError(res, mapped.status, mapped.error)
    }
    return true
  }
}

async function dispatch(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
  admin: UserRow,
  pathname: string,
  body: string,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  const ip = req.socket.remoteAddress ?? ''
  const write = (action: string, detail: Record<string, unknown>) =>
    deps.audit.write({ userId: admin.id, action, detail: JSON.stringify(detail), ip })

  const apply = async (userId: number): Promise<void> => {
    const prior = deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
    try {
      await applyGrantsToUser(deps, userId, admin.id)
    } catch (error) {
      const next = deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
      if (next.length > prior.length) return
      throw error
    }
  }

  if (pathname === '/admin/api/users') {
    if (method === 'GET') { sendJson(res, 200, deps.users.list()); return true }
    if (method === 'POST') {
      const input = parseObject(body)
      const username = str(input, 'username')
      const password = str(input, 'password')
      if (username === undefined || password === undefined) { sendError(res, 400, 'username and password required'); return true }
      const role = str(input, 'role') === 'admin' ? 'admin' as const : 'user' as const
      const displayName = str(input, 'displayName')
      const user = await deps.users.create({ username, password, role, displayName })
      write('admin.users', { username, role })
      sendJson(res, 200, user)
      return true
    }
    return false
  }

  const userInstance = /^\/admin\/api\/users\/(\d+)\/instance\/(start|stop|restart)$/.exec(pathname)
  if (userInstance !== null) {
    if (method !== 'POST') return false
    const userId = Number(userInstance[1])
    const op = userInstance[2] as 'start' | 'stop' | 'restart'
    const target = deps.users.getById(userId)
    if (target === null) { sendError(res, 404, 'user not found'); return true }
    if (op === 'stop') await deps.instances.stop(userId)
    else if (op === 'start') await deps.instances.ensureRunning(target)
    else {
      await deps.instances.stop(userId)
      await deps.instances.ensureRunning(target)
    }
    write(`admin.instances.${op}`, { id: userId })
    sendNoContent(res)
    return true
  }

  const userPassword = /^\/admin\/api\/users\/(\d+)\/password$/.exec(pathname)
  if (userPassword !== null) {
    if (method !== 'POST') return false
    const userId = Number(userPassword[1])
    if (deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    const password = str(parseObject(body), 'password')
    if (password === undefined) { sendError(res, 400, 'password required'); return true }
    await deps.users.resetPassword(userId, password)
    write('admin.users.reset-password', { id: userId })
    sendNoContent(res)
    return true
  }

  const userIdPath = /^\/admin\/api\/users\/(\d+)$/.exec(pathname)
  if (userIdPath !== null) {
    if (method !== 'PATCH') return false
    const userId = Number(userIdPath[1])
    if (deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    const input = parseObject(body)
    const displayName = str(input, 'displayName')
    const role = str(input, 'role')
    const status = str(input, 'status')
    if (role !== undefined && role !== 'admin' && role !== 'user') { sendError(res, 400, 'invalid role'); return true }
    if (status !== undefined && status !== 'active' && status !== 'disabled') { sendError(res, 400, 'invalid status'); return true }
    if (role !== undefined) {
      deps.users.setRole(userId, role)
      write('admin.users.role', { id: userId, role })
    }
    if (status !== undefined) {
      deps.users.setStatus(userId, status)
      if (status === 'disabled') await deps.instances.stop(userId)
      write('admin.users.status', { id: userId, status })
    }
    if (displayName !== undefined) {
      deps.users.setDisplayName(userId, displayName)
      write('admin.users.display-name', { id: userId })
    }
    sendNoContent(res)
    return true
  }

  if (pathname === '/admin/api/projects') {
    if (method === 'GET') { sendJson(res, 200, deps.projects.list()); return true }
    if (method === 'POST') {
      const input = parseObject(body)
      const name = str(input, 'name')
      const path = str(input, 'path')
      if (name === undefined || path === undefined) { sendError(res, 400, 'name and path required'); return true }
      const project = deps.projects.create({ name, path, createdBy: admin.id })
      write('admin.projects.create', { id: project.id, name, path: project.path })
      sendJson(res, 200, project)
      return true
    }
    return false
  }

  const member = /^\/admin\/api\/projects\/(\d+)\/members\/(\d+)$/.exec(pathname)
  if (member !== null) {
    const projectId = Number(member[1])
    const userId = Number(member[2])
    if (deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
    if (deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    if (method === 'PUT') {
      const mode = str(parseObject(body), 'mode')
      if (mode !== 'ro' && mode !== 'rw') { sendError(res, 400, 'invalid mode'); return true }
      deps.projects.setMember(projectId, userId, mode as GrantMode)
      write('admin.members.set', { projectId, userId, mode })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      deps.projects.removeMember(projectId, userId)
      write('admin.members.remove', { projectId, userId })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  const projectIdPath = /^\/admin\/api\/projects\/(\d+)$/.exec(pathname)
  if (projectIdPath !== null) {
    const projectId = Number(projectIdPath[1])
    const project = deps.projects.getById(projectId)
    if (project === null) { sendError(res, 404, 'project not found'); return true }
    if (method === 'GET') { sendJson(res, 200, project); return true }
    if (method === 'PATCH') {
      const name = str(parseObject(body), 'name')
      if (name === undefined) { sendError(res, 400, 'name required'); return true }
      deps.projects.rename(projectId, name)
      write('admin.projects.rename', { id: projectId, name })
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      const userIds = deps.projects.remove(projectId)
      write('admin.projects.delete', { id: projectId })
      for (const userId of userIds) await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/audit') {
    if (method !== 'GET') return false
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    const num = (key: string): number | undefined => {
      const raw = q.get(key)
      if (raw === null || raw === '') return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    const action = q.get('action')
    const actionPrefix = q.get('actionPrefix')
    const rows = deps.audit.query({
      userId: num('userId'),
      action: action !== null && action !== '' ? action : undefined,
      actionPrefix: actionPrefix !== null && actionPrefix !== '' ? actionPrefix : undefined,
      fromMs: num('from') ?? num('fromMs'),
      toMs: num('to') ?? num('toMs'),
      limit: num('limit'),
      offset: num('offset'),
    }).map(r => ({
      id: r.id, ts: r.ts, userId: r.userId, action: r.action, methodPath: r.methodPath, status: r.status, ip: r.ip,
    }))
    sendJson(res, 200, rows)
    return true
  }

  return false
}
