# DeepSeek Harness 多用户与目录权限管理 — 设计文档

日期：2026-08-14
状态：待评审
方案：认证网关 + 每用户独立实例 + 内核级目录强制（三方案对比后选定）

项目对象、成员读/写、管理应用与工作区列表以 [项目制管理端设计](2026-08-14-project-centric-admin-design.md) 为准；本文的组 / `dir_grants` 与服务端渲染 `/admin` 不再作为管理模型。

## 1. 目标与非目标

### 目标

1. 公司内部多团队（几十人）通过统一入口登录使用 DeepSeek Harness。
2. 严格的用户隔离：用户看不到彼此的会话、工作区、目录与审批。
3. 目录权限四项能力，全部为强制边界而非 UX 提示：
   - 每用户自动分配专属主目录，互相不可见；
   - 管理员可为用户配置任意服务器路径的目录白名单；
   - 按团队/用户组管理共享目录，用户继承组权限；
   - 目录授权区分只读 / 读写两级。
4. 管理员管控：账号、组、目录授权、实例状态、审计日志。
5. Mac 开发调试 + Linux 生产部署双环境。
6. 与上游解耦：dsh 核心近零改动，可随时跟进上游更新。

### 非目标（本期不做）

- 不修改上游核心实现多租户（事件流过滤、存储分租户等均不做）。
- 不做用户间协作（共享会话、互相围观）。
- 不限制实例的网络出口（记录为已知限制，Phase 3 可用 systemd `IPAddressDeny`/代理收口）。
- 不做自助注册与计费。

## 2. 总体架构

```
公网 HTTPS（Cloudflare Tunnel 或 Nginx+TLS）
        │
        ▼
┌─────────────────────────────────────────────┐
│  门户网关 gateway（自研，Node.js/TS 单服务）   │
│  · 登录/登出，会话 Cookie                     │
│  · 用户/组/目录授权模型（SQLite）              │
│  · 反向代理 HTTP + WebSocket → 用户实例        │
│  · 实例生命周期（拉起/健康检查/闲置休眠）        │
│  · 管理员后台 /admin                          │
│  · 审计日志                                   │
└──────┬──────────────┬──────────────┬────────┘
       ▼              ▼              ▼
  dsh 实例(alice)  dsh 实例(bob)   dsh 实例(carol)
  127.0.0.1:42001  127.0.0.1:42002 127.0.0.1:42003
  $DSH_HOME 独立    $DSH_HOME 独立   $DSH_HOME 独立
  systemd 沙箱      systemd 沙箱     systemd 沙箱
  （Linux 生产）     （Linux 生产）    （Linux 生产）
```

- 一个用户一个 `dsh web` 实例：独立 `$DSH_HOME`、独立回环端口。事件流、审批、设置、
  凭据随进程边界天然隔离，不依赖上游代码的任何过滤逻辑。
- 网关是唯一公网入口；实例只监听 127.0.0.1，无法绕过网关直连。
- Mac 开发环境：实例由网关以子进程方式拉起（无 systemd），目录强制缺席（仅开发用）。
- Linux 生产环境：实例是 systemd 模板单元 `harness@<user>.service`，目录强制由内核
  挂载命名空间实现（见 §7）。

## 3. 数据模型（网关 SQLite）

```sql
users(id, username UNIQUE, password_hash, display_name, role,  -- role: admin | user
      status,                 -- active | disabled
      home_path,              -- 专属主目录，开号时自动生成
      created_at, updated_at)                                   -- 端口只存 instances 表

groups(id, name UNIQUE, description, created_at)

group_members(group_id, user_id, PRIMARY KEY(group_id, user_id))

dir_grants(id,
      subject_type,           -- user | group
      subject_id,
      path,                   -- 绝对路径，存 realpath 规范化结果
      mode,                   -- ro | rw
      note, created_by, created_at)

auth_sessions(id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)

audit_log(id, ts, user_id, action,   -- login / logout / api / admin.* / instance.*
      method_path,            -- 如 POST /api/session.prompt
      status, ip, detail_json)

instances(user_id PRIMARY KEY, state,   -- stopped | starting | ready | stopping
      port, pid_or_unit, started_at, last_activity_at)
```

