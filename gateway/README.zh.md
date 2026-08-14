# harness-gateway

[English](README.md) | 中文

DeepSeek Harness 公网化门户网关：登录/会话、用户/项目/目录授权（SQLite）、HTTP+WS 反向代理（把 Host/Origin 改写为实例回环地址）、每用户 dsh 实例生命周期、`/admin` SPA 与 `/admin/api` JSON、审计。设计与阶段计划见[设计文档](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md)、[Phase 1 计划](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md)与[项目制管理端](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md)。

## 工具链

- **Node 25**（`.nvmrc`；dsh 仓库 engines `^22.19 || >=24` 亦兼容）。`better-sqlite3` 与 `argon2` 是原生模块，ABI 绑定安装时的 Node 大版本——切换 Node 后运行 `npm rebuild better-sqlite3 argon2`，否则报 `NODE_MODULE_VERSION` 不匹配。
- 命令：`npm run dev`（tsx 启动）、`npm test`（vitest）、`npm run typecheck`。

## 配置（环境变量，见 src/config.ts）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HGW_PORT` | 8899 | 网关监听端口 |
| `HGW_INTAKE_PORT` | `HGW_PORT + 1` | 仅回环监听、Bearer 鉴权的用量 intake 端口 |
| `HGW_USAGE_TIME_ZONE` | `Asia/Shanghai` | 定义自然月边界的 IANA 时区 |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | 逗号分隔的公网 Origin 白名单（CSRF 校验；https 时 Cookie 标记 Secure） |
| `HGW_DATA_DIR` | `gateway/data` | SQLite 与运行数据目录 |
| `HGW_USERS_ROOT` | `~/harness-users` | 用户目录根（生产 `/srv/harness/users`） |
| `HGW_DSH_COMMAND` | 源码入口 `apps/cli/src/bin.ts web --port {port}` | 实例启动命令；生产指向钉死版本的 npm `dsh` bin |
| `HGW_DSH_REPO_ROOT` | 仓库根 | 解析源码运行入口 |
| `HGW_INSTANCE_PORT_BASE` | 42000 | 实例端口分配起点 |
| `HGW_IDLE_TIMEOUT_MS` | 30 分钟 | 实例闲置休眠阈值 |
| `HGW_READINESS_TIMEOUT_MS` | 30 秒 | 实例就绪等待上限 |
| `HGW_LAUNCHER` | `local` | 实例启动驱动：`local`（macOS 开发子进程）/ `systemd`（Linux 生产每用户单元） |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | systemd 驱动写每用户单元文件的目录 |
| `HGW_GUARD_PATCH` | `<仓库>/plugins/dsh-directory-guard/cordis.patch.yml` | 挂载进每个实例的 directory-guard bundle 补丁；`off` 关闭 |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<仓库>/plugins/dsh-model-governance` | 链接进每个 profile 的树外实例授权与用量插件 |
| `HGW_DEFAULT_ENV_FILE` | （空） | 每次启动复制到实例 `$DSH_HOME/.env` 的公司默认凭据 |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | 每实例 systemd 资源限额 |
| `HGW_GATEWAY_DIR` | 网关根目录 | 对实例遮蔽的目录（`InaccessiblePaths`） |

生产安装、切流与验收见 [deploy/README.md](deploy/README.md)。

## 管理端与项目授权

`/admin` 托管从 `gateway/admin-ui` 构建到 `gateway/public/admin` 的 Vite SPA；`/admin/api/*` 是网关 JSON API（非 `admin` 角色 403）。授权按项目：一个项目对应一个已存在的绝对目录，成员为 `ro` 或 `rw`，用户的有效列表（私有 home 加成员身份，每条带 `label`）写入 `$DSH_HOME/directory-grants.json`。

## 模型治理与用量核算

管理 SPA 提供“模型”和“用量”页面。模型以精确 `(provider, model)` 路由标识；全局启用开关、角色默认（`admin` / `user`）和按用户 `允许` / `拒绝` / `继承` 例外共同决定有效策略。策略变化会原子重写 `$DSH_HOME/model-governance.json`（权限 `0600`），且只重启已经运行的受影响实例。实例插件提供 `ctx.modelAccess`；`apiproxy` 过滤目录并拒绝选择/发送 RPC，而 `llm/stream` 中间件是聊天、标题、压缩和直接调用进入适配器前的最终强制点。

## PostgreSQL 迁移基线

可运行的 PostgreSQL 17 基线位于 [`deploy/postgres/`](deploy/postgres/README.md)。它使用类型化关系控制表与 JSONB 会话事件，超大内容继续留在本机文件系统。生产仍使用 SQLite，直到异步 Repository 迁移完成并另行批准切换。

每次调用都会先以 UUID 写入实例本地的崩溃安全 outbox。仅回环的 intake 在 SQLite 中按 UUID 去重，按调用时间选择生效价格版本，并根据非秘密凭据来源标签归属公司成本（`file`/`project-env`/`request` 为个人，启动环境来源为公司，未知来源按公司成本保守计入）。账本不写 API Key、提示词或回复内容。自然月使用 `HGW_USAGE_TIME_ZONE`；Token 与公司成本额度支持角色默认以及按用户继承/不限/自定义。额度只在 80% 和 100% 提醒，不阻断调用。用户在 Web shell 看到持久阈值提醒；管理员看到按用户自然月汇总、缺失计量次数、估算成本和公司成本。

## 目录强制的分层

网关只做认证与编排；目录边界由两层强制：Linux 生产的 systemd 挂载命名空间（内核层，读写都管，覆盖整个进程树），加每个实例内加载的 [dsh-directory-guard](../plugins/dsh-directory-guard/README.md) 插件（作用于结构化路径工具参数的 `tools/pre-execute` 门）。同一份 home 补丁会停用 `directory-picker-auto` 并挂上应用内 browse 组合，使公网域名上的浏览器在页面里选择工作区目录，而不是在宿主桌面打开系统选文件夹框。授权文件含至少一条有效 path 时，该 browse 后端列出这些根并拒绝根外路径。macOS 开发环境无 systemd，插件层是那里唯一的强制点——仅供开发使用。
