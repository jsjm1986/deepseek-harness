import type { PoolClient } from 'pg'
import {
  CollaborationDeniedError,
  type CollaborationAction,
  type ConversationAccess,
  type ConversationCollaborationView,
  type ProjectAuthorityView,
  type ProjectScopeView,
} from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import { publicNumber } from './runtime-context.ts'
import { transaction } from './database.ts'
import type { ConversationVisibility } from './conversation-repository.ts'

interface AccessRow {
  session_id: string
  root_session_id: string
  project_id: string
  project_public_id: string
  visibility: Exclude<ConversationVisibility, 'personal'>
  creator_user_id: string
  creator_public_id: string
  access_mode: 'ro' | 'rw' | null
  administrator: boolean
}

interface LockedAuthority {
  userId: string
  accessMode: 'ro' | 'rw'
  administrator: boolean
}

/** PostgreSQL authority for project membership and shared-conversation access. */
export class PostgresCollaborationService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  private async projectAuthorities(userId: number): Promise<ProjectAuthorityView[]> {
    const result = await this.context.pool.query<{
      public_id: string
      name: string
      path: string
      access_mode: 'ro' | 'rw'
      administrator: boolean
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,
      CASE WHEN membership.role='admin' THEN 'rw'::text
        WHEN membership.role='member' THEN member.access_mode ELSE NULL END access_mode,
      membership.role='admin' administrator
      FROM harness.users actor
      JOIN harness.memberships membership ON membership.organization_id=actor.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      JOIN harness.projects p ON p.organization_id=actor.organization_id
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$3 AND pm.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id
        AND member.project_id=p.id AND member.user_id=actor.id
      WHERE actor.organization_id=$1 AND actor.public_id=$2 AND actor.status='active'
        AND p.status='active' AND (membership.role='admin' OR member.user_id IS NOT NULL)
      ORDER BY p.name,p.public_id`,
    [this.context.organizationId, userId, this.context.nodeId])
    return result.rows.map(row => ({
      projectId: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
      mode: row.access_mode,
      administrator: row.administrator,
    }))
  }

  async projectsForUser(userId: number): Promise<ProjectScopeView[]> {
    return (await this.projectAuthorities(userId)).map(({ administrator: _, ...project }) => project)
  }

  async projectForUser(projectId: number, userId: number): Promise<ProjectAuthorityView | null> {
    return (await this.projectAuthorities(userId)).find(project => project.projectId === projectId) ?? null
  }

  async internalProject(projectId: number): Promise<{
    id: string
    publicId: number
    name: string
    path: string
  } | null> {
    const result = await this.context.pool.query<{
      id: string
      public_id: string
      name: string
      path: string
    }>(`SELECT p.id,p.public_id::text,p.name::text,pm.local_path path
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      WHERE p.organization_id=$1 AND p.public_id=$3 AND p.status='active'`,
    [this.context.organizationId, this.context.nodeId, projectId])
    const row = result.rows[0]
    return row === undefined ? null : {
      id: row.id,
      publicId: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
    }
  }

  private async accessRow(queryable: PoolClient | PostgresRuntimeContext['pool'], userId: number, sessionId: string): Promise<AccessRow | null> {
    const result = await queryable.query<AccessRow>(`SELECT c.id session_id,r.id root_session_id,
      p.id project_id,p.public_id::text project_public_id,r.visibility,r.creator_user_id,
      creator.public_id::text creator_public_id,
      CASE WHEN membership.role='admin' THEN 'rw'::text
        WHEN membership.role='member' THEN member.access_mode ELSE NULL END access_mode,
      COALESCE(membership.role='admin',false) administrator
      FROM harness.conversation_sessions c
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id AND p.status='active'
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      LEFT JOIN harness.users actor ON actor.organization_id=r.organization_id AND actor.public_id=$2
        AND actor.status='active'
      LEFT JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      WHERE c.organization_id=$1 AND c.id=$3 AND c.status<>'deleted' AND r.status<>'deleted'`,
    [this.context.organizationId, userId, sessionId])
    return result.rows[0] ?? null
  }

  private async lockedAccessRow(
    client: PoolClient,
    userId: number,
    sessionId: string,
    rootLock: 'share' | 'update',
  ): Promise<{ access: AccessRow; authority: LockedAuthority | null } | null> {
    const lock = rootLock === 'update' ? 'FOR UPDATE OF r' : 'FOR SHARE OF r'
    const result = await client.query<AccessRow>(`SELECT c.id session_id,r.id root_session_id,
      p.id project_id,p.public_id::text project_public_id,r.visibility,r.creator_user_id,
      creator.public_id::text creator_public_id,NULL::text access_mode,false administrator
      FROM harness.conversation_sessions c
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id AND p.status='active'
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.status<>'deleted' AND r.status<>'deleted'
      ${lock}`, [this.context.organizationId, sessionId])
    const access = result.rows[0]
    if (access === undefined) return null
    const actor = await client.query<{ user_id: string; organization_role: 'admin' | 'member' }>(`SELECT
      actor.id user_id,membership.role organization_role
      FROM harness.users actor
      JOIN harness.memberships membership ON membership.user_id=actor.id
        AND membership.organization_id=actor.organization_id AND membership.status='active'
      WHERE actor.organization_id=$1 AND actor.public_id=$2 AND actor.status='active'
      FOR SHARE OF actor,membership`, [this.context.organizationId, userId])
    const current = actor.rows[0]
    if (current === undefined) return { access, authority: null }
    if (current.organization_role === 'admin') {
      return {
        access: { ...access, access_mode: 'rw', administrator: true },
        authority: { userId: current.user_id, accessMode: 'rw', administrator: true },
      }
    }
    const membership = await client.query<{ user_id: string; access_mode: 'ro' | 'rw' }>(`SELECT
      member.user_id,member.access_mode
      FROM harness.project_members member
      WHERE member.organization_id=$1 AND member.project_id=$2 AND member.user_id=$3
      FOR SHARE OF member`, [this.context.organizationId, access.project_id, current.user_id])
    const member = membership.rows[0]
    return {
      access: { ...access, access_mode: member?.access_mode ?? null },
      authority: member === undefined ? null : {
        userId: member.user_id,
        accessMode: member.access_mode,
        administrator: false,
      },
    }
  }

  async access(userId: number, sessionId: string, action: CollaborationAction): Promise<ConversationAccess> {
    const row = await this.accessRow(this.context.pool, userId, sessionId)
    if (row === null) throw new CollaborationDeniedError('conversation-not-found')
    if (row.access_mode === null) throw new CollaborationDeniedError('not-member')
    const creatorUserId = publicNumber(row.creator_public_id, 'user')
    const isCreator = creatorUserId === userId
    const canRead = row.administrator || row.visibility === 'project' || isCreator
    const canWrite = row.access_mode === 'rw' && canRead
    const canManage = row.access_mode === 'rw' && (row.administrator || isCreator)
    if (!canRead || (action === 'write' && !canWrite) || (action === 'approve' && !canWrite)
      || (action === 'manage' && !canManage)) {
      throw new CollaborationDeniedError('forbidden')
    }
    return {
      sessionId: row.session_id,
      rootSessionId: row.root_session_id,
      projectId: publicNumber(row.project_public_id, 'project'),
      visibility: row.visibility,
      creatorUserId,
      mode: row.access_mode,
      canRead: true,
      canWrite,
      canManage,
    }
  }

  async listConversations(userId: number, projectId: number): Promise<ConversationCollaborationView[]> {
    if (await this.projectForUser(projectId, userId) === null) throw new CollaborationDeniedError('not-member')
    const result = await this.context.pool.query<{
      session_id: string
      creator_public_id: string
      creator_display_name: string
      visibility: Exclude<ConversationVisibility, 'personal'>
      updated_at_ms: string
      participants: Array<{
        userId: string
        displayName: string
        contributionCount: string
        lastContributedAt: string
      }> | null
    }>(`SELECT r.id session_id,creator.public_id::text creator_public_id,
      creator.display_name creator_display_name,r.visibility,
      (extract(epoch FROM r.updated_at)*1000)::bigint::text updated_at_ms,
      COALESCE(jsonb_agg(jsonb_build_object(
        'userId',participant.public_id::text,
        'displayName',participant.display_name,
        'contributionCount',cp.contribution_count::text,
        'lastContributedAt',(extract(epoch FROM cp.last_contributed_at)*1000)::bigint::text
      ) ORDER BY cp.last_contributed_at DESC) FILTER (WHERE cp.user_id IS NOT NULL),'[]'::jsonb) participants
      FROM harness.conversation_sessions r
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$3 AND actor.status='active'
      JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      LEFT JOIN harness.conversation_participants cp ON cp.conversation_id=r.id
        AND cp.organization_id=r.organization_id
      LEFT JOIN harness.users participant ON participant.id=cp.user_id
        AND participant.organization_id=cp.organization_id
      WHERE r.organization_id=$1 AND p.public_id=$2 AND r.id=r.root_session_id
        AND r.status<>'deleted' AND (membership.role='admin' OR member.user_id IS NOT NULL)
        AND (membership.role='admin' OR r.visibility='project' OR creator.id=actor.id)
      GROUP BY r.id,creator.public_id,creator.display_name
      ORDER BY r.updated_at DESC,r.id`, [this.context.organizationId, projectId, userId])
    return result.rows.map(row => ({
      sessionId: row.session_id,
      creatorUserId: publicNumber(row.creator_public_id, 'user'),
      creatorDisplayName: row.creator_display_name,
      visibility: row.visibility,
      participants: (row.participants ?? []).map(participant => ({
        userId: publicNumber(participant.userId, 'user'),
        displayName: participant.displayName,
        contributionCount: Number(participant.contributionCount),
        lastContributedAt: Number(participant.lastContributedAt),
      })),
      updatedAt: Number(row.updated_at_ms),
    }))
  }

  async readableSessionIds(userId: number, projectId: number, sessionIds: readonly string[]): Promise<string[]> {
    if (sessionIds.length === 0) return []
    const result = await this.context.pool.query<{ session_id: string }>(`SELECT c.id session_id
      FROM unnest($4::text[]) requested(session_id)
      JOIN harness.conversation_sessions c ON c.id=requested.session_id
        AND c.organization_id=$1 AND c.status<>'deleted'
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id
        AND r.organization_id=c.organization_id AND r.status<>'deleted'
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
        AND p.public_id=$3 AND p.status='active'
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$2 AND actor.status='active'
      JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      WHERE membership.role='admin' OR (member.user_id IS NOT NULL
        AND (r.visibility='project' OR r.creator_user_id=actor.id))`,
    [this.context.organizationId, userId, projectId, sessionIds])
    return result.rows.map(row => row.session_id)
  }

  async setVisibility(userId: number, sessionId: string, visibility: 'project' | 'private'): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const locked = await this.lockedAccessRow(client, userId, sessionId, 'update')
      if (locked === null) throw new CollaborationDeniedError('conversation-not-found')
      const creatorUserId = publicNumber(locked.access.creator_public_id, 'user')
      if (locked.authority?.accessMode !== 'rw'
        || (!locked.authority.administrator && creatorUserId !== userId)) {
        throw new CollaborationDeniedError('forbidden')
      }
      if (locked.access.visibility === visibility) return
      if (visibility === 'private') {
        const others = await client.query<{ present: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM harness.conversation_participants
          WHERE organization_id=$1 AND conversation_id=$2 AND user_id<>$3
        ) present`, [this.context.organizationId, locked.access.root_session_id, locked.access.creator_user_id])
        if (others.rows[0]?.present === true) throw new CollaborationDeniedError('visibility-locked')
      }
      await client.query(`UPDATE harness.conversation_sessions SET visibility=$3,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND root_session_id=$2`,
      [this.context.organizationId, locked.access.root_session_id, visibility])
    })
  }

  async claimInteraction(
    userId: number,
    sessionId: string,
    kind: 'approval' | 'question',
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean> {
    return transaction(this.context.pool, async (client) => {
      const locked = await this.lockedAccessRow(client, userId, sessionId, 'share')
      if (locked === null) throw new CollaborationDeniedError('conversation-not-found')
      const creatorUserId = publicNumber(locked.access.creator_public_id, 'user')
      if (locked.authority?.accessMode !== 'rw'
        || (!locked.authority.administrator
          && locked.access.visibility === 'private' && creatorUserId !== userId)) {
        throw new CollaborationDeniedError('forbidden')
      }
      const responderId = locked.authority.userId
      const inserted = await client.query(`INSERT INTO harness.conversation_interaction_responses(
        organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(organization_id,interaction_kind,interaction_id) DO NOTHING`,
      [this.context.organizationId, kind, interactionId, locked.access.root_session_id, responderId, JSON.stringify(outcome)])
      return inserted.rowCount === 1
    })
  }

}