有效目录权限 = 用户自身 `dir_grants` ∪ 所属所有组的 `dir_grants` ∪ 专属主目录（恒为 rw）。
同一路径重叠时 rw 覆盖 ro。

## 4. 认证与会话

- 登录：用户名 + 密码。密码 argon2id 哈希；连续失败 5 次锁定 10 分钟（按用户+IP）。
- 会话：随机 256-bit token，SQLite 存哈希；Cookie `HttpOnly; Secure; SameSite=Lax`，
  滑动过期 7 天，绝对上限 30 天。登出即吊销。
- CSRF：SameSite=Lax 为主；网关对所有非 GET 请求校验 `Origin` 必须等于公网域名。
- 管理员由 `users.role = admin` 标识；`/admin` 与管理 API 仅 admin 可达。
- 账号由管理员创建（内部系统，无自助注册）；初始密码首登强制修改。
- 预留：企微扫码 SSO 作为 Phase 3 登录方式插槽（`auth_provider` 字段预留）。

## 5. 反向代理与路由

- 路由规则：`Cookie → user → instances[user].port`，全部路径原样转发到该实例；
  所有用户共享同一公网域名，无路径前缀改造（每人只会到达自己的实例）。
- 头改写（关键决策）：网关校验完 `Origin` 后，把上游请求的 `Host` 与 `Origin`
  统一改写为 `127.0.0.1:<port>`。这样实例内置的浏览器信任栅栏视之为回环同源：
  普通 API 与特权 API（settings/credentials 等 PRIVILEGED_METHODS）都对"本人"可用——
  语义正确，因为每个实例本来就是单用户的。DNS 重绑定防御改由网关的 Origin 校验承担。
- WebSocket：`/api/events.mux`、`/api/events.host` 的 Upgrade 同样代理并做同样的头改写。
- 实例未运行时：返回等待页并触发拉起，就绪后自动跳转（轮询 `/` 返回 200 判定就绪，
  实测冷启动 3-5 秒）。
- 网关自身路径：`/login`、`/logout`、`/admin/**`、`/healthz` 保留，不转发。

## 6. 实例生命周期

- 开号（管理员创建用户时自动完成）：
  1. 创建 `/srv/harness/users/<user>/{home,dsh}`（Mac 开发环境为 `~/harness-users/<user>/…`）；
  2. 分配端口（42000 起递增，落库）；
  3. 生成 systemd 单元 drop-in（目录授权，见 §7）；
  4. 首次登录时拉起实例。
- 启动：Linux `systemctl start harness@<user>`；Mac 子进程
  `node --import tsx/esm apps/cli/src/bin.ts web --port <port>`（或生产构建产物）。
  就绪判定：HTTP 200。
- 闲置休眠：任何被代理的请求/存活的 WS 连接刷新 `last_activity_at`；空闲超过 30 分钟
  （可配）自动停止实例。会话数据在磁盘，无损失；下次登录重新拉起。
  内存账本：单实例实测约 180-250MB；几十人配休眠策略后，并发活跃 10-15 人
  约 2-4.5GB，当前 7.8GB 内存的服务器可承载；如需全员常驻则升配内存。
- 升级 dsh：构建一次 → 滚动重启实例（逐个 stop/start）。上游破坏性变更只影响构建，
  不影响网关。
- 资源限额：每单元 `MemoryMax=1G`、`CPUQuota=100%`（可按用户级别调整）。

## 7. 目录权限强制（核心）

### Linux 生产：systemd 挂载命名空间（内核级，读+写都强制）

