import { generateKeyPairSync } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import type {
  ConversationEvent,
  ConversationHeader,
  StoredConversation,
} from '../src/postgres/conversation-repository.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'

const ORGANIZATION_ID = '11d4a86c-4624-44fa-b69f-7e3f48cc5a04'
const ORGANIZATION_SLUG = 'acme'
const PROJECT_ID = 23
const PROJECT_INTERNAL_ID = '38131c5c-a84f-43ac-9487-24e90889273f'
const CREATOR_ID = 7
const CREATOR_INTERNAL_ID = 'c21c9696-6ca4-4698-84b8-3755e766e65d'
const MEMBER_ID = 8
const ADMIN_ID = 9
const ADMIN_INTERNAL_ID = '9d264f72-1c11-479d-ae39-0b0429d70d91'
const GENERATION = 4
const RUNTIME_TOKEN = 'runtime-token'
const CREATED_AT = 1_786_698_000_000

type RuntimeHandler = ReturnType<typeof createRuntimeApiHandler>
type RuntimeDependencies = Parameters<typeof createRuntimeApiHandler>[0]

interface RuntimeResponse {
  handled: boolean
  status: number
  body: unknown
}

const event: ConversationEvent = {
  type: 'user/message',
  seq: 0,
  time: CREATED_AT,
  data: { content: [{ type: 'text', text: 'hello' }] },
  surfaceOp: 'append',
}

function user(id: number, role: UserRow['role'] = 'user'): UserRow {
  return {
    id,
    username: `user-${String(id)}`,
    displayName: `User ${String(id)}`,
    role,
    status: 'active',
    homePath: `/tmp/user-${String(id)}`,
    mustChangePassword: false,
  }
}

async function request(
  handler: RuntimeHandler,
  pathname: string,
  input: { body: unknown; principal?: string; token?: string },
): Promise<RuntimeResponse> {
  const headers: IncomingHttpHeaders = {
    authorization: `Bearer ${input.token ?? RUNTIME_TOKEN}`,
    'content-type': 'application/json',
  }
  if (input.principal !== undefined) headers[PRINCIPAL_HEADER] = input.principal
  const req = {
    method: 'POST',
    url: pathname,
    headers,
  } as unknown as IncomingMessage
  let status = 0
  let responseBody = ''
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) responseBody += Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      return this
    },
  } as unknown as ServerResponse
  const handled = await handler(req, res, pathname, JSON.stringify(input.body))
  return {
    handled,
    status,
    body: responseBody === '' ? undefined : JSON.parse(responseBody),
  }
}

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(privateKey, ORGANIZATION_SLUG, 60_000)
  const modes = new Map<number, 'ro' | 'rw'>([
    [CREATOR_ID, 'rw'],
    [MEMBER_ID, 'rw'],
  ])
  const query = vi.fn(async (_text: string, values?: unknown[]) => ({
    rows: values?.[1] === CREATOR_ID ? [{ id: CREATOR_INTERNAL_ID }]
      : values?.[1] === ADMIN_ID ? [{ id: ADMIN_INTERNAL_ID }] : [],
  }))
  const append = vi.fn(async (
    _sessionId: string,
    _batchId: string,
    _events: readonly ConversationEvent[],
    _header?: ConversationHeader,
  ): Promise<'inserted' | 'duplicate'> => 'inserted')
  const load = vi.fn(async (_sessionId: string): Promise<StoredConversation | undefined> => undefined)
  const deps = {
    context: {
      organizationSlug: ORGANIZATION_SLUG,
      pool: { query } as unknown as Pool,
    },
    instances: {
      authenticateRuntimeToken: vi.fn(async (token: string) => token === RUNTIME_TOKEN ? {
        organizationId: ORGANIZATION_ID,
        target: { kind: 'project' as const, id: PROJECT_ID },
        generation: GENERATION,
        projectInternalId: PROJECT_INTERNAL_ID,
      } : null),
    },
    conversations: {
      append,
      listScoped: vi.fn(async () => []),
      load,
    },
    collaboration: {
      access: vi.fn(async () => { throw new CollaborationDeniedError('conversation-not-found') }),
      claimInteraction: vi.fn(async () => false),
      projectForUser: vi.fn(async (projectId: number, userId: number) => {
        const administrator = userId === ADMIN_ID
        const mode = administrator ? 'rw' : modes.get(userId)
        return projectId === PROJECT_ID && mode !== undefined
          ? { projectId, name: 'Shared', path: '/tmp/shared', mode, administrator }
          : null
      }),
      readableSessionIds: vi.fn(async () => []),
    },
    principals,
  } satisfies RuntimeDependencies
  const issuePrincipal = (userId: number, mode: 'ro' | 'rw' = modes.get(userId) ?? 'rw') => principals.issue({
    user: user(userId, userId === ADMIN_ID ? 'admin' : 'user'),
    scope: {
      kind: 'project',
      projectId: PROJECT_ID,
      projectName: 'Shared',
      mode,
    },
    runtime: { kind: 'project', id: PROJECT_ID, generation: GENERATION },
  })
  return {
    append,
    handler: createRuntimeApiHandler(deps),
    issuePrincipal,
    modes,
    principals,
  }
}

