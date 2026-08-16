import type { AuditRow } from './audit.ts'
import type { UserRow } from './auth.ts'
import type {
  CollaborationAction,
  ConversationAccess,
  ConversationCollaborationView,
  ProjectAuthorityView,
  ProjectScopeView,
} from './collaboration.ts'
import type { InstanceManager } from './instances.ts'
import type {
  ModelUsageSubject,
  ModelRow,
  UsageEvent,
  UsageSummary,
} from './model-governance.ts'
import type {
  EffectiveGrant,
  GrantMode,
  ProjectDetail,
  ProjectInvitation,
  ProjectRow,
} from './projects.ts'

/** A service result that may come from an in-process store or an asynchronous database. */
export type Awaitable<T> = T | Promise<T>

/** Authentication operations consumed by the Gateway HTTP server. */
export interface GatewayAuthService {
  login(
    username: string,
    password: string,
    ip: string,
    userAgent: string,
  ): Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'>
  validate(token: string): Awaitable<UserRow | null>
  revoke(token: string): Awaitable<void>
}

/** User administration operations consumed by the Gateway. */
export interface GatewayUserService {
  count(): Awaitable<number>
  create(input: {
    username: string
    password: string
    role?: 'admin' | 'user'
    displayName?: string
  }): Promise<UserRow>
  list(): Awaitable<Array<UserRow & { port: number; instanceState: string }>>
  getById(id: number): Awaitable<UserRow | null>
  getByUsername(username: string): Awaitable<UserRow | null>
  setStatus(id: number, status: 'active' | 'disabled'): Awaitable<void>
  setRole(id: number, role: 'admin' | 'user'): Awaitable<void>
  setDisplayName(id: number, name: string): Awaitable<void>
  remove(id: number): Awaitable<boolean>
  resetPassword(id: number, newPassword: string): Promise<void>
  changeOwnPassword(id: number, newPassword: string): Promise<void>
}

/** Project and effective-directory-grant operations consumed by the Gateway. */
export interface GatewayProjectService {
  /** `path` is omitted for managed creation below the configured project root. */
  create(input: { name: string; path?: string; createdBy: number }): Awaitable<ProjectRow>
  /** Allocate a new project directory below the configured managed root. */
  createManaged?(input: { name: string; ownerUserId: number; createdBy?: number }): Awaitable<ProjectRow>
  list(): Awaitable<ProjectRow[]>
  getById(id: number): Awaitable<ProjectDetail | null>
  rename(id: number, name: string): Awaitable<void>
  remove(id: number): Awaitable<number[]>
  setMember(projectId: number, userId: number, mode: GrantMode): Awaitable<void>
  removeMember(projectId: number, userId: number): Awaitable<void>
  effectiveGrants(userId: number): Awaitable<EffectiveGrant[]>
  createInvitation?(input: {
    projectId: number
    inviteeUserId: number
    inviterUserId: number
    mode: GrantMode
  }): Awaitable<ProjectInvitation>
  listInvitations?(userId: number, projectId?: number): Awaitable<ProjectInvitation[]>
  acceptInvitation?(invitationId: string, userId: number): Awaitable<void>
}

/** Project membership and shared-conversation authorization operations. */
export interface GatewayCollaborationService {
  projectsForUser(userId: number): Awaitable<ProjectScopeView[]>
  projectForUser(projectId: number, userId: number): Awaitable<ProjectAuthorityView | null>
  access(userId: number, sessionId: string, action: CollaborationAction): Awaitable<ConversationAccess>
  listConversations(userId: number, projectId: number): Awaitable<ConversationCollaborationView[]>
  readableSessionIds(userId: number, projectId: number, sessionIds: readonly string[]): Awaitable<string[]>
  setVisibility(userId: number, sessionId: string, visibility: 'project' | 'private'): Awaitable<void>
  claimInteraction(
    userId: number,
    sessionId: string,
    kind: 'approval' | 'question',
    interactionId: string,
    outcome: unknown,
  ): Awaitable<boolean>
}

/** Audit operations consumed by request handlers and policy application. */
export interface GatewayAuditService {
  write(entry: {
    userId?: number
    action: string
    methodPath?: string
    status?: number
    ip?: string
    detail?: string
  }): Awaitable<void>
  query(filter?: {
    userId?: number
    action?: string
    actionPrefix?: string
    fromMs?: number
    toMs?: number
    offset?: number
    limit?: number
  }): Awaitable<AuditRow[]>
}

/** Model authorization, pricing, quota, and usage operations consumed by the Gateway. */
export interface GatewayModelGovernanceService {
  listModels(): Awaitable<ModelRow[]>
  upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & {
    adminAllowed?: boolean
    userAllowed?: boolean
  }): Awaitable<void>
  setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): Awaitable<void>
  userOverrides(userId: number): Awaitable<Array<{ provider: string; model: string; allowed: boolean }>>
  policyFor(user: UserRow): Awaitable<{
    version: number
    defaultAllowed: boolean
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }>
  policyForProject(projectId: number): Awaitable<{
    version: number
    defaultAllowed: false
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }>
  issueIntakeToken(subject: ModelUsageSubject): Awaitable<string>
  subjectForIntakeToken(token: string): Awaitable<ModelUsageSubject | null>
  setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): Awaitable<void>
  ingest(subject: ModelUsageSubject, event: UsageEvent): Awaitable<{ inserted: boolean; alerts: number }>
  summary(subject: ModelUsageSubject, month?: string): Awaitable<UsageSummary>
}

/** Instance lifecycle operations used by HTTP, proxy, and policy handlers. */
export type GatewayInstanceService = Pick<
  InstanceManager,
  'beforeStart' | 'portOf' | 'stateOf' | 'generationOf' | 'isLive' | 'touch' | 'wsRef' | 'ensureRunning' | 'reapIdle'
  | 'stop' | 'stopAll' | 'withStopped'
>
