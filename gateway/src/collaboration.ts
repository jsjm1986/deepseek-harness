export type CollaborationAction = 'read' | 'write' | 'manage' | 'approve'

export interface ProjectMembershipView {
  projectId: number
  name: string
  path: string
  mode: 'ro' | 'rw'
}

export interface ConversationParticipantView {
  userId: number
  displayName: string
  contributionCount: number
  lastContributedAt: number
}

export interface ConversationCollaborationView {
  sessionId: string
  creatorUserId: number
  creatorDisplayName: string
  visibility: 'project' | 'private'
  participants: ConversationParticipantView[]
  updatedAt: number
}

export interface ConversationAccess {
  sessionId: string
  rootSessionId: string
  projectId: number
  visibility: 'project' | 'private'
  creatorUserId: number
  mode: 'ro' | 'rw'
  canRead: true
  canWrite: boolean
  canManage: boolean
}

/** Stable collaboration denial used by HTTP and runtime transports. */
export class CollaborationDeniedError extends Error {
  constructor(readonly code: 'not-member' | 'conversation-not-found' | 'forbidden' | 'visibility-locked') {
    super(code)
    this.name = 'CollaborationDeniedError'
  }
}
