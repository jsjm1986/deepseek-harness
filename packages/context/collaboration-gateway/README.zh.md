# @deepseek-ai/dsh-collaboration-gateway

[English](README.md) | 中文

`dsh-collaboration` 服务定义的 Gateway 提供方。它从 `dsh-gateway-runtime` 派生参与者，将项目成员身份和根对话 ACL 决策委托给经认证的 Gateway 内部端点，并在向消费者发布前验证每个返回字段。

## 运行时约定

- `capture()` 将当前已验证 principal 固化为一份 authority，其参与者、过期时间和提供方生命周期在该请求或流操作期间保持稳定。
- 项目授权、可读会话过滤和交互抢占调用 `/internal/runtime/collaboration/*`，同时携带运行时 bearer token 与捕获的 principal。未知 HTTP 失败和格式错误的响应都会成为 `gateway-unavailable`。
- 个人 scope 将已有会话 id 视为可读并接受交互抢占；项目 scope 始终向 Gateway 请求权威结果。
- 创建项目根对话要求 `rw` 成员身份，并在请求的可见性下运行。个人创建直接通过，不附加项目元数据。
- 卸载提供方会中止其生命周期信号，并使每份已捕获 authority 在再次请求前失败关闭。

## 模型体验

通过面向模型操作的授权间接影响模型体验；参与者提示归属信息仍由 `dsh-collaboration-context` 负责。

#### KV Cache 影响

授权不贡献请求 token，也不改变已经可复用的前缀。

## 已知限制与延期工作

- **Gateway 可用性具有权威性** — 内部授权请求失败或返回无效 JSON 时，项目操作会被拒绝；不存在陈旧的本地 ACL 缓存。
- **按操作产生授权流量** — 会话操作和可见性过滤可能发出 loopback 请求；只有可读会话 id 支持批处理。
- **没有离线项目模式** — Gateway 或提供方不可用后，项目运行时无法继续执行协作授权。
