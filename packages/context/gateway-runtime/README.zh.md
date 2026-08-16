# @deepseek-ai/dsh-gateway-runtime

[English](README.md) | 中文

供 Gateway 启动的 Harness 运行时使用的认证请求上下文和私有 loopback 传输。启动凭据将进程绑定到一个组织、一个个人或项目运行时身份，以及用于验证短期浏览器 principal 的 Gateway 密钥。

## 运行时约定

- 启动凭据必须且只能从 `DSH_GATEWAY_CREDENTIAL_FD` 或 `DSH_GATEWAY_CREDENTIAL_FILE` 之一读取。它包含仅限 loopback 的 Gateway origin、运行时 bearer token、运行时 generation、组织和 Ed25519 公钥。
- `connection/request` 监听器要求 `x-dsh-gateway-principal`，验证其签名、有效期、组织、scope、运行时身份和 generation，再通过请求局部的 `current()` / `requireCurrent()` 暴露它。
- `request()` 只接受凭据 loopback origin 上的绝对 `/internal/runtime/` 路径，加入私有 bearer token，并且只在调用方明确要求时转发浏览器 principal。
- 凭据和 principal 断言在各自的解析与请求边界失败关闭。运行时 bearer token 不会通过公开服务字段暴露。

## 模型体验

没有影响，因为此包认证 Host 操作，不贡献模型输入、工具或文本记录行。

#### KV Cache 影响

此包不组装模型请求，也不改变已经可复用的前缀。

## 已知限制与延期工作

- **仅限 Gateway 启动的运行时** — 未提供有效私有启动凭据时加载插件会导致启动失败。
- **请求局部 principal** — `current()` 在认证 HTTP 或 WebSocket 操作之外不可用；生命周期超过分发过程的消费者必须捕获已验证 principal 或派生 authority。
- **短期断言** — Gateway 的交付默认值把 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 设为 30 秒。已验证 principal 会固定其项目 scope 模式直到 `expiresAt`；Session 消费方必须使用 `ctx.collaboration` 取得当前成员身份与 ACL 决定。Host 与 Typert stream 会在过期时关闭，而此包不会在已有连接内刷新断言。
