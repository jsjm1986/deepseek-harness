import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './database.ts'

export type ConversationVisibility = 'personal' | 'project' | 'private'

export interface ConversationHeader {
  id: string
  organizationId: string
  creatorUserId?: string
  projectId?: string
  parentSessionId?: string
  rootSessionId?: string
  visibility?: ConversationVisibility
  sessionFormatVersion: number
  createdAt: number
  cwd?: string
  seedLength?: number
  origin?: string
  delegationDepth?: number
  agentPreset?: string
  title?: string
}

export interface StoredConversation {
  header: ConversationHeader
  events: ConversationEvent[]
  revision: string
}

export interface ConversationEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
  ignorable?: true
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function eventText(event: ConversationEvent): { role: 'user' | 'assistant' | 'tool'; content: string } | undefined {
  if (event.type === 'user/message') {
    const data = event.data as { content?: unknown }
    return { role: 'user', content: messageText(data) }
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } }
    return { role: 'assistant', content: messageText(data.message) }
  }
  if (event.type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown } }
    return { role: 'tool', content: messageText(data.message) }
  }
  return undefined
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as { type?: unknown; text?: unknown; content?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') return [value.text]
    if (value.type === 'tool-result') {
      const nested = contentText(value.content)
      return nested === '' ? [] : [nested]
    }
    return []
  }).join('\n')
}

function messageText(message: { content?: unknown } | undefined): string {
  return contentText(message?.content)
}

function participantUserId(event: ConversationEvent): number | undefined {
  if (event.type !== 'user/message' || typeof event.data !== 'object' || event.data === null) return undefined
  const source = (event.data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const participant = (source as { participant?: unknown }).participant
  if (typeof participant !== 'object' || participant === null) return undefined
  const userId = (participant as { userId?: unknown }).userId
  return typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0 ? userId : undefined
}

interface StoredHeaderRow {
  id: string
  organization_id: string
  creator_user_id: string
  project_id: string | null
  parent_session_id: string | null
  root_session_id: string
  visibility: ConversationVisibility
  session_format_version: number
  created_at_ms: string
  cwd: string | null
  seed_length: string | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
  title: string | null
  version: string
  next_seq: string
}

interface ResolvedConversationHeader {
  id: string
  organizationId: string
  creatorUserId: string
  projectId: string | null
  parentSessionId: string | null
  rootSessionId: string
  visibility: ConversationVisibility
  sessionFormatVersion: number
  createdAt: number
  cwd: string | null
  seedLength: number | null
  origin: string | null
  delegationDepth: number | null
  agentPreset: string | null
  title: string | null
}

function headerFromRow(row: StoredHeaderRow): ConversationHeader {
  return {
    id: row.id,
    organizationId: row.organization_id,
    creatorUserId: row.creator_user_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    rootSessionId: row.root_session_id,
    visibility: row.visibility,
    sessionFormatVersion: row.session_format_version,
    createdAt: Number(row.created_at_ms),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.seed_length === null ? {} : { seedLength: Number(row.seed_length) }),
    ...(row.origin === null ? {} : { origin: row.origin }),
    ...(row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth }),
    ...(row.agent_preset === null ? {} : { agentPreset: row.agent_preset }),
    ...(row.title === null ? {} : { title: row.title }),
  }
}

const HEADER_COLUMNS = `id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,visibility,
  session_format_version,(extract(epoch FROM created_at)*1000)::bigint::text created_at_ms,cwd,
  seed_length::text,origin,delegation_depth,agent_preset,title,version::text,next_seq::text`

