# harness-gateway

[English](README.md) | 中文

DeepSeek Harness 公网化门户网关：PostgreSQL 支撑的登录/会话、用户/项目/目录授权、HTTP+WS 反向代理（把 Host/Origin 改写为实例回环地址）、个人与共享项目 dsh 运行时生命周期、`/admin` SPA 与 `/admin/api` JSON、协作对话、模型治理、用量核算与审计。设计与阶段计划见[设计文档](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md)、[Phase 1 计划](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md)与[项目制管理端](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md)。

## 工具链

- **Node 25**（`.nvmrc`；dsh 仓库 engines `^22.19 || >=24` 亦兼容）。`better-sqlite3` 与 `argon2` 是原生模块，ABI 绑定安装时的 Node 大版本——切换 Node 后运行 `npm rebuild better-sqlite3 argon2`，否则报 `NODE_MODULE_VERSION` 不匹配。
- 命令：`npm run dev`（tsx 启动）、`npm test`（vitest）、`npm run typecheck`。

## 配置（环境变量，见 src/config.ts）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HGW_PORT` | 8899 | 网关监听端口 |
| `HGW_DATABASE_URL` | （未设置文件时必需） | PostgreSQL 连接 URL；生产优先使用文件形式 |
| `HGW_DATABASE_URL_FILE` | （未设置 URL 时必需） | 包含 PostgreSQL 连接 URL 的 `0600` 权限文件 |
| `HGW_ORGANIZATION_SLUG` | `default` | 本进程选择的现有活跃 PostgreSQL 企业 |
| `HGW_COMPUTE_NODE_NAME` | `local` | 拥有挂载、端口和实例状态的现有活跃计算节点 |
| `HGW_INTAKE_PORT` | `HGW_PORT + 1` | 仅回环监听、Bearer 鉴权的用量 intake 端口 |
| `HGW_USAGE_TIME_ZONE` | `Asia/Shanghai` | 定义自然月边界的 IANA 时区 |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | 逗号分隔的公网 Origin 白名单（CSRF 校验；https 时 Cookie 标记 Secure） |
| `HGW_USERS_ROOT` | `~/harness-users` | 用户目录根（生产 `/srv/harness/users`） |
| `HGW_PROJECT_RUNTIMES_ROOT` | `~/harness-project-runtimes` | 共享项目运行时由宿主拥有的 `$DSH_HOME` 根目录 |
| `HGW_PROJECTS_ROOT` | `~/harness-projects` | 管理员仅凭名称创建项目的受控根（`<root>/<name>`，mode `0770`；生产为 `/srv/harness/projects/admin`） |
| `HGW_USER_PROJECTS_ROOT` | `<第一个项目根>/user-projects` | 用户创建项目的受控目录根；生产为 `/srv/harness/projects/user-projects` |
| `HGW_PROJECT_PATH_ROOTS` | （`systemd` 必填） | 包含项目目录的逗号分隔、互不重叠 Linux 绝对根路径；禁止使用 `/` |
| `HGW_PROJECT_RUNTIME_USER` | `harness-project` | 项目 scope systemd 单元使用的专用 Linux 账户 |
| `HGW_PRINCIPAL_KEY_DIR` | `~/.harness-gateway/principal-keys` | 用于签发浏览器请求 principal 的仅所有者可读 Ed25519 密钥对 |
| `HGW_PRINCIPAL_ASSERTION_TTL_MS` | 30 秒 | 一份签名 principal 的生命周期；WebSocket 客户端会在过期前重连 |
| `HGW_RUNTIME_CREDENTIAL_DIR` | `~/.harness-gateway/runtime-credentials` | systemd 用户/项目运行时加载的宿主私有凭据文件 |
| `HGW_RUNTIME_API_BODY_LIMIT_BYTES` | 64 MiB | 单次认证私有运行时 API 请求允许的最大 body 大小 |
| `HGW_DSH_COMMAND` | 源码入口 `apps/cli/src/bin.ts web --port {port}` | 实例启动命令；生产指向钉死版本的 npm `dsh` bin |
| `HGW_DSH_REPO_ROOT` | 仓库根 | 解析源码运行入口 |
| `HGW_INSTANCE_PORT_BASE` | 42000 | 实例端口分配起点 |
| `HGW_IDLE_TIMEOUT_MS` | 30 分钟 | 实例闲置休眠阈值 |
| `HGW_READINESS_TIMEOUT_MS` | 30 秒 | 实例就绪等待上限 |
| `HGW_LAUNCHER` | `local` | 实例启动驱动：`local`（macOS 开发子进程）/ `systemd`（Linux 生产每用户单元） |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | systemd 驱动写每用户单元文件的目录 |
| `HGW_GUARD_PATCH` | `<仓库>/plugins/dsh-directory-guard/cordis.patch.yml` | 挂载进每个实例的 directory-guard bundle 补丁；同目录的管理员覆盖层为管理员恢复 Full access；`off` 关闭 |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<仓库>/plugins/dsh-model-governance` | 链接进每个 profile 的树外实例授权与用量插件 |
| `HGW_DEFAULT_ENV_FILE` | （空） | 每次启动复制到实例 `$DSH_HOME/.env` 的公司默认凭据 |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | 每实例 systemd 资源限额 |
| `HGW_GATEWAY_DIR` | 网关根目录 | 对实例遮蔽的目录（`InaccessiblePaths`） |

生产安装、切流与验收见 [deploy/README.md](deploy/README.md)。

## 管理端与项目授权

`/admin` 托管从 `gateway/admin-ui` 构建到 `gateway/public/admin` 的 Vite SPA；`/admin/api/*` 是网关 JSON API（非 `admin` 角色 403）。授权按项目：管理员发起的项目只凭名称创建，Gateway 会创建或复用 `<HGW_PROJECTS_ROOT>/<name>`（mode `0770`；JSON API 保留可选绝对 `path` 用于导入现有目录），用户发起的项目则在 `HGW_USER_PROJECTS_ROOT` 下分配一个目录；两者使用同一套工作空间、共享运行时、成员和对话模型。用户创建的项目把创建者设为 `rw` 所有者，并提供邀请生命周期操作；管理员可以在同一列表中查看两种来源并按来源筛选。成员为 `ro` 或 `rw`，普通用户的有效列表（私有 home 加成员身份，每条带 `label`）写入 `$DSH_HOME/directory-grants.json`。管理员在个人和项目 scope 都得到文件系统根目录的 `rw` 授权和 Full access 预设。该预设只改变 dsh 的应用内 sandbox 与审批旋钮；项目运行时仍受内核项目路径约束。角色变化会重写这份投影，并重启正在运行的个人实例。受控名称会被修剪且必须恰好构成一个目录段，因此 `.`/`..`、分隔符、控制字符和经符号链接解析的逃逸都会被拒绝；显式路径不存在、不是目录或 Gateway 无权访问时，创建弹窗会保留输入并显示修正提示。用户删除是逻辑删除：停止个人实例、吊销会话、移除项目与模型访问、在登录和管理列表中隐藏账号，并保留审计、用量、对话和 home 历史；用户名保持占用。项目路径不能与另一项目、用户 home、用户根或项目运行时根重叠；systemd 启动器还要求每个项目严格位于某个 `HGW_PROJECT_PATH_ROOTS` 条目之下，并避开 Gateway 目录。

管理端的用户、项目、模型、用量和审计页面共用一套视觉系统：克制的表面色、统一的页面与分区标题、状态徽标、明确的加载/空状态/错误状态、键盘焦点环，以及用于变更操作的弹窗表单。项目详情包含成员、实例状态、自然月 token/成本/缺失用量汇总，并要求明确选择额度模式：继承普通成员额度，或同时提交项目 token 与公司成本额度。视口宽度大于 `840px` 时使用固定侧栏和便于横向比较的数据表；宽度不超过 `840px` 时，侧栏变为吸顶品牌栏加五项固定底部导航，表格行切换为易读的卡片。宽度不超过 `560px` 时，表单网格改为单列、操作按钮填满可用宽度，弹窗接近全屏并让正文独立滚动。粗指针控件预留 `44px` 触控目标，同时遵循深色配色和减少动画偏好。修改界面后运行 `npm run build --prefix gateway/admin-ui` 重新生成静态资源；运行中的网关直接提供生成后的 `gateway/public/admin` 文件，不需要数据库迁移。

## 项目协作对话

账户运行在个人 scope 或一个可访问项目 scope 中。个人 scope 保留每用户运行时及其持久化；每个项目使用一个覆盖项目路径的共享运行时。Gateway 为所选运行时签发短期请求 principal，并在每次代理的 HTTP/WebSocket 操作中转发。运行时会在 Host 代码观察请求前验证组织、用户、scope、运行时 id 和 generation。私有运行时凭据与协作端点只允许 loopback 访问。完整决策见[项目协作对话](../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md)。

项目成员分为 `ro` 和 `rw`。组织管理员无需项目成员记录，就对每个活动项目及其全部对话（包括私密根对话）拥有隐式 `rw` 权限。管理员专用的 `danger-full-access` 预设在个人或项目 scope 中都会在验证请求身份后提供；普通用户不能通过 `/permission` 或新会话默认设置选择它。在共享项目会话中，权限事件属于整个会话，因此管理员切换预设后，所有参与者看到的应用内预设都会改变，直到下一次获得授权的选择；systemd 项目单元仍把宿主访问限制在项目路径内。对普通成员而言，根对话选择项目公开或仅创建者可见，后代继承根 ACL。Host 操作会授权读取、写入、管理、fork、stream、审批和问题；PostgreSQL 只接受每项共享审批/问题的一份响应。项目运行时通过 Gateway PostgreSQL 提供方保存 Session header 和完整事件；其写入和读取解码器会在数据进入活动 Session 前要求精确的事件 envelope 字段与 surface 元数据。持久参与者元数据使模型与 transcript 能区分贡献者。Web 插件展示 scope、可见性、创建者、参与者和贡献次数，并为 `ro` 成员替换完整 composer；浏览器不是授权边界。

Session ACL 检查会在每次操作中查询当前成员身份。只依赖 scope 的 Host 操作最多在 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 内使用已签名模式（默认 30 秒），长连接 stream 会在 principal 过期时断开。删除项目时，Gateway 会在该运行时的串行操作槽内停止共享运行时，再由 PostgreSQL 级联删除项目所属的运行时与协作记录；项目目录仍保留在磁盘上。

## 模型治理与用量核算

管理 SPA 提供“模型”和“用量”页面。模型以精确 `(provider, model)` 路由标识；全局启用开关、角色默认（`admin` / `user`）和按用户 `允许` / `拒绝` / `继承` 例外共同决定有效策略。策略变化会原子重写 `$DSH_HOME/model-governance.json`（权限 `0600`）；运行中的实例会监视该文件，验证通过后无需重启即可应用策略，无效的运行中文档会对新的模型请求 fail-closed。实例插件提供 `ctx.modelAccess`；`apiproxy` 过滤目录并拒绝选择/发送 RPC，而 `llm/stream` 中间件是聊天、标题、压缩和直接调用进入适配器前的最终强制点。

## PostgreSQL 控制面

钉死版本的 PostgreSQL 17 部署位于 [`deploy/postgres/`](deploy/postgres/README.md)。Gateway 入口会应用其不可变 migration，并在配置的活跃企业与计算节点无法解析时拒绝监听。认证、用户、项目、个人/项目实例、共享项目对话、协作抢占、审计、模型治理、额度与用量都由 PostgreSQL 支撑。内部 UUID 保留企业外键，数字公共 ID 保持现有 HTTP API 稳定。SQLite 只保留为停止写入后的最终导入源和回滚备份；运行中的 Gateway 不会打开它。

每次调用都会先以 UUID 写入运行时本地的崩溃安全 outbox。仅回环的 intake 在 PostgreSQL 中按 UUID 去重，按调用时间选择生效价格版本，并根据非秘密凭据来源标签归属公司成本（`file`/`project-env`/`request` 为个人，启动环境来源为公司，未知来源按公司成本保守计入）。账本不写 API Key、提示词或回复内容。自然月使用 `HGW_USAGE_TIME_ZONE`；Token 与公司成本额度支持角色默认、按用户继承/不限/自定义，以及项目继承或显式额度。额度只在 80% 和 100% 提醒，不阻断调用。用户在 Web shell 看到持久阈值提醒；管理员看到按用户和按项目自然月汇总、缺失计量次数、估算成本和公司成本。

## 目录强制的分层

网关只做认证与编排；普通用户目录访问由 Linux 生产的 systemd 挂载命名空间和每个实例内加载的 [dsh-directory-guard](../plugins/dsh-directory-guard/README.md) 插件共同强制。普通用户单元会先遮蔽用户根、项目运行时根和已配置项目根，再仅回绑运行时 home、`$DSH_HOME` 与获准项目目录；`ProtectSystem=strict`、`ProtectHome=tmpfs` 和移除 `CAP_SYS_ADMIN` 覆盖整个进程树。home 补丁还会用应用内目录浏览器替代宿主操作系统选择器，由浏览器列出授权根并拒绝根外路径。管理员保留同一插件组合，但得到文件系统根目录授权和 Full access 预设；其 systemd 单元取消普通用户的目录遮蔽与系统/home 只读设置，同时继续使用非 root 运行时账户，并保留 `NoNewPrivileges`、能力限制和 Gateway 目录排除。共享项目单元以 `HGW_PROJECT_RUNTIME_USER` 运行，只绑定项目路径与其私有 `$DSH_HOME`，并把凭据设置暴露为只读。受控用户项目根必须为 `HGW_PROJECT_RUNTIME_USER` 继承组访问（例如由 root 拥有、`harness-project` 作为组且权限为 setgid `2770`，或使用等效默认 ACL），否则新分配的目录无法被项目单元打开。macOS 没有 systemd 挂载命名空间，因此普通用户和共享项目的全进程约束仍属于开发环境限制。
