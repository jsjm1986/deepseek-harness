# Agent Note: Keep the absent composer document snapshot stable

Status: implemented

[English](2026-08-14-stable-absent-composer-document-snapshot.md) | 中文

## Problem

即使当前没有选中会话，session-maybe Composer 也必须提供 documents observable，这样会话切换前后的 hook 顺序才保持一致。原来的空源在每次 `getSnapshot()` 调用时都返回新数组。React 的 `useSyncExternalStore` 将这些读取视为持续变化，最终达到最大更新深度，slot 边界随即从页面移除了 Composer。

## Decision

`ui-conversation` 保存一个模块级空文档数组，让 absent source 始终返回同一个引用。真实会话继续使用各自的文档 store。inject 测试断言 absent source 的两次读取返回相同的数组引用。

## Alternatives considered

**直接返回内联空数组。** 否决，因为即使语义上都是空值，新引用仍违反 snapshot store 的约定。

**没有会话时不提供 documents hook。** 否决，因为打开会话后 Composer 的 hook 顺序会发生变化；保留一个不产生作用的 observable source 更可靠。

**通过 selector equality function 隐藏问题。** 否决，因为 source 本身仍然违反 `useSyncExternalStore` 约定，其他消费者也可能观察到不稳定快照。

## Consequences

当前没有会话以及切换会话时，Composer 都能保持挂载。共享空数组不会被修改；会话级文档更新仍限制在所属 store 内。

## Testing

conversation inject 测试覆盖 absent document source 的稳定引用。针对 conversation 的测试集已通过；重新构建的生产 Web bundle 已在运行中的本机实例上打开现有历史会话，Composer 输入框存在，控制台没有 React error 185。