模板单元 `harness@.service` + 每用户 drop-in `harness@<user>.service.d/50-grants.conf`，
由网关根据 `dir_grants` 生成：

```ini
[Service]
User=harness-<user>                    # 每用户一个系统账号（纵深防御）
Environment=DSH_HOME=/srv/harness/users/<user>/dsh
WorkingDirectory=/srv/harness/users/<user>/home
ExecStart=/usr/local/bin/node <dsh入口> web --port <port>

# 基线：整个文件系统只读；系统路径可读可执行但不可写
ProtectSystem=strict
NoNewPrivileges=yes
PrivateTmp=yes

# 互相不可见：用户目录根整体遮蔽，只把本人目录绑回来
TemporaryFileSystem=/srv/harness/users:ro
BindPaths=/srv/harness/users/<user>

# 目录授权（由 dir_grants 生成）：
BindPaths=/data/team-alpha                 # rw 授权
BindReadOnlyPaths=/data/company-docs       # ro 授权

# 隐藏宿主敏感区
ProtectHome=yes
InaccessiblePaths=-/srv/harness/gateway
```

性质：

- 强制作用于**整个进程树**——bash、文件工具、MCP 服务器、一切子进程；
- **读和写都受控**（弥补 dsh 沙箱只限写的缺口）；
- 用户在实例内切到 `danger-full-access` 只是关闭 dsh 自带沙箱，systemd 边界仍在；
- 授权变更 = 重新生成 drop-in + `systemctl daemon-reload` + 重启该实例（秒级）。

路径规范化：授权写入前 realpath 化；不解析授权目录内部的符号链接指向外部的情况——
内核以挂载命名空间为准，链接指向未授权路径时目标不可见，天然安全。

### Mac 开发：不做内核强制

开发环境单人使用，实例以子进程运行，仅逻辑上各用户独立 `$DSH_HOME`。文档与后台
明确标注"目录强制仅 Linux 生产生效"。

### 实例内的插件原生强制层（defense-in-depth，philosophy-native）

除内核层外，每个实例再加载一个树外插件 bundle `dsh-directory-guard`，把目录授权
变成 dsh 运行时内部的强制点。它遵循"挂扩展点不改 loop / 注册即可逆效果"的理念，
用文档明示的扩展点实现（架构文档 §"Where new behavior goes"、扩展手册权限门示例）：

- **`tools/pre-execute` 权限门**（扩展手册第 11–33 行的钦定写法）：监听该瀑布，对解析出
  绝对路径且落在授权根之外的 fs 类工具调用返回 `{ kind: 'deny', reason }`。这可靠覆盖
  结构化路径工具（`str_replace_editor`、`read`/`write`、`host.listDirectory` 等）。
- **`danger-full-access` 摘除**：实例 `cordis.patch.yml` 重述 `permission-presets` 表，
  受限用户的表里不出现该预设——纯配置，不改代码，关闭 in-app 提权到全盘的入口。
- **工作区默认根 = 用户主目录**：实例 `WorkingDirectory`/cwd 即用户 home，目录浏览器与
  `sandboxPolicy.resolve` 的 workspace 根随之落在主目录。
- **诚实的边界声明**：`tools/pre-execute` 无法解析 bash 内任意 `cd`/子命令的真实路径，
  因此 bash 执行面的读写边界由 sandbox（`ctx.sandbox`）与 Linux systemd 内核层兜底；
  hook 层负责工具参数面，内核层负责执行面，两层配合才完整。
- **授权来源**：网关拉起/重启实例时把该用户有效授权写入实例
  `$DSH_HOME/directory-grants.json`，插件以 config 路径读取（`cordis.patch.yml` 或
  `DSH_DIRECTORY_GRANTS` 环境变量），`ctx.effect` 注册、HMR 安全。
- **model-visible⟺logged**：拒绝以 tool 结果返回（已属 logged 的 `tool/result`）；若要把
  "可访问目录清单"提示给模型，用 `ctx.systemPrompt.section()` 每步重组，不新增 session 事件。

