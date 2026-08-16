# Agent Note: PostgreSQL Gateway 运行时切换

Status: implemented

[English](2026-08-14-postgresql-gateway-runtime-cutover.md) | 中文

## 问题

[PostgreSQL JSONB 基线](2026-08-14-postgresql-jsonb-gateway-baseline.md) 已经提供 schema、导入器、备份和会话 Repository，但在线 Gateway 服务最初同步调用 `better-sqlite3`。如果只提供 PostgreSQL URL 而不替换认证、用户、项目、实例状态、审计、模型治理和用量，SQLite 仍会是真源，或进程会在启动时停止。

## 决策

Gateway 入口要求 `HGW_DATABASE_URL` 或仅所有者可读的 `HGW_DATABASE_URL_FILE`，在监听前应用不可变 migration，并解析一个活跃的 `HGW_ORGANIZATION_SLUG` 与 `HGW_COMPUTE_NODE_NAME`。`/healthz` 校验 PostgreSQL 以及所选两条记录仍处于活跃状态。任何必需数据库输入缺失或无效时，启动会在绑定端口前失败。

Gateway 消费方使用可等待的服务接口。现有 SQLite 类保留为导入与聚焦测试实现；生产构造 PostgreSQL 认证、用户、项目、协作、对话、审计、模型治理、用量和个人/项目实例 Repository。HTTP handler、WebSocket proxy 初始化、签名 principal 签发、策略投影、systemd 授权渲染、项目 Session 持久化和用量 intake 都会等待每次可能跨数据库进程边界的操作。

PostgreSQL UUID 只在内部使用。`users.public_id` 和 `projects.public_id` 保留导入的 SQLite 数字，并为后续 HTTP API 记录分配数字 ID。每条查询都限定到所选企业；挂载、端口、个人/项目实例状态和闲置回收还限定到所选计算节点。创建用户会在一个事务中插入用户、密码凭据、成员身份和节点本地个人实例分配；创建项目则在同一事务中插入创建者成员身份、挂载和共享运行时分配。

生产切换会先停止 Gateway 写入，创建 SQLite 在线备份，重复执行事务式导入，应用全部 migration，把 PostgreSQL dump 恢复到一次性数据库完成校验，再启动仅使用 PostgreSQL 的入口。认证会话、登录尝试、运行时凭据、intake token 和 JSONL transcript 不导入，因此用户会重新登录，运行时策略文件会取得新 intake token，共享项目对话历史在切换后从 PostgreSQL 开始。冻结的 SQLite 备份是回滚源；运行 PostgreSQL 的进程不会打开或写入 `gateway.sqlite`。

## 验证

真实 PostgreSQL 17.6 容器覆盖直到版本 4 的 migration、公共 ID 保留与分配、企业隔离、完整 SQLite 控制面导入、认证与会话撤销、用户/项目管理、个人/项目实例状态、共享对话持久化与 ACL、完整 JSON Session Event 往返、审计查询、模型策略、用户/项目额度继承、精确微单位货币换算、幂等用量写入和阈值告警。SQLite 单元测试与组装后的 HTTP/proxy 测试继续覆盖共享路由和实例生命周期行为。生产验收检查本机与公网健康、鉴权后的管理端资源和 API、个人/项目代理、双成员共享与私密对话行为、`ro` 拒绝、私有用量 intake、不再产生 SQLite 写入，以及切换后的 PostgreSQL 恢复校验。

## 曾考虑的替代方案

**同时写入 SQLite 与 PostgreSQL。** 否决，因为两套可独立变更的真源需要为认证、分配、审计顺序、策略变化和幂等用量建立对账。停止写入后的最终导入提供一次明确的权威切换。

**保留同步服务 API，并在阻塞适配器后隐藏 PostgreSQL。** 否决，因为 Node 没有适合该服务器的阻塞式 PostgreSQL client，而且阻塞会暂停无关的 HTTP、proxy 与 intake 工作。

**通过现有 HTTP API 暴露 PostgreSQL UUID。** 否决，因为管理路由、实例 map、策略 subject、导入审计引用和现有 UI 都使用数字 ID。稳定的公共数字既保留这些约定，也不削弱内部企业外键。

**保留 SQLite 作为自动运行时 fallback。** 否决，因为 PostgreSQL 故障必须让 readiness 和启动显式失败。静默 fallback 会把写入接受进陈旧数据库，使恢复变得含糊。

## 后果

PostgreSQL 是唯一在线 Gateway 控制面数据库，可用性依赖其回环容器以及所选企业/节点记录。数据库操作在完整请求路径中都是异步的。共享项目运行时把 PostgreSQL 作为在线 `SessionPersistence` 提供方；既有个人 JSONL/Zstd 对话和大型文件仍留在宿主机文件系统。单机 Docker 部署具备已验证的逻辑备份与回滚，但不提供跨主机高可用。
