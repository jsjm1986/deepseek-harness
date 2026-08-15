import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'

/** Browser-owned options for creating one root session through the Host API. */
export interface SessionCreateOptions {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  /** Project-conversation visibility supplied by an optional collaboration plugin. */
  readonly visibility?: 'project' | 'private'
}

/** One existing blank session offered against fully prepared root-create options. */
export interface SessionBlankReuseRequest {
  readonly sessionId: SessionId
  readonly options: SessionCreateOptions
}