该 bundle 在 Mac 开发环境（无 systemd）就是唯一的目录强制层，因此它同时是开发期可用性
的关键，而非仅生产期的补充。仓库流程义务（`.agents/notes/` Agent Note、model-visible
行为的 keyless snapshot 测试、文档与代码同改）随该插件一并交付。

## 8. 管理员后台（/admin）

MVP 功能：

1. 用户：创建（自动建目录+分配端口+初始密码）、禁用/启用、重置密码、调整角色、
   查看实例状态（运行/休眠/内存）。
2. 组：创建、成员管理。
3. 目录授权：给用户或组添加/移除 `路径 + ro|rw`；变更后一键重启相关实例生效；
   路径存在性与 realpath 校验。
4. 实例：手动启/停/重启、查看端口与资源占用。
5. 审计：按用户/时间/动作筛选查询。

界面以服务端渲染的简单页面起步（内部工具，不引入前端构建链）。

## 9. 审计

- 网关记录：登录/登出/失败尝试、全部管理操作、被代理的 API 调用
  （user、`POST /api/session.prompt` 形态的方法路径、状态码、耗时、IP）。
- 不记录请求体（会话内容留在各实例的 `$DSH_HOME`，属用户数据）。
- SQLite 存储，超过 30 天的记录每日归档为 JSONL 文件；默认保留 180 天。

## 10. 模型凭据分发

- 管理员在后台配置公司级默认 `DEEPSEEK_API_KEY`；开号/重启实例时写入该实例
  `$DSH_HOME/.credentials.yaml`。
- 用户可在自己实例的 Settings 里覆盖为个人 Key（写的也是本实例文件，互不影响）。
- Phase 3 可选：网关统一代理 LLM 出口以实现集中计量。

## 11. 安全边界与已知限制

| 项 | 说明 |
|---|---|
| 网络出口未限制 | 实例内代码可访问任意网络（SSRF/外传可能）。Phase 3 可用 systemd `IPAddressDeny` + 允许列表或强制代理收口 |
| 网关是单点 | 网关很薄（无状态代理+SQLite），systemd 守护 + 秒级重启可接受；数据库定期备份 |
| 实例内 `danger-full-access` | 仅意味着关闭 dsh 自带沙箱；作用范围仍被 systemd 边界钳制在授权目录内 |
| Mac 开发环境无目录强制 | 仅开发用途，明确标注 |
| 审批/事件的隔离 | 由进程边界天然保证，无逻辑过滤代码，无对应泄漏面 |
| TLS | 由入口层（Cloudflare Tunnel / Nginx+证书）终结；网关 Cookie 标记 Secure |

## 12. 分阶段实施

### Phase 1 — 网关 MVP（Mac 开发环境）

范围：登录/会话/CSRF、SQLite 数据模型、HTTP+WS 反向代理与头改写、子进程实例管理
（拉起/就绪/休眠）、用户与目录授权的管理后台（先做用户 CRUD + 授权 CRUD）、基础审计。

验收：
- 两个测试账号在同一台 Mac 并行使用，会话/工作区/设置完全独立；
- 登录、登出、会话过期、失败锁定行为正确；
- WS 事件流经代理正常（聊天流式输出、审批弹窗可用）；
- 实例闲置自动休眠、再访问自动拉起。

### Phase 2 — Linux 生产与内核级目录强制

范围：systemd 模板与 drop-in 生成器、每用户系统账号、目录授权全链路（后台改授权 →
drop-in → 重启生效）、生产部署（TLS 入口、开机自启、备份脚本）、dsh 生产构建产物运行。

验收（全部用 shell 实测）：
- 实例内读未授权路径 → 不存在；写 ro 授权路径 → 失败；写 rw 授权路径 → 成功；
- 用户 A 的实例内看不到用户 B 的任何目录；
- 组授权：加入组后重启实例即可见共享目录，移出组后不可见；
- `danger-full-access` 下重复上述测试结论不变；
- 服务器重启后网关与常用实例自动恢复。

