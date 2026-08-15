# @deepseek-ai/dsh-session-persistence-gateway

[English](README.md) | 中文

共享项目运行时使用的 Gateway PostgreSQL `SessionPersistence` 提供方。此提供方保留标准 `PersistenceCoordinator` 生命周期，并通过认证 Gateway 内部 API 传输存储的 header/event、revision、幂等追加批次和崩溃修复提交。

## 持久化约定

- 项目运行时组合会停用 `session-persistence-jsonl` 并挂载此提供方。个人运行时保留普通持久化提供方。
- 创建新根对话会捕获请求 principal，以及 `dsh-collaboration` 提供的 `project` 或 `private` 可见性；首次物化 append 会把两者连同会话 header 发出。Gateway repository 会把后代登记到已存储的根对话下。
- append 与 repair 批次 id 是操作类型、会话 id 和载荷的确定性哈希。Gateway/PostgreSQL 去重使重试保持幂等，同时不会抑制不同批次。
- 每份响应进入 Session store 前都会验证。此提供方通过共享 coordinator 支持完整加载、非变更 inspect、revision 检查、尾部读取、snapshot、批量 append、flush 和恢复。
- `locate()` 返回 `undefined`，且 `supportsRawArtifacts` 为 false，因为 PostgreSQL 不拥有独立本地文本记录文件。

## 配置

- `preparedSessionCacheSize` — coordinator 保留的冷 preparation 正数数量；默认 `5`。
- `writeBatchMaxDelayMs` — 正数固定批处理窗口；默认 `200`，上限为共享最大定时器延迟。
- `requestTimeoutMs` — 单次 Gateway 内部请求的正数期限；默认 `30000`。

## 模型体验

### 恢复共享对话历史

#### 模型看到的内容

此提供方不贡献实时提示文本。加载项目对话会重建与其他持久化提供方相同的持久 `SessionEvent` 历史和崩溃修复结果，包括日志中已经保存的参与者归属信息。

#### Token 影响

除保留历史和共享持久化恢复结果外，实时请求 token 为零。

#### KV Cache 影响

此提供方不重写有效历史。当重建前缀、当前 envelope 和 route 一致时，恢复可以复用提供方缓存；新提交事件追加到后缀。

## 已知限制与延期工作

- **依赖 Gateway** — 冷读取、写入、flush 和恢复都要求 loopback Gateway 与 PostgreSQL；没有本地回退。
- **没有原始 artifact 路径** — 调用方不能通过 `locate()` 打开或导出每会话文件。
- **请求生命周期有界** — Gateway 内部调用超过 `requestTimeoutMs` 会失败；coordinator 保留普通重试/恢复责任，不会把超时写入当成从未发生。