export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  private async assertProjectCreatorMembership(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    creatorUserId: string,
  ): Promise<void> {
    const membership = await client.query<{ id: string }>(`SELECT u.id
      FROM harness.users u
      JOIN harness.project_members m ON m.user_id=u.id AND m.organization_id=u.organization_id
      JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id
      WHERE u.organization_id=$1 AND u.id=$2 AND u.status='active'
        AND p.id=$3 AND p.status='active' AND m.access_mode='rw'
      FOR SHARE OF u,m,p`, [organizationId, creatorUserId, projectId])
    if (membership.rows[0] === undefined) {
      throw new Error(`conversation creator ${creatorUserId} is not an active rw project member`)
    }
  }

  private async resolveHeader(client: PoolClient, header: ConversationHeader): Promise<ResolvedConversationHeader> {
    let projectId = header.projectId ?? null
    let rootSessionId = header.rootSessionId ?? header.id
    let visibility = header.visibility ?? (projectId === null ? 'personal' : 'project')
    let creatorUserId = header.creatorUserId
    if (header.parentSessionId !== undefined) {
      const parent = await client.query<{
        organization_id: string
        project_id: string | null
        root_session_id: string
        visibility: ConversationVisibility
        creator_user_id: string
      }>(`SELECT p.organization_id,p.project_id,p.root_session_id,r.visibility,r.creator_user_id
        FROM harness.conversation_sessions p
        JOIN harness.conversation_sessions r ON r.id=p.root_session_id AND r.organization_id=p.organization_id
        WHERE p.id=$1 AND p.status<>'deleted' AND r.status<>'deleted'`, [header.parentSessionId])
      const row = parent.rows[0]
      if (row === undefined) throw new Error(`unknown parent conversation session ${header.parentSessionId}`)
      if (row.organization_id !== header.organizationId) {
        throw new Error(`parent conversation session ${header.parentSessionId} belongs to another organization`)
      }
      if (projectId !== null && projectId !== row.project_id) {
        throw new Error(`parent conversation session ${header.parentSessionId} belongs to another project`)
      }
      const root = await client.query<{
        project_id: string | null
        visibility: ConversationVisibility
        creator_user_id: string
      }>(`SELECT project_id,visibility,creator_user_id FROM harness.conversation_sessions
        WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR UPDATE`,
      [row.root_session_id, header.organizationId])
      const lockedRoot = root.rows[0]
      if (lockedRoot === undefined) throw new Error(`unknown root conversation session ${row.root_session_id}`)
      const lockedParent = await client.query(`SELECT id FROM harness.conversation_sessions
        WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR SHARE`,
      [header.parentSessionId, header.organizationId])
      if (lockedParent.rows[0] === undefined) {
        throw new Error(`unknown parent conversation session ${header.parentSessionId}`)
      }
      projectId = lockedRoot.project_id
      rootSessionId = row.root_session_id
      visibility = lockedRoot.visibility
      creatorUserId = lockedRoot.creator_user_id
    } else if (rootSessionId !== header.id) {
      throw new Error(`root conversation session ${header.id} cannot name another root`)
    }
    if (creatorUserId === undefined) throw new Error(`conversation session ${header.id} has no creator`)
    if ((projectId === null && visibility !== 'personal')
      || (projectId !== null && visibility !== 'project' && visibility !== 'private')) {
      throw new Error(`conversation session ${header.id} has invalid scope visibility`)
    }
    if (header.parentSessionId === undefined && projectId !== null) {
      await this.assertProjectCreatorMembership(client, header.organizationId, projectId, creatorUserId)
    }
    return {
      id: header.id,
      organizationId: header.organizationId,
      creatorUserId,
      projectId,
      parentSessionId: header.parentSessionId ?? null,
      rootSessionId,
      visibility,
      sessionFormatVersion: header.sessionFormatVersion,
      createdAt: header.createdAt,
      cwd: header.cwd ?? null,
      seedLength: header.seedLength ?? null,
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? null,
      agentPreset: header.agentPreset ?? null,
      title: header.title ?? null,
    }
  }

  private assertSameHeader(row: StoredHeaderRow, header: ResolvedConversationHeader): void {
    const same = row.id === header.id
      && row.organization_id === header.organizationId
      && row.creator_user_id === header.creatorUserId
      && row.project_id === header.projectId
      && row.parent_session_id === header.parentSessionId
      && row.root_session_id === header.rootSessionId
      && row.visibility === header.visibility
      && row.session_format_version === header.sessionFormatVersion
      && Number(row.created_at_ms) === header.createdAt
      && row.cwd === header.cwd
      && (row.seed_length === null ? null : Number(row.seed_length)) === header.seedLength
      && row.origin === header.origin
      && row.delegation_depth === header.delegationDepth
      && row.agent_preset === header.agentPreset
      && row.title === header.title
    if (!same) throw new Error(`conversation session ${header.id} already exists with different metadata`)
  }

  private async ensureMaterialized(client: PoolClient, input: ConversationHeader): Promise<StoredHeaderRow> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conversation:${input.id}`])
    const header = await this.resolveHeader(client, input)
    const existing = await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions WHERE id=$1 FOR UPDATE`, [header.id])
    const row = existing.rows[0]
    if (row !== undefined) {
      this.assertSameHeader(row, header)
      return row
    }
    await client.query(`INSERT INTO harness.conversation_sessions(
      id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,visibility,
      session_format_version,created_at,updated_at,cwd,seed_length,origin,delegation_depth,agent_preset,title
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),to_timestamp($9/1000.0),$10,$11,$12,$13,$14,$15)`, [
      header.id, header.organizationId, header.creatorUserId, header.projectId,
      header.parentSessionId, header.rootSessionId, header.visibility, header.sessionFormatVersion, header.createdAt,
      header.cwd, header.seedLength, header.origin, header.delegationDepth, header.agentPreset, header.title,
    ])
    const inserted = await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions WHERE id=$1 FOR UPDATE`, [header.id])
    const insertedRow = inserted.rows[0]
    if (insertedRow === undefined) throw new Error(`conversation session ${header.id} was not materialized`)
    return insertedRow
  }

  /** Create one session idempotently when its complete metadata is unchanged. */
  async create(header: ConversationHeader): Promise<void> {
    await transaction(this.pool, async client => { await this.ensureMaterialized(client, header) })
  }

  /** Append one contiguous batch. Retrying the same batch id and bytes is idempotent. */
  async append(
    sessionId: string,
    batchId: string,
    events: readonly ConversationEvent[],
    header?: ConversationHeader,
  ): Promise<'inserted' | 'duplicate'> {
    if (events.length === 0) return 'inserted'
    for (let index = 0; index < events.length; index++) {
      if (events[index]!.seq !== events[0]!.seq + index) throw new Error('conversation event batch must be contiguous')
    }
    const batchJson = serialized(events)
    const batchChecksum = digest(batchJson)
    return transaction(this.pool, async (client) => {
      // Batch ids are globally idempotent. Serialize equal ids even when a bad
      // caller reuses one across sessions; hash collisions only reduce concurrency.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batchId])
      if (header !== undefined && header.id !== sessionId) throw new Error('conversation append header id mismatch')
      // The first append atomically materializes its header. Later appends lock
      // the existing row before reading the idempotency marker and cursor.
      let sessionRow: StoredHeaderRow | undefined
      if (header === undefined) {
        const lineage = await client.query<{ organization_id: string; root_session_id: string }>(`SELECT
          c.organization_id,c.root_session_id FROM harness.conversation_sessions c
          JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id
          WHERE c.id=$1 AND c.status<>'deleted' AND r.status<>'deleted'`, [sessionId])
        const scope = lineage.rows[0]
        if (scope !== undefined) {
          const root = await client.query(`SELECT id FROM harness.conversation_sessions
            WHERE id=$1 AND organization_id=$2 AND status<>'deleted' FOR UPDATE`,
          [scope.root_session_id, scope.organization_id])
          if (root.rows[0] !== undefined) {
            sessionRow = (await client.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
              FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted' FOR UPDATE`, [sessionId])).rows[0]
          }
        }
      } else {
        sessionRow = await this.ensureMaterialized(client, header)
      }
      if (sessionRow === undefined) throw new Error(`unknown conversation session ${sessionId}`)
      const duplicate = await client.query<{
        session_id: string; first_seq: string; event_count: number; checksum: Buffer
      }>('SELECT session_id,first_seq,event_count,checksum FROM harness.conversation_append_batches WHERE batch_id=$1', [batchId])
      if (duplicate.rows[0] !== undefined) {
        const row = duplicate.rows[0]
        if (row.session_id !== sessionId || Number(row.first_seq) !== events[0]!.seq
          || row.event_count !== events.length || !row.checksum.equals(batchChecksum)) {
          throw new Error('conversation batch id reused with different content')
        }
        return 'duplicate'
      }
      const expected = Number(sessionRow.next_seq)
      if (events[0]!.seq !== expected) throw new Error(`conversation append expected seq ${String(expected)}, got ${String(events[0]!.seq)}`)

      let bytes = 0
      const contributions = new Map<number, { count: number; first: number; last: number }>()
      for (const event of events) {
        const json = serialized(event)
        const payloadBytes = Buffer.byteLength(json)
        bytes += payloadBytes
        await client.query(`INSERT INTO harness.conversation_events(
          session_id,seq,event_type,occurred_at,event,payload_bytes
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5::json,$6)`,
        [sessionId, event.seq, event.type, event.time, json, payloadBytes])
        const search = eventText(event)
        if (search !== undefined && search.content !== '') {
          await client.query(`INSERT INTO harness.conversation_search(session_id,event_seq,role,content,occurred_at)
            VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))`,
          [sessionId, event.seq, search.role, search.content, event.time])
        }
        const contributor = participantUserId(event)
        if (contributor !== undefined) {
          const current = contributions.get(contributor)
          contributions.set(contributor, current === undefined
            ? { count: 1, first: event.time, last: event.time }
            : { count: current.count + 1, first: Math.min(current.first, event.time), last: Math.max(current.last, event.time) })
        }
      }
      for (const [publicUserId, contribution] of contributions) {
        const contributor = sessionRow.project_id === null
          ? await client.query<{ id: string }>(`SELECT u.id FROM harness.users u
              WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active'
              FOR SHARE OF u`, [sessionRow.organization_id, publicUserId])
          : await client.query<{ id: string }>(`SELECT u.id FROM harness.users u
              JOIN harness.project_members m ON m.user_id=u.id AND m.organization_id=u.organization_id
              WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active'
                AND m.project_id=$3 AND m.access_mode='rw'
              FOR SHARE OF u,m`, [sessionRow.organization_id, publicUserId, sessionRow.project_id])
        const contributorId = contributor.rows[0]?.id
        if (contributorId === undefined) {
          throw new Error(`conversation contributor ${String(publicUserId)} is not an active rw project member`)
        }
        if (sessionRow.visibility === 'private' && contributorId !== sessionRow.creator_user_id) {
          throw new Error(`private conversation ${sessionRow.root_session_id} rejects another contributor`)
        }
        await client.query(`INSERT INTO harness.conversation_participants(
          organization_id,conversation_id,user_id,first_contributed_at,last_contributed_at,contribution_count
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6)
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET
          first_contributed_at=LEAST(harness.conversation_participants.first_contributed_at,excluded.first_contributed_at),
          last_contributed_at=GREATEST(harness.conversation_participants.last_contributed_at,excluded.last_contributed_at),
          contribution_count=harness.conversation_participants.contribution_count+excluded.contribution_count`,
        [sessionRow.organization_id, sessionRow.root_session_id, contributorId,
          contribution.first, contribution.last, contribution.count])
      }
      await client.query(`UPDATE harness.conversation_sessions SET
        next_seq=$2,event_count=event_count+$3,total_payload_bytes=total_payload_bytes+$4,
        updated_at=now(),version=version+1 WHERE id=$1`,
      [sessionId, events.at(-1)!.seq + 1, events.length, bytes])
      if (sessionRow.root_session_id !== sessionId) {
        await client.query('UPDATE harness.conversation_sessions SET updated_at=now() WHERE id=$1',
          [sessionRow.root_session_id])
      }
      await client.query(`INSERT INTO harness.conversation_append_batches(batch_id,session_id,first_seq,event_count,checksum)
        VALUES($1,$2,$3,$4,$5)`, [batchId, sessionId, events[0]!.seq, events.length, batchChecksum])
      return 'inserted'
    })
  }

  async readFrom(sessionId: string, fromSeq: number): Promise<ConversationEvent[]> {
    const result = await this.pool.query<{ event: ConversationEvent }>(
      'SELECT event FROM harness.conversation_events WHERE session_id=$1 AND seq >= $2 ORDER BY seq',
      [sessionId, fromSeq],
    )
    return result.rows.map(row => row.event)
  }

  async load(sessionId: string): Promise<StoredConversation | undefined> {
    const header = await this.pool.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId])
    const row = header.rows[0]
    if (row === undefined) return undefined
    return {
      header: headerFromRow(row),
      events: await this.readFrom(sessionId, 0),
      revision: `${row.version}:${row.next_seq}`,
    }
  }

  async revision(sessionId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ version: string; next_seq: string }>(`SELECT version::text,next_seq::text
      FROM harness.conversation_sessions WHERE id=$1 AND status<>'deleted'`, [sessionId])
    const row = result.rows[0]
    return row === undefined ? undefined : `${row.version}:${row.next_seq}`
  }

  async list(organizationId: string, projectId?: string): Promise<ConversationHeader[]> {
    const result = await this.pool.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions
      WHERE organization_id=$1 AND status<>'deleted'
        AND (($2::uuid IS NULL AND project_id IS NULL) OR project_id=$2)
      ORDER BY updated_at DESC,id`, [organizationId, projectId ?? null])
    return result.rows.map(headerFromRow)
  }

  async listScoped(scope: {
    organizationId: string
    projectId?: string
    creatorUserId?: string
  }): Promise<Array<{ header: ConversationHeader; revision: string }>> {
    const result = await this.pool.query<StoredHeaderRow>(`SELECT ${HEADER_COLUMNS}
      FROM harness.conversation_sessions
      WHERE organization_id=$1 AND status<>'deleted'
        AND (($2::uuid IS NULL AND project_id IS NULL) OR project_id=$2)
        AND ($3::uuid IS NULL OR creator_user_id=$3)
      ORDER BY updated_at DESC,id`, [scope.organizationId, scope.projectId ?? null, scope.creatorUserId ?? null])
    return result.rows.map(row => ({ header: headerFromRow(row), revision: `${row.version}:${row.next_seq}` }))
  }

  async search(organizationId: string, query: string, limit = 50): Promise<Array<{ sessionId: string; seq: number; content: string }>> {
    const result = await this.pool.query<{ session_id: string; event_seq: string; content: string }>(`SELECT s.session_id,s.event_seq,s.content
      FROM harness.conversation_search s
      JOIN harness.conversation_sessions c ON c.id=s.session_id
      WHERE c.organization_id=$1 AND s.content % $2
      ORDER BY similarity(s.content,$2) DESC,s.occurred_at DESC LIMIT $3`, [organizationId, query, limit])
    return result.rows.map(row => ({ sessionId: row.session_id, seq: Number(row.event_seq), content: row.content }))
  }
}
