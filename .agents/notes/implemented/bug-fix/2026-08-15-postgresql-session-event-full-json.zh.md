# Agent Note: PostgreSQL Session Event 使用完整 JSON 存储

Status: implemented

[English](2026-08-15-postgresql-session-event-full-json.md) | 中文

## Problem

`SessionEvent.data` 可以包含任意 JSON 字符串，包括转义后的 NUL 字符。PostgreSQL `jsonb` 会把 JSON 字符串解码成其 text 表示，并以 SQLSTATE `22P05` 拒绝 `\u0000`。因此，一个有效 Session Event 会在模型轮次后让整批追加事务回滚；尽管该事件可由其他 SessionPersistence provider 正常序列化与回放，客户端仍会一直等待。

## Decision

Migration 4 把 `harness.conversation_events.event` 从 `jsonb` 转成 PostgreSQL `json`，Gateway appender 也把序列化事件转换为 `json`。PostgreSQL 仍会验证每个完整事件是合法 JSON，同时文本式 JSON 表示会保留转义 NUL，Node PostgreSQL driver 随后可将其解析回原始 JavaScript 值。

Migration 会移除 `conversation_events_tool_call`。该表达式索引会让任意事件 payload 经 PostgreSQL text 转换解析，因此可能再次触发同一拒绝。可查询的顺序、类型、时间、搜索文本、ACL 与参与者事实继续存放在专用列和投影表中；运行时代码不会通过已移除索引查询 tool call id。本决定只取代 [PostgreSQL Gateway baseline](../architecture/2026-08-14-postgresql-jsonb-gateway-baseline.md) 中事件列采用 JSONB 的选择。

## Alternatives considered

**持久化前替换 NUL 字符。** 否决，因为存储事件会与其他 provider 接纳的 Session Log 不同，回放和追加 checksum 将不再描述原始事件。

**在事件 payload 内加入自定义 sentinel 编码。** 否决，因为所有读取方与未来数据工具都必须为原本合法的 JSON 实现 Gateway 专用 codec。

**把事件存为不受约束的 text。** 否决，因为 PostgreSQL `json` 已能保留所需字符串取值域，同时继续提供数据库 JSON 校验和 driver 的常规 JSON 解析。

**保留 JSONB，并在编码前只抽取选定字段。** 否决，因为持久化层将拥有针对插件可扩展事件数据的持续变换，任何遗漏字符串都会恢复同一故障。

## Consequences

完整的共享项目事件会以原始 JSON 值往返，包括含 NUL 的字符串。事件 payload 不再用于任意 JSONB 表达式索引；持久查询改用固定 envelope 列与显式投影。PostgreSQL 集成覆盖会追加、读取并幂等重试一个包含真实 NUL 字符的事件，生产启动则会在接收流量前应用 migration 4。
