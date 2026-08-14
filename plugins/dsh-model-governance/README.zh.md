# dsh-model-governance

[English](README.md) | 中文

树外的每实例策略插件。它读取网关生成的 `model-governance.json`，发布普通对象形式的 `ctx.modelAccess` 服务，在适配器派发前强制检查每次 `llm/stream` 调用，并先将用量提交到崩溃安全的本地 outbox，再上报到 Bearer 鉴权的回环网关 intake。策略缺失或格式错误会令插件激活失败，不会回退为全部允许。

编译后的 JavaScript 除 Node 内置模块外没有外部运行时 import，因此复制到生产目录的插件不会加载第二份 Cordis，也不依赖 workspace 解析。`@deepseek-ai/dsh-llm`、`dsh-agent` 与 `dsh-model-access` 是由宿主运行时提供的编译期契约。

策略与用量记录不包含 API Key、提示词或回复内容。凭据来源只是用于区分公司与个人成本的非秘密层标识。以 UUID 命名的 outbox 文件通过同目录 rename 提交，仅在 intake 成功响应后删除；intake 去重使重试安全。

## 模型体验

被禁止的路由在 provider 派发前以 `MODEL_FORBIDDEN` 结束 stream。发起 Agent 身份与显式 `sessionId` 不一致时以 `MODEL_ATTRIBUTION_CONFLICT` 结束。插件不添加任何提示词内容。

#### KV Cache 影响

无直接影响。

## 已知局限与延后工作

- **策略通过重启生效**——网关重写策略，并只重启已经运行的受影响实例；没有在线策略订阅。
- **额度只提示**——80%/100% 阈值提醒不会拒绝原本已授权的调用。
