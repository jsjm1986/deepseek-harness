# 项目制管理端 — 设计文档

日期：2026-08-14
状态：已实施
方案：网关托管管理应用 + 一等项目对象 + 成员读/写 + 改权即重启

登录、会话、反向代理、每用户实例、directory-guard 与 Linux 内核强制仍以 [多用户与目录权限管理设计](2026-08-14-user-directory-permission-gateway-design.md) 为准。本文替换其中的组 / `dir_grants` 管理模型和 `/admin` MVP 形态：目录权限按项目管理，管理界面是网关自己的产品 UI，不反代到任何 dsh 实例。

## 1. 目标与非目标

### 目标

1. 管理员按**项目**分配目录：一个项目对应一个已存在的绝对目录，多名用户可分别拥有该项目的只读或读写。
2. 每个用户仍有私有 home（恒为 rw，互不可见）；项目是额外授权的共享根。
3. 用户添加工作区时只从「自己的 home + 作为成员的项目根」里选，不从整盘浏览。
4. 管理端调整成员或读/写后，已运行实例立刻停再拉起，新授权生效。
5. 管理端在实例休眠或失败时仍可用。

### 非目标

- 不在用户的 dsh 实例里做管理 UI（实例停了就无法开号、改权、重启他人）。
- 不做组；不做自助建项目；不改项目路径（换目录则删项目再建）；不销号。
- 不做项目内再拆子路径权限、SSO、用量、集中 LLM 代理、Linux systemd 挂载验收（仍属原设计 Phase 2 / 3）。
- 不把管理端做成独立仓库或独立域名。

## 2. 架构

公网入口仍是网关。路径划分：

| 路径 | 处理 |
|---|---|
| `/login` `/logout` `/account/password` `/healthz` | 网关自有（不变） |
| `/admin` `/admin/assets/*` | 网关静态托管的管理应用 |
| `/admin/api/*` | 网关 JSON API；非 `admin` 角色 403 |
| 其余 | 已登录用户反代到本人实例 |

管理应用与工作台同源，Cookie 仍是 `hgw_session`。写操作继续校验 `Origin` ∈ `HGW_PUBLIC_ORIGINS`。管理员可从工作台顶栏进入 `/admin`，也可在实例未启动时直接打开 `/admin`。

前端：`gateway/admin-ui/` 使用 Vite + TypeScript + React，构建产物写入 `gateway/public/admin/`，由网关按静态文件提供。不引入 dsh 客户端插件，不进入 pnpm workspace 的 `packages/`。

## 3. 数据模型

SQLite 增加 `schema_version`，启动时按版本迁移。无旧格式兼容垫片。

```sql
projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ro', 'rw')),
  PRIMARY KEY (project_id, user_id)
);
```

`path` 为 `realpath` 后的绝对目录。创建时路径必须已存在且为目录；不得等于任何用户的 `home_path` 或 `$DSH_HOME`（`usersRoot/<username>/dsh`）。一人在同一项目只有一档 `mode`。

**有效授权**（写入 `$DSH_HOME/directory-grants.json`）：

```
[{ "path": "<home>", "mode": "rw", "label": "主目录" },
 { "path": "<project.path>", "mode": "<member.mode>", "label": "<project.name>" },
 ...]
```

`dsh-directory-guard` 只按 `path` 前缀强制；忽略 `label`。

删除表：`groups`、`group_members`、`dir_grants`。迁移：每个不同的 `dir_grants.path` 建一个项目（`name` 默认目录名，重名加 `-2`、`-3`…）；`subject_type=user` 的行与曾挂该路径的组成员都成为成员；同一人同时有 `ro` 与 `rw` 时取 `rw`。迁完删除旧表。

`users`、`instances`、`auth_sessions`、`audit_log` 保留为历史数据；用户删除通过 `users.deleted_at` 记录逻辑删除。审计动作使用 `admin.projects.*`、`admin.members.*`，并保留现有 `admin.users.*` / `admin.instances.*`。

## 4. 管理端页面与 API

三个一级页：用户、项目、审计。错误回显为 JSON `{ error: string }`；危险操作（禁用、重置密码、删用户、删项目、移除成员）由前端确认。

### 用户

