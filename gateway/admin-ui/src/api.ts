export type AdminUser = {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  homePath: string
  mustChangePassword: boolean
  port: number
  instanceState: string
}

export type Project = {
  id: number
  name: string
  path: string
  memberCount: number
}

export type GrantMode = 'ro' | 'rw'

export type ProjectDetail = Project & {
  members: Array<{ userId: number; username: string; mode: GrantMode }>
}

export type AuditEntry = {
  id: number
  ts: number
  userId: number | null
  action: string
  methodPath: string
  status: number | null
  ip: string
}

export type AuditFilter = {
  userId?: number
  actionPrefix?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error)
  if (res.status === 204) return undefined as T
  return await res.json() as T
}

export function listUsers(): Promise<AdminUser[]> {
  return request('/admin/api/users')
}

export function createUser(body: {
  username: string
  password: string
  role?: 'admin' | 'user'
  displayName?: string
}): Promise<AdminUser> {
  return request('/admin/api/users', { method: 'POST', body: JSON.stringify(body) })
}

export function patchUser(id: number, body: {
  displayName?: string
  role?: 'admin' | 'user'
  status?: 'active' | 'disabled'
}): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function resetPassword(id: number, password: string): Promise<void> {
  return request(`/admin/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) })
}

export function controlInstance(id: number, op: 'start' | 'stop' | 'restart'): Promise<void> {
  return request(`/admin/api/users/${id}/instance/${op}`, { method: 'POST' })
}

export function listProjects(): Promise<Project[]> {
  return request('/admin/api/projects')
}

export function createProject(body: { name: string; path: string }): Promise<Project> {
  return request('/admin/api/projects', { method: 'POST', body: JSON.stringify(body) })
}

export function getProject(id: number): Promise<ProjectDetail> {
  return request(`/admin/api/projects/${id}`)
}

export function renameProject(id: number, name: string): Promise<void> {
  return request(`/admin/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export function deleteProject(id: number): Promise<void> {
  return request(`/admin/api/projects/${id}`, { method: 'DELETE' })
}

export function setMember(projectId: number, userId: number, mode: GrantMode): Promise<void> {
  return request(`/admin/api/projects/${projectId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  })
}

export function removeMember(projectId: number, userId: number): Promise<void> {
  return request(`/admin/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' })
}

export function listAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const q = new URLSearchParams()
  if (filter.userId !== undefined) q.set('userId', String(filter.userId))
  if (filter.actionPrefix !== undefined && filter.actionPrefix !== '') q.set('actionPrefix', filter.actionPrefix)
  if (filter.from !== undefined) q.set('from', String(filter.from))
  if (filter.to !== undefined) q.set('to', String(filter.to))
  if (filter.limit !== undefined) q.set('limit', String(filter.limit))
  if (filter.offset !== undefined) q.set('offset', String(filter.offset))
  const qs = q.toString()
  return request(`/admin/api/audit${qs === '' ? '' : `?${qs}`}`)
}
