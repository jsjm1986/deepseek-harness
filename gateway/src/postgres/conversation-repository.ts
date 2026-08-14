import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { transaction } from './database.ts'

export interface ConversationHeader {
  id: string
  organizationId: string
  ownerUserId: string
  projectId?: string
  parentSessionId?: string
  sessionFormatVersion: number
  createdAt: number
  cwd?: string
  seedLength?: number
  origin?: string
  delegationDepth?: number
  agentPreset?: string
  title?: string
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

export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  async create(header: ConversationHeader): Promise<void> {
    await this.pool.query(`INSERT INTO harness.conversation_sessions(
      id,organization_id,owner_user_id,project_id,parent_session_id,session_format_version,
      created_at,updated_at,cwd,seed_length,origin,delegation_depth,agent_preset,title
    ) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($7/1000.0),$8,$9,$10,$11,$12,$13)`, [
      header.id, header.organizationId, header.ownerUserId, header.projectId ?? null,
      header.parentSessionId ?? null, header.sessionFormatVersion, header.createdAt,
      header.cwd ?? null, header.seedLength ?? null, header.origin ?? null,
      header.delegationDepth ?? null, header.agentPreset ?? null, header.title ?? null,
    ])
  }

  /** Append one contiguous batch. Retrying the same batch id and bytes is idempotent. */
  async append(sessionId: string, batchId: string, events: readonly ConversationEvent[]): Promise<'inserted' | 'duplicate'> {
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
      // Serialize every append for one session before checking the batch marker.
      // Without this lock, two concurrent retries can both miss the marker and
      // race into event insertion instead of returning one idempotent success.
      const session = await client.query<{ next_seq: string }>(
        'SELECT next_seq FROM harness.conversation_sessions WHERE id=$1 FOR UPDATE', [sessionId],
      )
      if (session.rows[0] === undefined) throw new Error(`unknown conversation session ${sessionId}`)
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
      const expected = Number(session.rows[0].next_seq)
      if (events[0]!.seq !== expected) throw new Error(`conversation append expected seq ${String(expected)}, got ${String(events[0]!.seq)}`)

      let bytes = 0
      for (const event of events) {
        const json = serialized(event)
        const payloadBytes = Buffer.byteLength(json)
        bytes += payloadBytes
        await client.query(`INSERT INTO harness.conversation_events(
          session_id,seq,event_type,occurred_at,event,payload_bytes
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5::jsonb,$6)`,
        [sessionId, event.seq, event.type, event.time, json, payloadBytes])
        const search = eventText(event)
        if (search !== undefined && search.content !== '') {
          await client.query(`INSERT INTO harness.conversation_search(session_id,event_seq,role,content,occurred_at)
            VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))`,
          [sessionId, event.seq, search.role, search.content, event.time])
        }
      }
      await client.query(`UPDATE harness.conversation_sessions SET
        next_seq=$2,event_count=event_count+$3,total_payload_bytes=total_payload_bytes+$4,
        updated_at=now(),version=version+1 WHERE id=$1`,
      [sessionId, events.at(-1)!.seq + 1, events.length, bytes])
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

  async search(organizationId: string, query: string, limit = 50): Promise<Array<{ sessionId: string; seq: number; content: string }>> {
    const result = await this.pool.query<{ session_id: string; event_seq: string; content: string }>(`SELECT s.session_id,s.event_seq,s.content
      FROM harness.conversation_search s
      JOIN harness.conversation_sessions c ON c.id=s.session_id
      WHERE c.organization_id=$1 AND s.content % $2
      ORDER BY similarity(s.content,$2) DESC,s.occurred_at DESC LIMIT $3`, [organizationId, query, limit])
    return result.rows.map(row => ({ sessionId: row.session_id, seq: Number(row.event_seq), content: row.content }))
  }
}
