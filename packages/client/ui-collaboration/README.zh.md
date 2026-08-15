# @deepseek-ai/dsh-client-ui-collaboration

[English](README.md) | 中文

Web 客户端的 Gateway 协作 UI。一个插件通过已有 Client slot 与会话创建 waterfall 事件，负责账户上下文 HTTP 状态、个人/项目 scope 选择器、根对话待用可见性、对话共享菜单，以及只读项目 composer 策略。

## 用户界面约定

- `sidebar.footer.action` 显示当前个人或项目运行时、可访问成员身份、`ro`/`rw` 模式，以及下一条根对话的 `project` 或 `private` 可见性。更改运行时 scope 会通过 `/account/api/scope` 持久化并刷新页面，使每条 Host 连接都指向所选运行时。
- `conversation.session.header.actions` 加载从根继承的访问权限、创建者、可见性、参与者数量和参与次数。创建者或组织管理员可以请求更改可见性；`visibility-locked` 响应会继续显示在菜单中。
- 高优先级 `conversation.composer` 注册为 `ro` 项目成员替换整个 composer，覆盖普通输入、审批和问答控件。`sessions/prepare-create` 也会在 RPC 分发前拒绝创建根会话。
- 新建 `rw` 项目会话流程会通过 `sessions/prepare-create` 传递待用可见性。复用空白候选项前，`sessions/confirm-blank-reuse` 会通过 Gateway 重新校验其根可见性，并且只接受完全匹配的候选项；不匹配时会用准备后的可见性创建新根会话。HTTP 响应在任何状态发布前都会于浏览器信任边界解码。
- 所有注册都是 effect，并会在卸载时完整清理。个人 scope 保留普通 Web UI，并清除项目对话详情状态。

## 模型体验

通过 scope、可见性与提交选择间接影响模型体验；Host 协作消费者执行这些选择，`dsh-collaboration-context` 记录模型可见参与者归属信息。

#### KV Cache 影响

UI 不组装模型请求；是否向请求后缀追加新的参与者上下文由对应 Host 消费者决定。

## 已知限制与延期工作

- **切换 scope 时整页刷新** — 个人和项目运行时使用独立 Host 连接与进程状态，因此切换不会保留当前页面草稿。
- **仅支持 Gateway 传输** — `/account/api/context` 缺失或失败时会隐藏协作控件，并保留普通个人 Web UI。
- **浏览器暂存创建可见性** — 页面加载后，下一条对话的选择默认恢复为项目公开；它不是账户偏好设置。