async function prepare(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  visibility: 'project' | 'private',
  creatorUserId = CREATOR_ID,
): Promise<string> {
  const response = await request(runtime.handler, '/internal/runtime/session/create', {
    principal: runtime.issuePrincipal(creatorUserId),
    body: {
      visibility,
      header: { id: sessionId, version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
    },
  })
  expect(response).toMatchObject({ handled: true, status: 200 })
  return (response.body as { authorization: string }).authorization
}

async function appendFirst(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  authorization: string,
): Promise<RuntimeResponse> {
  return request(runtime.handler, '/internal/runtime/session/append', {
    body: {
      sessionId,
      batchId: `batch-${sessionId}`,
      creationAuthorization: authorization,
      events: [event],
    },
  })
}

describe('runtime session creation authorization', () => {
  it('materializes a project root signed for the organization slug', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'session-root', 'private')
    expect(runtime.principals.verifySessionCreation(authorization)).toMatchObject({
      organization: ORGANIZATION_SLUG,
      creatorUserId: CREATOR_ID,
      runtime: { kind: 'project', id: PROJECT_ID, generation: GENERATION },
      header: { id: 'session-root', version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
      visibility: 'private',
    })

    expect(await appendFirst(runtime, 'session-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'session-root',
      'batch-session-root',
      [event],
      {
        id: 'session-root',
        organizationId: ORGANIZATION_ID,
        creatorUserId: CREATOR_INTERNAL_ID,
        projectId: PROJECT_INTERNAL_ID,
        visibility: 'private',
        sessionFormatVersion: 0,
        createdAt: CREATED_AT,
        cwd: '/tmp/shared',
      },
    )
  })

  it.each([
    ['removed', undefined],
    ['downgraded', 'ro' as const],
  ])('rechecks a creator who was %s before the first append', async (_label, mode) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'revoked-root', 'project')
    if (mode === undefined) runtime.modes.delete(CREATOR_ID)
    else runtime.modes.set(CREATOR_ID, mode)
    runtime.append.mockClear()

    expect(await appendFirst(runtime, 'revoked-root', authorization)).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each([
    ['runtime id', { runtime: { kind: 'project' as const, id: PROJECT_ID + 1, generation: GENERATION }, sessionId: 'bound-root' }],
    ['runtime generation', { runtime: { kind: 'project' as const, id: PROJECT_ID, generation: GENERATION + 1 }, sessionId: 'bound-root' }],
    ['session id', { runtime: { kind: 'project' as const, id: PROJECT_ID, generation: GENERATION }, sessionId: 'other-root' }],
  ])('rejects an authorization bound to another %s', async (_label, binding) => {
    const runtime = fixture()
    const authorization = runtime.principals.issueSessionCreation({
      creatorUserId: CREATOR_ID,
      runtime: binding.runtime,
      header: { id: binding.sessionId, version: 0, createdAt: CREATED_AT },
      visibility: 'project',
    })

    expect(await appendFirst(runtime, 'bound-root', authorization)).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid session creation authorization' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it('applies project and private ACLs before a blank root is materialized', async () => {
    const runtime = fixture()
    const projectAuthorization = await prepare(runtime, 'blank-project', 'project')
    const privateAuthorization = await prepare(runtime, 'blank-private', 'private')

    const readable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(MEMBER_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(readable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project'] },
    })

    const creatorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'blank-private',
        action: 'write',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(creatorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { visibility: 'private', canRead: true, canWrite: true, canManage: true } },
    })

    const administratorReadable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(administratorReadable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project', 'blank-private'] },
    })

    const administratorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionId: 'blank-private',
        action: 'manage',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(administratorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { mode: 'rw', canRead: true, canWrite: true, canManage: true } },
    })
  })

  it('allows an administrator without project membership to materialize a private root', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'administrator-root', 'private', ADMIN_ID)

    expect(await appendFirst(runtime, 'administrator-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'administrator-root',
      'batch-administrator-root',
      [event],
      expect.objectContaining({
        creatorUserId: ADMIN_INTERNAL_ID,
        visibility: 'private',
      }),
    )
  })

  it('rejects a project root appended through an ordinary header', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'header-root',
        batchId: 'batch-header-root',
        header: { id: 'header-root', version: 0, createdAt: CREATED_AT },
        visibility: 'project',
        events: [event],
      },
    })
    expect(response).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })
})

describe('runtime session event validation', () => {
  it.each([
    ['missing data', { type: 'user/message', seq: 0, time: CREATED_AT, surfaceOp: 'append' }],
    ['missing surface operation', { type: 'user/message', seq: 0, time: CREATED_AT, data: {} }],
    ['malformed replacement', {
      type: 'assistant/message',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', start: 0, end: 0, extra: true },
    }],
    ['surface metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: 'append',
    }],
    ['source metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      sourceEventSeqs: [0],
    }],
    ['an extra envelope field', { ...event, extra: true }],
  ])('rejects %s', async (_label, invalidEvent) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, `invalid-${_label.replaceAll(' ', '-')}`, 'project')

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId: `invalid-${_label.replaceAll(' ', '-')}`,
        batchId: `batch-invalid-${_label.replaceAll(' ', '-')}`,
        creationAuthorization: authorization,
        events: [invalidEvent],
      },
    })

    expect(response).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid conversation event batch' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })
})
