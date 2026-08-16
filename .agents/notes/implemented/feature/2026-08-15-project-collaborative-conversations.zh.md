# Agent Note: 项目协作对话

Status: implemented

[English](2026-08-15-project-collaborative-conversations.md) | 中文

## 问题

Gateway 认证与运行时分配原本把一个已登录用户视为每个 Harness 进程和对话的唯一所有者。项目成员身份虽然授予文件系统访问权，但每个成员仍进入独立运行时并使用独立会话持久化，因此团队无法继续同一条 Agent 对话、查看共享历史，或共同回答待处理的审批和问题。若复用一个进程却没有请求绑定身份，情况会更糟：一条连接可能继承另一位用户的 authority，私密对话可能经列表或子会话泄露，并发的人类响应也可能同时到达 Agent。

## 决策

Gateway 为个人 scope 的每个用户分配一个运行时，并为每个项目分配一个共享运行时。认证账户通过 Gateway 选择当前 scope，Gateway 再把浏览器代理到对应运行时。每次代理的 HTTP 和 WebSocket 操作都携带一份短期 Ed25519 签名 principal，其中包含组织、用户、所选 scope、运行时 identity 和运行时 generation。`dsh-gateway-runtime` 在目标进程内验证该断言，并且只通过请求局部存储暴露它；私有 loopback 凭据提供运行时 bearer token 和验证密钥，不把任一秘密放入浏览器可见配置。

授权新鲜度按资源类型划分。根对话授权与可读会话筛选每次检查都会查询 PostgreSQL 中的当前组织角色与项目成员身份，因此移除成员、模式降级或管理员降级会影响下一次此类操作。不带 Session ACL 的 Host 操作使用签名 principal 中捕获的模式；旧模式最多可使用到该 principal 过期。Gateway 的交付默认有效期为 30 秒，每个被代理的 HTTP 请求都会获得新 principal，长连接 Host 与 Typert stream 会在 `expiresAt` 时关闭，以便重连取得当前权限。项目 scope 下的 Typert Remote 采用失败关闭：`goals/*` 需要对话写权限，`messageFeedback/list` 需要读权限，`messageFeedback/put` 与 `messageFeedback/delete` 需要写权限，所有未分类或进程级 Remote 都会被拒绝。

普通项目成员身份分为 `ro` 和 `rw`。组织管理员无需项目成员记录，就对每个活动项目拥有隐式 `rw` 权限。项目根对话可以是每位当前成员都可读的 `project`，也可以是只有创建者和当前管理员可读的 `private`。后代会话继承根的项目、创建者和可见性，不能定义更弱的 ACL。Gateway 会经根记录解析每次读取、写入、管理、审批和批量列表决定。具有 `rw` 成员身份的创建者或管理员可以改变可见性；其他用户参与过的项目公开对话不能再改为私密。仍拥有私密项目对话的成员不能被移除，直到该对话被共享或以其他方式删除。

项目 identity 明确记录 `origin` 与 `owner`：管理员发起的项目登记既有宿主机目录，用户发起的项目在 `HGW_USER_PROJECTS_ROOT` 下分配空目录。两种来源共用一个工作空间、一个共享运行时、一套成员表和一套对话模型；Admin API 通过来源筛选提供统一列表，并返回所有者/创建者元数据。用户所有者获得 `rw` 成员身份，可邀请活跃用户以 `ro` 或 `rw` 加入。邀请对发送者、接收者、项目所有者和管理员可见；接受操作是事务化的，过期状态会持久化，所有者不能被移除或降级到 `rw` 以下。SQLite→PostgreSQL 导入会根据企业与旧邀请 ID 派生稳定邀请 UUID，因此重复切库不会丢失待处理邀请。

管理员专用的 `danger-full-access` 预设只有在请求 principal 证明管理员身份后，才会在个人和项目 scope 中可用。`/permission` 命令与新会话默认路径共享同一个授权检查，普通成员不能通过设置获得该预设。在共享项目会话中，权限事件属于整个会话：管理员的选择会改变所有参与者看到的应用内预设，直到下一次获得授权的选择。项目 systemd 单元仍受项目路径约束，因此该预设不会授予项目目录之外的宿主机访问权。

协作是一项能力 seam：`dsh-collaboration` 定义请求捕获的 authority，`dsh-collaboration-gateway` 从经过认证的 Gateway 内部端点取得权威 ACL 决策，Host/会话消费方负责强制。Host 的列表和搜索会过滤不可读会话 id；打开、提示、恢复、fork、删除、导出、流、审批和问题操作都在观察或改变会话状态前授权。即使绕过浏览器 UI，Host 仍会强制 `ro` 成员身份。审批与问题响应在 PostgreSQL 中以组织、交互类型和交互 id 组成唯一键，因此只有一位参与者能提交共享响应。

