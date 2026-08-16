# 本机 PostgreSQL 控制面

[English](README.md) | 中文

本目录运行 Gateway PostgreSQL 控制面。它只使用一个 PostgreSQL 17 数据库：控制数据使用普通列，追加式会话事件使用 PostgreSQL JSON，大型本机文件继续保存为宿主机路径。不引入 MongoDB、Redis、对象存储或第二套服务层。Gateway 入口要求该数据库，且不会打开 SQLite。

## 本机启动

```bash
cd gateway/deploy/postgres
mkdir -p secrets "$HOME/harness-postgres-backups"
openssl rand -hex 32 > secrets/postgres_password
chmod 600 secrets/postgres_password
cp .env.example .env
set -a; . ./.env; set +a

docker compose up -d --wait
PASSWORD="$(cat secrets/postgres_password)"
ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PASSWORD")"
mkdir -p "$HOME/.config/harness-gateway"
printf 'postgresql://harness_owner:%s@127.0.0.1:%s/harness\n' "$ENCODED" "${HGW_POSTGRES_PORT:-5432}" \
  > "$HOME/.config/harness-gateway/database-url"
chmod 600 "$HOME/.config/harness-gateway/database-url"
export HGW_DATABASE_URL_FILE="$HOME/.config/harness-gateway/database-url"
cd ../..
npm run pg:migrate
npm run pg:check
```

加载 `.env` 前，先在其中调整宿主机备份目录与端口。

镜像同时钉死 tag 与 digest。PostgreSQL 只绑定回环地址，数据放在 Docker named volume `harness_postgres_data` 中。`secrets/postgres_password` 与 `.env` 均被 Git 忽略。

## Schema 与会话数据

`migrations/001_initial.sql` 创建单一 `harness` schema，包含身份、项目、实例、模型治理、用量、审计与会话表。`002_gateway_public_ids.sql` 保留导入的 SQLite 用户/项目数字，并在 UUID 继续只供内部使用时分配数字公共 ID。`003_project_collaboration.sql` 加入共享项目运行时归属、根继承对话可见性、参与者投影、审批/问题原子抢占，以及项目用量/额度主体。`004_conversation_event_json.sql` 把完整事件列改为 PostgreSQL `json`，从而保留包括转义 NUL 在内的所有合法 JSON 字符串，并移除 payload 表达式索引。`005_user_owned_projects.sql` 增加项目来源/所有者元数据和事务化邀请，使账户创建的工作空间与管理员登记的目录使用同一套控制面模型。`006_user_deletion.sql` 加入 `users.deleted_at` 时间戳和活跃账号部分索引，用于用户逻辑删除。复合外键禁止企业范围内的记录引用其他企业。会话 envelope 把可查询字段（`session_id`、`seq`、事件类型和时间）放在普通列中；完整的结构化 Harness 事件存入 `conversation_events.event`，可搜索文本则使用专用投影表。连续 chunk 继续由现有 Harness 持久化路径打包，不会把每个 token 写成一行 SQL。

图片、归档、生成文件和超大工具输出继续留在本机文件系统。`content_files` 记录用户或项目归属、本机路径、SHA-256、字节数和媒体类型。SQLite 导入器只迁移 Gateway 控制面，绝不导入既有 JSONL 会话日志。个人运行时保留其配置的本地持久化；新的共享项目运行时使用经过认证的 Gateway `SessionPersistence` 提供方，并把完整 Session header/事件存入这些 PostgreSQL 对话表。

## 导入 Gateway SQLite 快照

始终导入 SQLite 在线备份，不能直接复制正在使用 WAL 的数据库：

```bash
sqlite3 "$HOME/harness-gateway-data/gateway.sqlite" \
  ".backup '/tmp/gateway-before-postgres.sqlite'"

HGW_ORGANIZATION_SLUG=internal \
HGW_ORGANIZATION_NAME='Internal Harness' \
HGW_COMPUTE_NODE_NAME=mac-mini \
  npm run pg:import-sqlite -- /tmp/gateway-before-postgres.sqlite
npm run pg:check
```

