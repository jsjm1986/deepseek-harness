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
  origin?: 'admin' | 'user'
  owner?: { id: number; username: string; displayName: string } | null
  createdBy?: { id: number; username: string; displayName: string } | null
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

export function deleteUser(id: number): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'DELETE' })
}

export function resetPassword(id: number, password: string): Promise<void> {
  return request(`/admin/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) })
}

export function controlInstance(id: number, op: 'start' | 'stop' | 'restart'): Promise<void> {
  return request(`/admin/api/users/${id}/instance/${op}`, { method: 'POST' })
}

export function listProjects(origin?: 'admin' | 'user'): Promise<Project[]> {
  return request(`/admin/api/projects${origin === undefined ? '' : `?origin=${origin}`}`)
}

export function createProject(body: { name: string; path?: string }): Promise<Project> {
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

export type ModelGovernanceRow = {
  provider: string
  model: string
  displayName: string
  enabled: boolean
  adminAllowed: boolean
  userAllowed: boolean
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
}

export type ModelAccessView = {
  effective: {
    version: number
    defaultAllowed: boolean
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }
  overrides: Array<{ provider: string; model: string; allowed: boolean }>
}

export type UsageSummary = {
  month: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostMicros: number
  companyCostMicros: number
  calls: number
  missingUsageCalls: number
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
  alerts: Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }>
}

export type AdminUsageSummary = UsageSummary & { userId: number; username: string }

export function listModels(): Promise<ModelGovernanceRow[]> {
  return request('/admin/api/models')
}

export function saveModel(model: ModelGovernanceRow): Promise<void> {
  return request('/admin/api/models', { method: 'PUT', body: JSON.stringify(model) })
}

export function getModelAccess(userId: number): Promise<ModelAccessView> {
  return request(`/admin/api/model-access?userId=${userId}`)
}

export function setModelAccess(userId: number, provider: string, model: string, allowed: boolean | null): Promise<void> {
  return request('/admin/api/model-access', {
    method: 'PUT', body: JSON.stringify({ userId, provider, model, allowed }),
  })
}

export function setQuota(body: {
  subjectType: 'role' | 'user' | 'project'
  subjectId: string
  tokenLimit: number | null | 'inherit'
  companyCostMicrosLimit: number | null | 'inherit'
}): Promise<void> {
  return request('/admin/api/quotas', { method: 'PUT', body: JSON.stringify(body) })
}

export function listUsage(month?: string): Promise<AdminUsageSummary[]> {
  return request(`/admin/api/usage${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function getProjectUsage(projectId: number, month?: string): Promise<UsageSummary> {
  const query = new URLSearchParams({ projectId: String(projectId) })
  if (month !== undefined && month !== '') query.set('month', month)
  return request(`/admin/api/usage?${query.toString()}`)
}