列表字段：用户名、显示名、角色、账号状态、实例状态、端口。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/admin/api/users` | 列表 |
| POST | `/admin/api/users` | 创建（建 home 与 `$DSH_HOME`、分配端口、`must_change_password=1`） |
| PATCH | `/admin/api/users/:id` | `displayName` / `role` / `status` |
| DELETE | `/admin/api/users/:id` | 逻辑删除用户、停止实例并撤销活跃授权 |
| POST | `/admin/api/users/:id/password` | 重置密码并吊销该用户全部会话 |
| POST | `/admin/api/users/:id/instance/{start,stop,restart}` | 实例控制 |

不能禁用、降权或删除最后一个 `status=active` 且 `role=admin` 的用户，也不能删除当前登录管理员。删除使用逻辑删除：先停止个人实例、吊销会话和运行时凭据、移除项目成员及用户模型授权/额度，再写入 `users.deleted_at`；审计、用量、会话、内容文件和 home 保留，用户列表与登录隐藏，用户名不可复用。

### 项目

列表字段：名称、路径、成员数。详情含成员矩阵（全量用户 × 无 / `ro` / `rw`）。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/admin/api/projects` | 列表 |
| POST | `/admin/api/projects` | `{ name, path }`，path 经 realpath 校验 |
| GET | `/admin/api/projects/:id` | 详情 + 成员 |
| PATCH | `/admin/api/projects/:id` | 仅 `name` |
| DELETE | `/admin/api/projects/:id` | 删除项目并撤掉全部成员 |
| PUT | `/admin/api/projects/:id/members/:userId` | `{ mode: "ro" \| "rw" }` 加入或改权限 |
| DELETE | `/admin/api/projects/:id/members/:userId` | 移除成员 |

项目 `path` 不可改。任一成员写入成功后，对**该用户**执行 §5。删除项目对**每一名原成员**执行 §5。

### 审计

`GET /admin/api/audit?userId=&action=&from=&to=&limit=&offset=`，只读，不返回请求体。

## 5. 生效链路

成员或项目删除成功后：

1. 按 §3 重算该用户有效授权，覆盖 `$DSH_HOME/directory-grants.json`。
2. 若实例状态为 `ready` 或 `starting`：停止再 `ensureRunning`。
3. 若实例已 `stopped`：只写文件，不唤醒；下次登录的 `beforeStart` 再写一次。

多名用户受影响时按 `user_id` 串行处理。重启失败：授权文件已是新值，审计记失败，管理端该用户实例状态标为未就绪，可手动 start/restart。

## 6. 工作区列表

实例内「添加工作区」只列出授权文件中的根（`label` + `path`），选一条即 `workspaces.create({ path })`。不提供整盘目录树作为工作区来源。只读项目可选为工作区；写入仍由 directory-guard 拒绝。

实例通过 Host 方法读取授权文件并返回 `{ path, mode, label }[]`（具体注册名在实施计划里落到现有 host/browse 包，不新开能力三角）。浏览与工具路径不得离开这些根。公网继续使用 in-app browse，不调用 OS 选目录框。

用户刷新时若当前工作区路径已不在授权列表中，打开失败并提示，不得继续作为当前工作区。被撤权的项目从列表消失。

## 7. 测试与验收

网关 vitest（无密钥）：迁移（含 `rw` 覆盖与旧表删除）；有效授权（home、成员、非成员）；项目约束（重名、重路径、路径不存在、home/`$DSH_HOME`）；成员变更只重启运行中实例；最后管理员保护；`/admin/api/*` 非管理员 403 与管理员 CRUD/审计。

directory-guard：授权文件含 `label` 时仍按路径拒绝越权。

工作区选择器客户端单测：只渲染授权根；撤权后项目不再出现。

手工验收（Mac 网关）：两用户一项目，A 为 `rw`、B 为 `ro`；A 可写、B 可读不可写；把 B 改为 `rw` 并等重启后 B 可写；移除 B 后其工作区列表无该项目；home 仅本人可见。

不把公网 e2e 或聊天 snapshot 当作管理端的验收替代。

## 8. 与原设计的关系

原设计 §3 的组与 `dir_grants`、§8 的服务端渲染 `/admin` MVP，以本文为准。原设计 §4–§7、§9–§11、Phase 2/3 仍然有效。公司默认 `DEEPSEEK_API_KEY` 仍由 `HGW_DEFAULT_ENV_FILE` 在实例启动时写入，不进入本期管理 UI。
