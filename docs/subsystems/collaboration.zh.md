# 项目协作

[English](collaboration.md) | 中文

项目协作子系统把每次浏览器操作绑定到一位已认证参与者，依据根对话授权每项共享对话操作，并让项目会话使用同一套 Gateway 后端运行时与持久化域。[项目协作对话 Agent Note](../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md)负责安全与存储决策；本页记录 [`dsh-client-connection`](../../packages/client/connection)、[`dsh-gateway-runtime`](../../packages/context/gateway-runtime) 和 [`dsh-collaboration`](../../packages/context/collaboration) 的公共类型与 Cordis 服务。

## 运行时身份

Gateway 按用户分配个人运行时，按项目分配共享运行时。运行时 identity 包含单调递增 generation，因此为旧进程签发的 principal 不能授权替代进程。

```ts type-equiv
/** Runtime identity bound into both the launch credential and every principal. */
interface GatewayRuntimeIdentity {
  readonly kind: 'user' | 'project'
  readonly id: number
  readonly generation: number
}
```

所选浏览器 scope 携带当前有效项目模式。组织管理员即使没有项目成员记录，也会对每个活动项目获得 `rw`。该模式会签入每份 principal，而不是从可变的进程全局账户状态中读取。

```ts type-equiv
/** Scope selected by the authenticated browser request. */
type GatewayPrincipalScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number; projectName: string; mode: 'ro' | 'rw' }
```

```ts type-equiv
/** Validated Gateway assertion claims available for one request. */
interface GatewayPrincipalClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-runtime'
  organization: string
  user: {
    id: number
    username: string
    displayName: string
    role: 'admin' | 'user'
  }
  scope: GatewayPrincipalScope
  runtime: GatewayRuntimeIdentity
  issuedAt: number
  expiresAt: number
  nonce: string
}
```

每次根对话授权和可读会话筛选都会通过 Gateway 查询 PostgreSQL 中的当前组织角色与项目成员身份。因此，移除成员、把 `rw` 改为 `ro` 或取消管理员权限会影响下一次 Session ACL 检查。不带 Session ACL 的操作使用 principal 中捕获的 scope 模式；该模式不会超过 `expiresAt` 继续有效。Gateway 默认有效期为 30 秒，被代理的 HTTP 请求会获得新 principal，长连接 Host 与 Typert stream 会在过期时关闭并重连。

## 私有运行时通道

Gateway 通过继承的文件描述符或 systemd credential 文件向运行时交付一份私有凭据。bearer token 用于认证 loopback 内部 API 调用，公钥用于验证浏览器 principal；两者都不属于浏览器配置。

Connection 载体在浏览器信任检查后、任何 RPC 或 stream handler 运行前，用 `connection/request` waterfall 包裹每次已接受的 `/api` HTTP 分发与事件流 WebSocket opening。认证和请求上下文监听器读取进入时不可变的 header，并且必须调用 `next()`，以保留后续监听器与分发。

```ts type-equiv
/** One accepted HTTP request or WebSocket opening entering the Connection carrier. */
interface ConnectionRequestBoundary {
  kind: 'http' | 'upgrade'
  headers: IncomingHttpHeaders
}
```

```ts type-equiv
/** Private launch credential delivered through an inherited FD or systemd credential file. */
interface GatewayRuntimeCredential {
  version: 1
  gatewayUrl: string
  organization: string
  runtime: GatewayRuntimeIdentity
  token: string
  principalPublicKey: string
}
```

完成签名、有效期、组织、scope、运行时 identity 与 generation 验证后，`dsh-gateway-runtime` 只在当前 HTTP 或 WebSocket 分发期间暴露断言与 claims。

```ts type-equiv
/** Request-local assertion and its verified claims. */
interface GatewayRequestPrincipal {
  assertion: string
  claims: GatewayPrincipalClaims
}
```

内部调用方显式选择是否转发 principal。省略 `principal` 时只发送运行时 bearer token，`true` 转发当前请求 principal，显式 principal 则转发在同一请求或 stream 生命周期早先捕获的 authority。

```ts type-equiv
/** Options for one authenticated call to the Gateway's internal runtime API. */
interface GatewayRuntimeRequestInit extends RequestInit {
  /** Forward the current browser principal when this operation needs user authority. */
  principal?: boolean | GatewayRequestPrincipal
}
```

## 根对话 ACL

授权区分读取、写入、创建者或管理员管理以及人类交互响应。审批与问题 id 使用独立 namespace，并通过 Gateway 原子抢占提交。

