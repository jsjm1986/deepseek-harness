# Agent Note: PostgreSQL JSONB Gateway 基线

Status: implemented

[English](2026-08-14-postgresql-jsonb-gateway-baseline.md) | 中文

## 问题

原 Gateway SQLite schema 把身份、项目、实例状态、治理、用量和审计混在一个同步连接中，而 Harness 对话是每用户独立 JSONL 产物。企业运行需要更强的并发、版本化迁移和可查询共享会话历史；但若把 Agent 数据当作传统规范化 CRUD，或额外引入文档数据库，就会重复现有事件词汇并增加不必要的运维。

## 决策

Migration 系列只使用一个钉死版本的 PostgreSQL 17 数据库。关系控制数据使用类型化列、保证企业归属一致的复合外键，以及企业范围内的幂等键；完整的结构化 Harness 会话事件存入 PostgreSQL `json`，同时保留固定的顺序和查询列；[完整 JSON 事件决策](../bug-fix/2026-08-15-postgresql-session-event-full-json.md)只取代本基线为该列选择 JSONB 的部分。大型二进制文件、附件、生成物和超大工具输出继续放在本机文件系统中，PostgreSQL 记录其元数据与校验和。

本记录负责 PostgreSQL schema 与 migration 机制。[PostgreSQL Gateway 运行时切换](2026-08-14-postgresql-gateway-runtime-cutover.md)负责异步控制面服务和生产数据库选择，[项目协作对话](../feature/2026-08-15-project-collaborative-conversations.md)负责经过认证的项目 `SessionPersistence` 提供方。既有 JSONL/Zstd 会话日志不会导入。现有 [SessionPersistence 决策](2026-06-14-session-persistence.md)继续拥有在线会话语义；个人运行时保留其配置的提供方，项目运行时通过同一接口使用 PostgreSQL。范围更广的 [storage domain 提案](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)仍是独立的未来工作；Gateway schema 不实现其中的通用 log facet。

SQL migration 是不可变编号文件。Migration ledger 保存 SHA-256 checksum，并用 PostgreSQL advisory lock 保证同一时间只有一个迁移者。Migration 3 加入共享项目运行时归属、根继承的 `project`/`private` 可见性、参与者投影、审批/问题原子抢占，以及项目额度/用量主体。Migration 4 把完整事件列改为 PostgreSQL `json`，并移除 payload 表达式索引。本机 Docker 部署同时钉死 PostgreSQL tag 和镜像 digest，只绑定回环地址，使用 named volume，并从 Compose secret 文件读取密码。

会话 append 会锁定 session 行，要求连续序号，保留任意字符串 Session ID，并使用全局幂等 batch ID。创建根时保存已认证创建者、项目和可见性；后代复制已锁定的根 ACL。已提交参与者消息的 source 会更新逐根贡献者记录，PostgreSQL 唯一性为每项共享审批/问题选择一位响应者。完整事件存为 PostgreSQL `json`；用户消息、最终助手消息和工具结果文本投影到 trigram 搜索表。Provider 连续 chunk 继续采用现有 Harness 打包行为，而不是每个 token 写一行数据库。

SQLite 导入器在单个事务中运行，并可重复导入同一控制面。它保留密码哈希、用户、项目和本机挂载、停止状态的个人实例分配、治理、价格历史、用户额度、用量、告警和审计。Migration 3 为已挂载的活跃项目分配共享运行时记录，并在需要时恢复每个项目创建者的 `rw` 成员身份。认证会话、登录尝试、运行时/intake token 和 JSONL transcript 明确丢弃，使凭据与协作历史在切换后从 PostgreSQL 权威重新开始。

## 测试

真实 PostgreSQL 17.6 容器验证直到版本 4 的 migration、幂等、checksum 和未知版本拒绝、企业隔离、任意字符串 Session ID、包含 NUL 字符串的完整 JSON 事件往返、序号拒绝、并发重试幂等、嵌套工具结果搜索、根 ACL 继承、参与者投影、交互竞态、项目用量/额度记录，以及完整控制面 fixture 和生产 SQLite 在线快照的可重复导入。备份验证使用仅所有者可读的 custom-format dump，并在接受流程前恢复到一次性数据库中。

## 曾考虑的替代方案

**把对话存入 MongoDB。** 否决，因为 PostgreSQL JSON 与显式投影已能承载持续演进的事件 payload，同时把事务、顺序、授权、治理和审计关联保留在一套运维系统中。

**为每种事件建立专用规范化表。** 否决，因为 Harness event map 面向扩展；若每个插件事件都要求 schema migration，会让持久化层拥有它当前只是通用保存的领域词汇。

**把所有附件和生成文件放进 PostgreSQL。** 否决，因为大型二进制值和 workspace 文件会膨胀备份与 WAL。当前本机文件系统仍是第一阶段更合适的介质。

**DDL 存在后立即切换生产。** 否决，因为在线服务仍同步依赖 `better-sqlite3`。必须先独立验证基线，再替换 Repository 并执行切换。

## 后果

仓库包含一套在线 PostgreSQL 权威，同时没有引入 MongoDB、Redis、对象存储或微服务。共享项目对话数据通过 PostgreSQL JSON 保持灵活、通过显式投影搜索，并由关系成员身份与根 ACL 检查保护。Migration、导入、备份和恢复都是可执行行为，而不是只有文档。既有个人 JSONL transcript 仍留在本机且不会导入，单机 Docker 只提供持久性而不提供高可用。
