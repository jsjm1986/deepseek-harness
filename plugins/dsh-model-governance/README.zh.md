# dsh-model-governance

[English](README.md) | 中文

树外的每实例策略插件。它读取网关生成的 `model-governance.json`，发布普通对象形式的 `ctx.modelAccess` 服务，在适配器派发前强制检查每次 `llm/stream` 调用，并先将用量提交到崩溃安全的本地 outbox，再上报到 Bearer 鉴权的回环网关 intake。运行中的实例会监视策略文件的父目录，因此 Gateway 原子替换策略后无需重启实例即可生效。启动时策略缺失或格式错误会令插件激活失败；运行中替换为无效文件时会进入 fail-closed 状态，直到下一份有效策略到达。

编译后的 JavaScript 除 Node 内置模块外没有外部运行时 import，因此复制到生产目录的插件不会加载第二份 Cordis，也不依赖 workspace 解析。`@deepseek-ai/dsh-llm`、`dsh-agent` 与 `dsh-model-access` 是由宿主运行时提供的编译期契约。

策略与用量记录不包含 API Key、提示词或回复内容。凭据来源只是用于区分公司与个人成本的非秘密层标识。以 UUID 命名的 outbox 文件通过同目录 rename 提交，仅在 intake 成功响应后删除；intake 去重使重试安全。

## 模型体验

被禁止的路由在 provider 派发前以 `MODEL_FORBIDDEN` 结束 stream。发起 Agent 身份与显式 `sessionId` 不一致时以 `MODEL_ATTRIBUTION_CONFLICT` 结束。插件不添加任何提示词内容。

#### KV Cache 影响

无直接影响。

## 运行中策略重载

Gateway 会把完整策略写入临时文件，再 rename 到目标路径。插件监视父目录，在验证整份文档后替换不可变授权快照，并同时更新用量 intake 目的地。`llm/stream` 调用在准入时取得自己的快照，因此策略更新不会在已经运行的 stream 中途改变决定。运行中的策略文档缺失或无效时，新的模型请求会被拒绝；用量上报暂时继续使用最后一份有效策略中的 intake 目的地，直到新的有效文档发布。

## 已知局限与延后工作

- **额度只提示**——80%/100% 阈值提醒不会拒绝原本已授权的调用。
