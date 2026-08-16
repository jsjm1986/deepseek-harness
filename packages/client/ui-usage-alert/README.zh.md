# @deepseek-ai/dsh-client-ui-usage-alert

[English](README.md) | 中文

全局 Web shell 中的网关额度提醒。浏览器插件向 `shell.overlay` 贡献一个条目；apply 侧回调在挂载时读取一次经过认证的同源 `/account/api/usage` 汇总，展示组件只呈现网关已经计算并持久化的自然月 80%/100% 阈值事件。建议性读取失败不会影响 shell。

## 模型体验

无。本包只渲染账户用量元数据，不向模型输入贡献任何内容。

#### KV Cache 影响

无直接影响。

## 已知局限与延后工作

- **仅挂载时刷新**——标签页保持打开期间跨过的阈值会在下次页面加载后出现；网关始终是持久提醒的所有者。
