# Agent Note: dsh-directory-guard——实例内目录权限门

Status: implemented

[English](2026-08-14-directory-guard.md) | 中文

## Problem

公网化平台（网关 + 每用户一个 dsh 实例）需要在每个实例内部强制按用户的目录权限。内核边界（Linux systemd 挂载命名空间）覆盖整个进程树，但 macOS 开发环境没有它；即便有内核层，模型可见的提前拒绝也优于受限系统调用抛出的裸 EACCES。dsh 核心必须保持不改：平台以 npm 钉死版本消费 dsh，跟随快速迭代的上游而不做 fork。

## Decision

一个树外插件 bundle，位于 `plugins/dsh-directory-guard`（与 `gateway/` 并列的独立仓库区域，不在 `packages/` 下）。一个 `tools/pre-execute` 瀑布监听器拒绝规范化目标落在调用者授权之外的结构化路径 fs 工具调用（`read`、`write`、`edit`、`str_replace_editor`）——写需要 `rw` 授权，读需要任一授权；目标按会话 cwd 解析，并对最近存在的祖先做 realpath，使符号链接目录无法逃逸。授权来自 `$DSH_HOME/directory-grants.json`，由网关在每次实例启动前写入。bundle 的 `cordis.patch.yml` 同时重述 `permission` 预设表并移除 `danger-full-access`，关闭应用内关掉 dsh 沙箱的路径。网关的挂载方式是把包 symlink 进实例的 `$DSH_HOME/profiles/node_modules`，并把补丁复制为 `$DSH_HOME/cordis.patch.yml`——home 级用户层对每个 profile 生效且与启动 argv 形态无关，而 CLI launcher 对 argv 有约束（`--patch` 必须在应用 flag 之前）、钉死 npm 的生产命令则根本不带补丁 flag。所有 dsh 类型导入集中在一个适配文件（`src/dsh-adapter.ts`）；`grants.ts`/`guard.ts` 是纯 Node 逻辑。

## Boundary

本门只覆盖结构化路径 fs 工具。它不解析 `bash`（任意 `cd`/子命令）与 workspace/host API 面；这些由 `ctx.sandbox` 兜底，在 Linux 生产上由 systemd 挂载命名空间兜底——后者是整个进程树的权威读写边界。macOS 开发环境下本插件是唯一目录强制层，限定开发用途。

## Alternatives considered

- **以进程内插件替换 `connection` 实现认证/多租户**——被拒：`events.mux`/`events.host` 是全进程广播，`/api/respond` 允许任意连接应答任何审批，`$DSH_HOME` 是进程级单例，共享单实例无论加什么认证插件都会跨用户泄漏。每用户一进程一次性消除全部泄漏面，并让本插件只做一件事（完整调研归平台设计文档 §14 所有）。
- **fork dsh 在核心里强制授权**——被拒：平台以 npm 钉死 dsh 正是为了避免对拒绝兼容垫片的预发布上游持续合并。
- **经启动 argv `--patch` 挂载**——联调后被拒：dsh launcher 只在应用 flag 之前接受自己的 flag，且生产 npm 命令没有补丁 flag；home 级补丁层以与 argv 形态无关的方式表达同一 bundle 挂载。
- **实例内授权热重载**——暂拒：授权变更时网关直接重启实例（秒级），文件监听只会增加生命周期面而无用户可见收益。

## Consequences

每个实例统一携带守卫（配置的补丁文件缺失时 fail loud——无守卫启动比拒绝启动更糟，`HGW_GUARD_PATCH=off` 是显式关闭出口）。拒绝理由是模型可见的，并由快照规格（`tests/guard.snapshot.spec.ts`）钉住，改写文案必须是有意识的 diff。插件不拥有认证与内核边界；它是防御栈中的一层，对 bash 缺口保持诚实。网关的 home 层复制意味着插件补丁更新在实例下次重启时生效，而非实时。

## Testing

纯逻辑 vitest 套件覆盖授权加载/分类、路径规范化（symlink 与 `..` 逃逸）、每工具读写映射、fail-closed 的畸形参数，以及钉住的拒绝文案。网关验收脚本（`gateway/scripts/accept-phase1.sh`，macOS 上 23 项全绿）端到端验证挂载：home 补丁层写入、包已链接、启动前 grants 文件就位、组合树显示 `directory-guard` 行且 `danger-full-access` 缺席（`--dump-config`）。模型驱动的端到端拒绝（agent 尝试写授权外路径）仍在插件 README 记录的手动桶中——它需要真实 API key。