```ts type-equiv
/** Authorization verbs applied to a root conversation ACL. */
type CollaborationAction = 'read' | 'write' | 'manage' | 'approve'
```

```ts type-equiv
/** Human interaction classes that accept exactly one committed response. */
type CollaborationInteractionKind = 'approval' | 'question'
```

项目根对话为 `project` 时每位当前项目成员都可读取，为 `private` 时只有创建者和当前组织管理员可读取。管理员无需项目成员记录，就对每个活动项目拥有 `rw` 读取、写入、管理和交互权限。后代继承根的项目、创建者与可见性，不携带独立 ACL。

```ts type-equiv
/** Visibility of one root conversation inside a project runtime. */
type CollaborationVisibility = 'project' | 'private'
```

参与者快照是经请求认证的数据。`dsh-collaboration-context` 把项目参与者元数据与每条获准的人类消息一起存储，并渲染其[包 README](../../packages/context/collaboration-context/README.md)描述的持久、模型可见归属信息。

```ts type-equiv
/** Authenticated human participant attached to one request. */
interface CollaborationParticipant {
  readonly userId: number
  readonly username: string
  readonly displayName: string
  readonly role: 'admin' | 'user'
  readonly scope:
    | { readonly kind: 'personal' }
    | {
      readonly kind: 'project'
      readonly projectId: number
      readonly projectName: string
      readonly mode: 'ro' | 'rw'
    }
}
```

授权成功后返回经根解析的事实。个人会话省略项目字段；项目会话同时报告存储的根可见性、创建者以及调用方当前成员模式。

```ts type-equiv
/** Root-inherited access facts returned after authorization succeeds. */
interface CollaborationAccess {
  readonly sessionId: SessionId
  readonly rootSessionId: SessionId
  readonly mode: 'ro' | 'rw'
  readonly canRead: true
  readonly canWrite: boolean
  readonly canManage: boolean
  readonly projectId?: number
  readonly visibility?: CollaborationVisibility
  readonly creatorUserId?: number
}
```

Host 消费方会在分发前分类每项项目 scope 操作。Session 读写使用 `authorize()`，列表与发布使用 `readableSessionIds()`，项目 scope 下的 Typert Remote 只接受按 Session 寻址的 allowlist：`goals/*` 需要 `write`，`messageFeedback/list` 需要 `read`，`messageFeedback/put` 与 `messageFeedback/delete` 需要 `write`。未分类或进程级 Remote 会被拒绝。

新项目根对话在异步创建操作中携带一项明确可见性。PostgreSQL 持久化提供方将这项选择与已认证创建者一起物化；注册子会话时复制根 ACL。

```ts type-equiv
/** Request-scoped metadata for a new root conversation. */
interface CollaborationSessionCreation {
  readonly visibility: CollaborationVisibility
}
```

## 捕获的 Authority

消费者在认证请求有效时捕获 authority，并在该操作期间保留不可变参与者与提供方生命周期。授权和可读会话筛选会查询 Gateway；签发提供方卸载时，`signal` 会中止。只有首个提交某项审批或问题结果的事务会让 `claimInteraction()` 返回 `true`。

```ts type-equiv
/** Principal-bound collaboration operations safe to retain for one request or stream lifetime. */
interface CollaborationAuthority {
  readonly participant: CollaborationParticipant
  /** Assertion expiry; long-lived streams reconnect no later than this instant. */
  readonly expiresAt: number
  /** Aborts when the provider that issued this authority unloads. */
  readonly signal: AbortSignal

  /**
   * Authorize one operation against the session's root ACL.
   * @param sessionId - requested root or descendant session.
   * @param action - operation class to authorize.
   * @returns root-inherited access facts.
   */
  authorize(sessionId: SessionId, action: CollaborationAction): Promise<CollaborationAccess>

  /**
   * Filter a batch to sessions this participant may read.
   * @param sessionIds - candidate root or descendant session ids.
   * @returns the readable subset.
   */
  readableSessionIds(sessionIds: readonly SessionId[]): Promise<ReadonlySet<SessionId>>

  /**
   * Atomically claim one pending human response for a shared conversation.
   * @param sessionId - session that emitted the approval request.
   * @param kind - interaction class whose ids occupy an independent namespace.
   * @param interactionId - stable approval or question request id.
   * @param outcome - exact response payload being committed.
   * @returns true for the first accepted responder; false after another responder won.
   */
  claimInteraction(
    sessionId: SessionId,
    kind: CollaborationInteractionKind,
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean>
}
```

