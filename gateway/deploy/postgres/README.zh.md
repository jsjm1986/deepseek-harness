# 本机 PostgreSQL 基线

[English](README.md) | 中文

本目录运行 Gateway 第一阶段 PostgreSQL 数据面基线。它只使用一个 PostgreSQL 17 数据库：控制数据使用普通列，追加式会话事件使用 JSONB，大型本机文件继续保存为宿主机路径。不引入 MongoDB、Redis、对象存储或第二套服务层。

> **存储选择：**生产 Gateway 仍然打开 `gateway.sqlite`。这些文件、迁移、Repository 与导入器是已经独立验证的迁移基线。设置生产数据库 URL 不会切换当前 Gateway 入口。

## 本机启动

```bash
cd gateway/deploy/postgres
mkdir -p secrets "$HOME/harness-postgres-backups"
openssl rand -hex 32 > secrets/postgres_password
chmod 600 secrets/postgres_password
cp .env.example .env
set -a; . ./.env; set +a

docker compose up -d --wait
export HGW_DATABASE_URL="postgresql://harness_owner:$(cat secrets/postgres_password)@127.0.0.1:${HGW_POSTGRES_PORT:-5432}/harness"
cd ../..
npm run pg:migrate
npm run pg:check
```

加载 `.env` 前，先在其中调整宿主机备份目录与端口。

镜像同时钉死 tag 与 digest。PostgreSQL 只绑定回环地址，数据放在 Docker named volume `harness_postgres_data` 中。`secrets/postgres_password` 与 `.env` 均被 Git 忽略。

## Schema 与会话数据

`migrations/001_initial.sql` 创建单一 `harness` schema，包含身份、项目、实例、模型治理、用量、审计与会话表。复合外键禁止企业范围内的记录引用其他企业。会话 envelope 把可查询字段（`session_id`、`seq`、事件类型和时间）放在普通列中，完整的结构化 Harness 事件存入 `conversation_events.event JSONB`。连续 chunk 继续由现有 Harness 持久化路径打包，不会把每个 token 写成一行 SQL。

图片、归档、生成文件和超大工具输出继续留在本机文件系统。`content_files` 记录归属、本机路径、SHA-256、字节数和媒体类型。第一阶段明确不迁移现有 JSONL 会话日志；SQLite 导入器只迁移 Gateway 控制面。

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

导入器在一个事务内运行，并可对同一企业重复执行。它保留密码哈希、用户、项目、挂载、停止状态的实例分配、模型策略、价格、额度、用量、告警与审计记录。登录会话、锁定尝试和 intake token 明确不迁移；用户需要重新登录，实例 token 会重新签发。现有 JSONL/Zstd 对话在远程持久化阶段到来前继续留在原会话目录。

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

测试会删除所提供测试数据库中的 `harness` schema，绝不能指向生产库。覆盖内容包括不可变 migration checksum、未知 migration ledger 拒绝、企业隔离、任意字符串 Session ID、JSONB 往返、连续序号约束、并发批次幂等、嵌套工具结果搜索，以及覆盖当前所有控制面领域的可重复 SQLite 导入。