### Phase 3 — 增强（可选，按需排期）

企微扫码 SSO、用量报表、网络出口管控、集中 LLM 代理计量、产品内管理 UI
（dsh.client 树外插件）、实例内会话内容的管理员合规查询。

## 13. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 网关语言 | Node.js 22+ / TypeScript | 与 dsh 技术栈一致，团队现有 Node 运维经验 |
| Web 框架 | 原生 `node:http` + 少量辅助库 | 网关核心是代理与会话，避免重框架 |
| 代理 | `http-proxy`（含 WS） | 成熟、支持 upgrade 透传 |
| 存储 | `better-sqlite3` | 单机内部系统，零运维 |
| 密码 | `argon2` | 现代标准 |
| 进程管理 | systemd（Linux）/ child_process（Mac） | 见 §6、§7 |
| 代码位置 | 独立仓库 `harness-platform`（含 `gateway/`、`plugins/`、`docs/`），dsh 经 npm 进入 | 与上游源码物理隔离，`git pull` 上游与我们无关（详见 §15） |
| dsh 消费方式 | 钉死版本 npm 安装 `@deepseek-ai/dsh@<pinned>` | 升级=改版本号+滚动重启，无 merge 冲突（详见 §15） |
| dsh 内嵌插件 | 树外 bundle `dsh-directory-guard`（`plugins/` 下，`dsh.bundle` 声明） | philosophy-native，随实例 `--patch` 加载，不改上游 |

## 14. 与 dsh 插件架构的对齐（归属边界）

dsh 的核心理念是"一切皆插件、挂扩展点不改 loop、能力齐三角色、注册即可逆效果、
model-visible⟺logged"。本方案据此把职责严格分到两层，各归其位：

### 属于 dsh 外部（编排层，不是也不能是插件）

- 登录认证、会话 Cookie、反向代理、每用户进程监督、systemd 内核目录强制。
- 理由：一个 Cordis 插件只活在单个 dsh 进程内，无法监督兄弟进程、无法编程内核挂载
  命名空间。理念约束的是"如何扩展一个 dsh 运行时"，并未禁止在 dsh 外跑编排器。故网关
  外置是架构正确，而非理念违背。

### 属于 dsh 内部（`dsh-directory-guard` 树外插件，philosophy-native）

| 需求 | 扩展点 / 机制 | 理念依据 |
|---|---|---|
| 拒绝越权 fs 工具调用 | `ctx.on('tools/pre-execute')` 返回 `PreToolDecision.deny` | 架构文档"权限门"钦定写法，不改 loop |
| 关闭 in-app 全盘提权 | 实例 `cordis.patch.yml` 重述 `permission-presets` 表 | 纯配置层，patch 按 id 覆盖行 |
| 工作区默认根锁定 | 实例 cwd = 用户主目录 | 沿用现有 workspace/sandbox 根解析 |
| 把可访问目录喂给模型（可选） | `ctx.systemPrompt.section()` | 每步重组，天然满足 model-visible⟺logged |
| 授权数据接入 | 读 `$DSH_HOME/directory-grants.json`（网关写） | `ctx.effect` 注册，可逆、HMR 安全 |

### 为什么不做"单进程内认证插件替换 connection"

调研已确认：单进程多租户在当前架构上有硬缺口——`events.mux`/`events.host` 是全进程
广播、`/api/respond` 任意连接可应答他人审批、`$DSH_HOME` 全局单例、sandbox 只限写不限读。
把认证做成替换 `connection` 行的插件解决不了这些执行面与事件面的泄漏。每用户独立进程
用进程边界一次性消除全部泄漏面，且让 `dsh-directory-guard` 这个插件可以专注做"目录 ACL"
一件事——符合"小而清晰、单一职责"的设计取向。