项目运行时用 `dsh-session-persistence-gateway` 取代本地 JSONL 提供方。它保留标准 [`SessionPersistence`](../architecture/2026-06-14-session-persistence.md) coordinator 语义，同时通过私有 Gateway API 把 header 和完整事件存入 [JSONB 基线](../architecture/2026-08-14-postgresql-jsonb-gateway-baseline.md)引入的 PostgreSQL 对话 repository。写入 API 与提供方响应解码器只接受事件字段 `type`、`seq`、`time`、`data`、`surfaceOp`、`sourceEventSeqs` 和 `ignorable`；消息事件必须带有效 append 或精确 replace 操作，纯日志事件拒绝 surface 元数据。提供方只保留 coordinator 明确支持的 pre-react-loop `steering/message` 读取例外。创建根时记录已认证创建者和请求的可见性；注册子会话时复制已锁定的根 ACL。幂等 append 批次保持事件序列连续、崩溃修复和重试语义。个人运行时保留其配置的本地持久化和[按项目分组的会话目录](../architecture/2026-07-24-project-session-directories.md)行为。

每条获准的人类消息都会附上已认证项目参与者元数据，并存入普通 `user/message` source。`dsh-collaboration-context` 在 `agent/pre-step` waterfall 委托后，立即在该消息前插入一条持久、模型可见的元数据提示，因此模型能够区分贡献者，回放也能重建相同归属。PostgreSQL 从已提交事件投影参与者和贡献次数；后续账户或成员身份编辑不会重写历史归属。

`dsh-client-ui-collaboration` 负责浏览器 scope 选择器、新根对话可见性选择、对话可见性/创建者/参与者菜单，以及供 `ro` 成员使用的完整只读 composer 替换。它使用已有 Client slot 和 `sessions/prepare-create` waterfall，而不修改对话 shell。New Session 会在考虑空白候选项之前运行该 waterfall，随后 `sessions/confirm-blank-reuse` 会让插件通过 Gateway 重新校验候选项的根可见性；只有可见性完全匹配时才允许复用。切换 scope 会刷新页面，因为个人与项目 scope 指向不同 Host 进程。共享项目运行时把 Host 设置暴露为只读：设置消费方不会尝试修改，欢迎提示只在当前 Client 进程内保留确认，因此整页重新加载后会再次显示。浏览器控件只提供操作入口；签名 principal、Host 授权、内部 API 和 PostgreSQL 事务仍具有权威性。

Linux systemd 单元会先用只读临时文件系统遮蔽用户根、项目运行时根与所有已配置项目数据根，再仅回绑当前运行时 home、`$DSH_HOME` 和获准项目路径。`ProtectHome=tmpfs` 与不含 `CAP_SYS_ADMIN` 的 capability 集合会阻止实例通过 home 目录或挂载操作找回被隐藏的宿主目录树。管理员发起的项目会拒绝与用户、运行时数据、Gateway 目录或另一项目重叠的路径，并要求每个生产项目路径严格位于某个互不重叠的 `HGW_PROJECT_PATH_ROOTS` 条目之下。用户发起的项目在 `HGW_USER_PROJECTS_ROOT` 下分配，受控根必须为 `HGW_PROJECT_RUNTIME_USER` 继承组访问（例如 root 所有、setgid `2770` 的目录，或等效默认 ACL），保证新目录可被项目单元读写。共享单元不得以 root 运行。Gateway 启动会用 PostgreSQL advisory transaction lock 串行化节点本地端口分配，并从 `HGW_INSTANCE_PORT_BASE` 开始创建缺失的活跃项目运行时记录。

项目模型用量、intake 凭据、额度和阈值告警归属于共享项目运行时，而不是发送某条提示的成员。管理端项目详情要求明确选择继承普通成员额度，或使用项目独立 token 加公司成本额度，并使用与全局 Usage 视图相同的计量组件显示项目自然月用量。

删除项目时会先停止共享运行时，同时继续持有该运行时的串行实例操作槽，再删除 PostgreSQL 项目。外键级联会移除它的运行时行、成员与挂载、对话树与事件、参与者与交互记录、模型用量、额度与告警行、intake token 和内容文件元数据。项目目录本身永远不会被删除。

仓库生产入口 `pnpm run build:production` 会构建 Harness 库与 Web 应用、两个必需的树外插件和 Admin SPA，对 Gateway 做类型检查，并在发布树缺少任何必需的 CLI、Web、Admin、插件、管理员覆盖层或协作 migration 产物时拒绝发布。

