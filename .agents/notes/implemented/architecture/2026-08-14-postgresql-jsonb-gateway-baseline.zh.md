# Agent Note: PostgreSQL JSONB Gateway 基线

Status: implemented

[English](2026-08-14-postgresql-jsonb-gateway-baseline.md) | 中文

## 问题

Gateway SQLite schema 把身份、项目、实例状态、治理、用量和审计混在一个同步连接中，而 Harness 对话仍是每用户独立 JSONL 产物。企业规模需要更强的并发、版本化迁移和可查询会话历史；但若把 Agent 数据当作传统规范化 CRUD，或额外引入文档数据库，就会重复现有事件词汇并增加不必要的运维。

## 决策

第一阶段迁移基线只使用一个钉死版本的 PostgreSQL 17 数据库。关系控制数据使用类型化列、保证企业归属一致的复合外键，以及企业范围内的幂等键；完整的结构化 Harness 会话事件存入 JSONB，同时保留固定的顺序和查询列。大型二进制文件、附件、生成物和超大工具输出继续放在本机文件系统中，PostgreSQL 记录其元数据与校验和。

该基线与在线 Gateway 的存储选择独立交付。生产继续使用 `gateway.sqlite`，直到异步 Repository 替换各同步服务并完成另行批准的切换演练。本阶段不导入现有 JSONL/Zstd 会话日志。现有 [SessionPersistence 决策](2026-06-14-session-persistence.md) 继续拥有在线会话语义；本 Gateway Repository 是迁移目标，不是第二条在线持久化路径。范围更广的 [storage domain 提案](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) 仍是独立的未来工作；本基线不实现其中的 log facet。

SQL migration 是不可变编号文件。Migration ledger 保存 SHA-256 checksum，并用 PostgreSQL advisory lock 保证同一时间只有一个迁移者。本机 Docker 部署同时钉死 PostgreSQL tag 和镜像 digest，只绑定回环地址，使用 named volume，并从 Compose secret 文件读取密码。

会话 append 会锁定 session 行，要求连续序号，保留任意字符串 Session ID，并使用全局幂等 batch ID。完整事件存为 JSONB；用户消息、最终助手消息和工具结果文本投影到 trigram 搜索表。Provider 连续 chunk 继续采用现有 Harness 打包行为，而不是每个 token 写一行数据库。

SQLite 导入器在单个事务中运行，并可重复导入同一控制面。它保留密码哈希、用户、项目和本机挂载、停止状态的实例分配、治理、价格历史、额度、用量、告警和审计。认证会话、登录尝试和 intake token 明确丢弃，切换后重新建立凭据。

## 测试

真实 PostgreSQL 17.6 容器验证 migration 应用与幂等、checksum 和未知版本拒绝、企业隔离、任意字符串 Session ID、JSONB 事件往返、序号拒绝、并发重试幂等、嵌套工具结果搜索，以及完整控制面 fixture 和生产 SQLite 在线快照的可重复导入。备份验证使用仅所有者可读的 custom-format dump，并在接受流程前恢复到一次性数据库中。

## 曾考虑的替代方案

**把对话存入 MongoDB。** 否决，因为 PostgreSQL JSONB 已能承载持续演进的事件 payload，同时把事务、顺序、授权、治理和审计关联保留在一套运维系统中。

**为每种事件建立专用规范化表。** 否决，因为 Harness event map 面向扩展；若每个插件事件都要求 schema migration，会让持久化层拥有它当前只是通用保存的领域词汇。

**把所有附件和生成文件放进 PostgreSQL。** 否决，因为大型二进制值和 workspace 文件会膨胀备份与 WAL。当前本机文件系统仍是第一阶段更合适的介质。

**DDL 存在后立即切换生产。** 否决，因为在线服务仍同步依赖 `better-sqlite3`。必须先独立验证基线，再替换 Repository 并执行切换。

## 后果

仓库包含具体、可运行的 PostgreSQL 目标，同时没有引入 MongoDB、Redis、对象存储或微服务。会话数据通过 JSONB 保持灵活，并可由 PostgreSQL 搜索。迁移、导入、备份和恢复都是可执行行为，而不是只有文档。代价是一个明确的过渡期：PostgreSQL 尚未成为在线 Gateway 数据库，现有对话日志仍是本机 JSONL，单机 Docker 只提供持久性而不提供高可用。