### 流程义务（仓库规则，随插件交付）

- 非平凡改动 → 同 PR 附 `.agents/notes/` Agent Note；
- model/用户可见行为（拒绝、提示词段落）→ 同 PR 附 keyless snapshot 测试；
- 文档与代码同改；推送前按 `dsh-pre-push-checks` 选最小检查集。
- 网关代码在 `gateway/` 下、不触碰 `packages/`，因此不受上述 dsh 内规则约束；
  只有 `dsh-directory-guard` 作为 dsh 插件需遵守。

## 15. 上游同步策略（二开前必须定的地基）

上游 `deepseek-ai/deepseek-harness` 是快速迭代的 rc，明说会有破坏性变更、不留兼容
垫片（"foundation over blast radius"）。据此确立以下策略，使我们能"及时更新"而不被
上游重构反复撞伤。

### 15.1 消费方式：钉死版本的依赖，不是源码分叉

- 每个用户实例运行 npm 安装的 `@deepseek-ai/dsh@<pinned>`（应用目录 `package.json`
  锁定版本），不在我们仓库里 vendored dsh 源码。
- 一个顶层版本号锁定整个 `@deepseek-ai/dsh-*` 家族（同版本一起发布）。
- **升级 = 改一个版本号 + 滚动重启实例**，没有 merge、没有 rebase 冲突。
- 需要读源码时另开一次性 clone 只读参考，不作为运行依赖。
- 结论：拒绝 fork/submodule 承载运行时——它们把快速迭代的上游变成持续的合并负担，
  而我们的架构（外置网关 + 树外插件）根本不需要改 `packages/`。

### 15.2 代码归属：独立仓库，与上游物理隔离

- 新建 `harness-platform` 仓库：`gateway/`（编排层）、`plugins/dsh-directory-guard/`
  （dsh 插件）、`docs/`（本设计与计划）。dsh 通过 npm 进入。
- "上游 `git pull`"与我们无关——我们不托管上游源码，不存在冲突面。
- 当前工作区的 dsh clone 仅用于调研；实施启动时把我们的产物迁入独立仓库。

### 15.3 耦合面：全部收敛到一个小插件

- **网关对 dsh 零内部耦合**：只讲 HTTP/WS 到 `127.0.0.1:<port>` + spawn 进程；
  上游内部任何改动都不触及网关。
- **唯一耦合点是 `dsh-directory-guard`**：一个 `tools/pre-execute` hook + 一次
  grants 配置读 + 一段 `permission-presets` patch。
- 插件内所有对 dsh 内部类型（`PreToolDecision`、`ToolExecution`、
  `@deepseek-ai/dsh-tools` 等）的 import 收进**单个 adapter 文件**
  （`src/dsh-adapter.ts`），上游一次重命名只改一处。
- 优先用架构文档明示的稳定扩展点（"Where new behavior goes" 表、cordis 目录），
  避免依赖偶然内部实现；插件对 dsh 包声明 `peerDependencies`，范围跟随钉死版本。

### 15.4 升级门禁：契约/金丝雀测试 + 滚动 runbook

- **契约测试**（在 `harness-platform` 内）：用钉死版本启动 dsh + 我们的插件，断言
  扩展点行为仍成立——`tools/pre-execute` 越权拒绝生效、`permission-presets` 表形状
  未变、`directory-grants.json` 被读取。这是升级前的破坏探测器。
- **升级 runbook**：staging 改版本号 → 跑契约测试 + 网关 e2e（一个抛弃型用户）→
  全绿才滚动生产：逐个 `systemctl restart harness@<user>`（或停实例待其下次登录以新版
  拉起）。实例每用户、磁盘无跨用户状态耦合，滚动升级天然安全、可随时回滚版本号。
- **监控上游**：订阅 release/changelog；把每次 bump 当一次小迁移，以契约测试为门。