## 验证

包测试覆盖 principal 与启动凭据验证、提供方 dispose、严格事件响应解码、根继承 ACL、参与者归属与 invariant、Gateway 持久化行为、Client 状态与组件行为、空白会话可见性兼容性、只读欢迎确认回退，以及 `ro` composer 替换。Gateway 测试覆盖 systemd 遮蔽与回绑、项目根校验、运行时写入 envelope 拒绝、配置端口解析，以及管理员访问尚未物化的私密根对话。Host/API Proxy 测试覆盖各类会话操作拒绝、可读列表过滤、参与者传播、根创建可见性，以及审批/问题原子抢占。真实 PostgreSQL 测试覆盖直到版本 5 的 migration、包含项目邀请的可重复 SQLite 导入、完整 JSON 事件往返、从空节点配置端口基准分配共享运行时、创建者/私密可见性、无项目成员记录时基于当前角色的管理员覆盖、子会话继承、贡献投影、成员移除保护、交互竞态、项目凭据、项目用量和显式项目额度模式。Gateway 与 permission 测试覆盖按来源筛选的 Admin 视图、用户项目与邀请生命周期、管理员在个人和项目 scope 中的 `fullAccess`，以及拒绝管理员专用的新会话默认值。无密钥组装态 Web 浏览器场景通过交付的 Client 组合覆盖项目 scope、可见性控件、参与者展示、拒绝不匹配空白会话与复用匹配空白会话、`ro` 体验和进程内欢迎确认。生产构建入口会在每个组件构建后验证完整运行时载荷。

## 曾考虑的替代方案

**把一条对话复制到每位成员的个人运行时。** 否决，因为副本会立即分叉，无法共享一项待处理交互，还会重复模型成本并失去唯一的仅追加事件顺序。

**保留一个项目运行时，但把当前用户存入进程全局变量。** 否决，因为并发 HTTP、WebSocket、stream 和后台操作会发生竞态，并可能把一位参与者的 authority 或归属应用到另一位参与者的请求。

**只在 Web UI 中强制协作规则。** 否决，因为直接 RPC 调用、陈旧客户端、重连和非可视消费方都能绕过它。UI 解释并阻止不可用操作，而 Host 与 Gateway 授权负责裁决。

**让每个后代会话拥有独立可见性。** 否决，因为共享根下的私密子会话或私密根下的共享子会话会让列表、fork、恢复和文本记录授权产生歧义。一份根 ACL 让整个对话树保持原子一致。

**接受每条审批或问题响应，再由事件顺序决定。** 否决，因为两位用户可能经不同连接发生竞态，并在任一方观察到另一方事件前同时提交。数据库抢占是提交点，后续响应会得到明确的已回答结果。

**把共享项目对话写入项目本地 JSONL 目录。** 否决，因为共享运行时需要集中授权、并发控制、可查询参与者、原子交互抢占和协调恢复。已有持久化接口允许使用 PostgreSQL 提供方，而不改变 Session 语义。

**用直接链接分享一条个人对话。** 否决，因为对话分享不能定义工作文件夹、运行时 identity、后代会话继承 ACL、邀请生命周期或项目级用量/治理。协作附着在拥有这些资源的项目上；项目内的单条对话仍可设置为项目公开或创建者私密。

**为管理员工作空间和用户工作空间维护两套数据模型。** 否决，因为两种来源需要相同的文件夹、运行时、成员和对话不变量。单一项目表加显式来源与所有者元数据既统一管理端视图，也保留工作空间由谁发起的信息。

## 后果

项目成员能在一棵持久对话树中协作，并获得明确可见性、认证参与者归属、共享审批/问题、共享模型计量，以及运行在项目文件系统上的单一运行时。私密项目对话对普通成员仍只向创建者开放，当前组织管理员保留完整访问权。Session ACL 检查会立即观察到项目成员身份与管理员角色变化；只依赖已捕获项目 scope 的操作受 principal 有效期限制，而不需等待运行时重启。

该设计使项目 scope 硬依赖 loopback Gateway 与 PostgreSQL；不存在离线 ACL 缓存或本地项目会话回退。切换 scope 会刷新浏览器，长连接必须在 principal 过期前重连，参与者 identity 是历史快照数据，其他贡献者参与后的项目公开对话不能改为私密。共享运行时中的权限选择属于会话全局，而文件系统约束仍按项目 scope 生效。受控文件夹需要宿主机组/默认 ACL 配置。个人对话及其本地持久化继续与项目协作分离。
