# @deepseek-ai/dsh-collaboration

[English](README.md) | 中文

经认证[项目协作](../../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md)的服务定义。消费者捕获一份绑定请求的 authority，而不是从进程全局服务读取可变账户状态。

## 运行时约定

- `capture()` 返回当前请求的认证参与者、断言过期时间、提供方生命周期信号、会话授权、批量可读性过滤，以及审批/问答原子抢占能力。
- `authorize()` 将每个后代会话解析到根对话，并返回从根继承的项目、可见性、创建者和 `ro`/`rw` 访问事实。
- `withSessionCreation()` 在异步创建操作中携带项目根对话的 `project` 或 `private` 可见性；`currentCreation()` 只在该操作内部暴露它。
- `CollaborationError` 为 RPC 和 HTTP 消费者保留稳定拒绝码。提供方无法确认成员身份、可见性或授权后端时会失败关闭。

## 模型体验

通过授权消费者间接影响模型体验；持久参与者归属信息由 `dsh-collaboration-context` 负责。

#### KV Cache 影响

服务定义不贡献请求 token，也不改变已经可复用的前缀。

## 已知限制与延期工作

- **可见性归根对话所有** — 后代会话不能拥有独立可见性；每次读取、写入、管理和审批决定都经根对话解析。
- **不提供成员变更 API** — 项目成员管理仍由 Gateway/管理端负责，不属于此服务定义。
- **一个生产提供方** — `dsh-collaboration-gateway` 是唯一随产品交付的提供方；替代部署必须实现全部 authority 操作，不能绕过单项检查。
