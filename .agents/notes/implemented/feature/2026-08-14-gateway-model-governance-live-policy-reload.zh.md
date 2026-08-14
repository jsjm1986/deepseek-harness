# Agent Note: 模型治理策略在线重载

Status: implemented

[English](2026-08-14-gateway-model-governance-live-policy-reload.md) | 中文

## 问题

Gateway 会把每个用户验证后的模型策略投影到 `$DSH_HOME/model-governance.json`。此前树外 `dsh-model-governance` 插件只在激活时读取该文件，因此每次策略编辑都会停止并重启正在运行的用户实例，中断活动会话；全局模型编辑还会串行重启多个用户。

## 决策

插件使用 Node 内置 watcher 监视策略文件的父目录，因此可以观测原子 rename 替换而不增加运行时依赖。串行重载器验证完整文档后，替换一个不可变的 `ctx.modelAccess` 快照，并且只在验证成功后更新用量 outbox 的上报目的地。`llm/stream` 请求在准入时读取一个快照；后续策略编辑不会改变已经运行的 stream。运行中的策略文档缺失或格式错误时，新的模型请求进入 fail-closed 拒绝状态，而最后一份有效的 intake 目的地继续用于发送已排队用量记录。watcher 与 outbox 由同一个 Cordis effect 排空，watcher 注册后会再做一次对账以关闭初始竞态。

## 曾考虑的替代方案

**继续重启用户实例。** 对模型治理否决，因为策略授权不需要进程或内核挂载命名空间变化，重启会中断活动会话。目录授权单独保留重启语义，因为 Linux systemd 挂载命名空间必须重新创建单元才能改变权威文件系统边界。

**运行中无效替换时继续使用旧的有效策略。** 否决，因为继续按过期策略授权会掩盖管理员变更失败。Fail-closed 保留授权保证，并允许在下一份有效文档到达后恢复。

**加入文件 watcher 依赖。** 否决，因为树外插件有意只依赖 Node 内置模块即可部署；使用 `node:fs` 监视父目录已经覆盖 Gateway 的原子 rename 协议，不需要额外运行时包。

## 后果

模型策略和 intake token 变化不再要求重启正在运行的 DSH 实例。运行中的策略无效时，新的模型请求会暂时被拒绝，并输出诊断，直到有效文件发布。策略文件仍是跨进程交接的权威来源，Gateway 不需要第二条控制通道。watcher 只属于当前进程；插件卸载或实例重启后会重新创建。

## 测试

插件测试覆盖有效在线替换、无效替换后的 fail-closed 与恢复、watcher 初始化竞态、无关目录事件、watcher 错误和 dispose。该独立插件的类型检查与生产构建均已通过。