导入器在一个事务内运行，并可对同一企业重复执行。它保留密码哈希、用户、项目来源/所有者元数据、挂载、停止状态的个人实例分配、成员、待处理和已完成的项目邀请、模型策略、价格、额度、用量、告警与审计记录。导入的邀请 UUID 由企业和 SQLite 旧邀请 ID 稳定派生，重复导入会更新同一行。Migration 3 会在需要时让每个既有项目创建者成为 `rw` 成员；除非 SQLite 行明确带有用户所有者，否则既有项目保持管理员发起来源。Gateway 启动时会用节点范围的 PostgreSQL advisory lock 串行化端口分配，并从 `HGW_INSTANCE_PORT_BASE` 开始为已挂载的活跃项目创建缺失的运行时记录；schema SQL 不嵌入部署端口号。登录会话、锁定尝试、运行时/intake token 和既有 JSONL/Zstd 对话明确不迁移；用户需要重新登录，凭据会重新签发，个人 transcript 继续留在原会话目录，协作 PostgreSQL 历史从切换后新建的项目 scope 对话开始。

## Gateway 运行时与切换

运行中的进程需要 `HGW_DATABASE_URL_FILE`、`HGW_ORGANIZATION_SLUG` 和 `HGW_COMPUTE_NODE_NAME`。企业和节点必须已经存在并保持活跃。启动会在绑定 HTTP 端口前应用待执行 migration；PostgreSQL 或任一所选记录不可用时，`/healthz` 返回 `503`。

从 SQLite 生产库迁移时，先停止 Gateway，创建最终 SQLite 在线备份，对该冻结文件运行导入器，再应用 migration、创建 PostgreSQL dump 并完成恢复校验。只有这些命令成功后才能启动新 Gateway。验证重新登录、`/admin` 资源与 API、用户/项目/模型/用量/审计视图、个人与项目运行时代理、项目 scope/可见性/参与者行为、`ro` 拒绝、项目额度/用量更新和私有 intake 端口，并确认冻结 SQLite 文件的修改时间不再前进。

回滚时停止 PostgreSQL Gateway，恢复切换前仍使用 SQLite 的 Gateway 产物，再把冻结的独立 SQLite 备份恢复到其配置数据路径，之后才启动旧产物。绝不能让两份产物同时承接用户流量，也不能把 PostgreSQL 写入反向导入 SQLite。再次尝试切换前，应单独调查或保留 PostgreSQL 数据库。

## 备份与恢复检查

```bash
npm run pg:backup
npm run pg:restore-check -- "$HOME/harness-postgres-backups/harness-YYYYMMDD-HHMMSS.dump"
```

`pg:backup` 生成 PostgreSQL custom-format dump，临时文件从写入首个字节起仅所有者可读，校验其目录后原子发布，默认只保留最新 30 份。`pg:restore-check` 把某个 dump 恢复到一次性数据库中，校验 migration ledger，然后删除该一次性数据库。

Named volume 与宿主机备份目录仍在同一台机器上，只能防逻辑误操作和容器损坏，不能防整机或磁盘损坏。在把它当作企业备份前，必须把成功的 dump 同步到第二台机器或 NAS。

## 测试

只有显式设置 `HGW_TEST_DATABASE_URL` 才会启用集成测试：

```bash
HGW_TEST_DATABASE_URL="$HGW_DATABASE_URL" \
HGW_TEST_SQLITE_FILE=/tmp/gateway-before-postgres.sqlite \
  npm run test:postgres
```

测试会删除所提供测试数据库中的 `harness` schema，绝不能指向生产库。覆盖内容包括直到版本 6 的不可变 migration、未知 migration ledger 拒绝、企业隔离、任意字符串 Session ID、包含 NUL 字符串的完整 JSON 往返、连续序号约束、并发批次幂等、嵌套工具结果搜索、包含项目邀请的可重复 SQLite 导入、根继承协作 ACL、贡献投影、交互竞态、从空节点配置端口基准分配共享项目运行时、项目凭据/额度/用量，以及在线认证、用户、项目、节点实例、审计和模型治理服务。