消费者跨 HTTP 与 RPC 传输保留稳定拒绝码。`gateway-unavailable` 会失败关闭：格式错误的响应或不可访问的授权后端绝不会变成隐式许可。

```ts type-equiv
/** Stable failure codes shared by Gateway-backed Consumers. */
type CollaborationErrorCode =
  | 'not-member'
  | 'conversation-not-found'
  | 'forbidden'
  | 'visibility-locked'
  | 'gateway-unavailable'
```

项目运行时通过 [`dsh-session-persistence-gateway`](../../packages/session/session-persistence-gateway) 持久化共享会话 header 与事件；个人运行时保留其配置的本地提供方。公共持久化生命周期与崩溃修复行为仍由 [persistence.md](persistence.md) 负责。

删除项目时，Gateway 会在保持该运行时串行操作槽的同时停止共享运行时，再移除项目行。PostgreSQL 会级联删除运行时、成员、挂载、对话树与事件、参与者与交互记录、项目模型用量与额度数据、intake token、告警和内容文件元数据。文件系统中的项目目录会被保留。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcollaboration--collaboration-abstract-seam"></a>

### `ctx.collaboration` — `Collaboration` (abstract seam)

Project collaboration Service Definition consumed by host APIs and persistence providers.

```ts cordis-catalog
/**
 * Capture the authenticated principal for one request or event stream.
 * @returns an authority with participant identity and collaboration operations.
 */
abstract capture(): CollaborationAuthority

/**
 * Return new-session metadata visible during the wrapped creation operation.
 * @returns the active creation metadata, or undefined outside a wrapped operation.
 */
abstract currentCreation(): CollaborationSessionCreation | undefined

/**
 * Run session creation under an authenticated visibility choice.
 * @param creation - requested root-conversation visibility.
 * @param operation - creation work that synchronously reaches persistence registration.
 * @returns the operation result.
 */
abstract withSessionCreation<T>( creation: CollaborationSessionCreation, operation: () => Promise<T>, ): Promise<T>
```

Source: [`packages/context/collaboration/src/index.ts:116`](../../packages/context/collaboration/src/index.ts)

<a id="ctxgatewayruntime--gatewayruntime"></a>

### `ctx.gatewayRuntime` — `GatewayRuntime`

Authenticated Gateway context for one launched Harness runtime.

```ts cordis-catalog
/**
 * Return the principal bound to the current HTTP or WebSocket operation.
 * @returns the verified principal, or undefined outside an authenticated operation.
 */
current(): GatewayRequestPrincipal | undefined

/**
 * Return the current principal or reject an operation outside an authenticated request.
 * @returns the verified principal bound to the current operation.
 */
requireCurrent(): GatewayRequestPrincipal

/**
 * Publish one pending lazy-creation capability for other Gateway Consumers.
 * @param sessionId - project root whose first append will materialize it.
 * @param authorization - in-flight or resolved Gateway capability.
 * @returns an exact-registration disposer.
 */
registerSessionCreation( sessionId: SessionId, authorization: Promise<GatewaySessionCreationAuthorization>, ): () => void

/**
 * Read the pending lazy-creation capability for one project root.
 * @param sessionId - candidate project root.
 * @returns the capability promise, or undefined after materialization or rollback.
 */
sessionCreation(sessionId: SessionId): Promise<GatewaySessionCreationAuthorization> | undefined

/**
 * Call the authenticated loopback API without exposing its bearer token to other plugins.
 * @param path - absolute internal runtime API path.
 * @param options - fetch options and optional current-principal forwarding.
 * @returns the Gateway HTTP response.
 */
request(path: string, options: GatewayRuntimeRequestInit = {}): Promise<Response>
```

Types: [SessionId](core.md)

Source: [`packages/context/gateway-runtime/src/index.ts:234`](../../packages/context/gateway-runtime/src/index.ts)

<a id="typert-gateway-events"></a>

### `typert-gateway/*` events

<a id="typert-gatewayauthorize--serial"></a>

#### `typert-gateway/authorize` — serial

Authorize a validated Remote request before Context or lookup resolution and before the business method runs. A listener rejects by throwing.

```ts cordis-catalog
/**
 * Authorize a validated Remote request before Context or lookup resolution
 * and before the business method runs. A listener rejects by throwing.
 * @param payload - endpoint, selected service, decoded wire values, and cancellation.
 * @mode serial
 */
'typert-gateway/authorize'(payload: TypertGatewayAuthorizationRequest): Promise<void> | void
```

Source: [`packages/typert/protocol/src/types.ts:515`](../../packages/typert/protocol/src/types.ts)
<!-- END GENERATED cordis-surface -->
