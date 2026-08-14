# 网关 Phase 2（Linux 生产 + 内核级目录强制）实施计划

> 依据设计文档 §7、§12 Phase 2、§14。Phase 1（网关 MVP + dsh-directory-guard 插件）已合并。

**Goal:** 在 Linux 生产环境用 systemd 挂载命名空间对每个用户实例做**内核级目录强制**（读+写、覆盖整个进程树），并完成生产部署与滚动升级。

**Architecture:** 每个用户实例是一个 systemd 服务 `harness-<user>.service`，由网关根据用户的有效目录授权生成；`ProtectSystem=strict` 打底、`TemporaryFileSystem` 遮蔽全部用户目录、再用 `BindPaths`/`BindReadOnlyPaths` 精确放行本人 home 与授权目录。网关的实例编排在 Linux 走 `systemctl`，在 macOS 开发走子进程（Phase 1 已有）。

## 已完成（本次，可在 macOS 单测）

- `gateway/src/systemd.ts` — 纯函数 `renderUserUnit(user, grants, opts)`：把 `{path, mode}` 授权映射成完整 per-user 单元（安全关键映射），含路径安全校验（拒绝换行/冒号/相对路径）。
- `gateway/tests/systemd.spec.ts` — 8 个单测覆盖：内核加固指令、遮蔽+重绑、ro/rw 区分、gateway 目录不可达、per-user 账号/home/grants 文件、端口注入与资源限额、危险路径与非法用户名拒绝。

## 待做（需 Linux 主机验证）

### Task P2-1: Launcher 抽象
**Files:** `gateway/src/launcher.ts`, `gateway/tests/launcher.spec.ts`
- 抽出 `interface Launcher { start(user, grants): Promise<void>; stop(user): Promise<void>; isRunning(user): boolean }`。
- `LocalLauncher`：现有子进程逻辑（从 `InstanceManager` 提取），macOS 开发用。
- `SystemdLauncher`：`writeUnit`（`renderUserUnit` → `/etc/systemd/system/harness-<user>.service`）+ `systemctl daemon-reload` + `systemctl start/stop harness-<user>`。命令构造可单测（不执行）。
- `InstanceManager` 注入 `Launcher`（默认按 `process.platform` 选择或 `HGW_LAUNCHER=local|systemd`）。

### Task P2-2: per-user 系统账号 + 目录骨架
**Files:** `gateway/src/provisioning.ts`（Linux 分支）
- 开号时 `useradd --system harness-<user>`、建 `/srv/harness/users/<user>/{home,dsh}`、chown。
- 授权变更 → 重写 grants 文件 + 重写单元 + `daemon-reload` + `systemctl restart`（秒级生效）。

### Task P2-3: 生产部署
**Files:** `deploy/`（脚本 + README）
- TLS 入口（Cloudflare Tunnel 或 Nginx+证书）→ `127.0.0.1:<gateway port>`。
- 网关自身作为 systemd 服务开机自启；SQLite 定期备份。
- `dsh-directory-guard` 插件随实例 profile 安装（`dsh plugin add`）。

### Task P2-4: 内核强制端到端验收（Linux，shell 实测）
- 实例内读未授权路径 → 不存在；写 ro 授权 → 失败；写 rw 授权 → 成功。
- 用户 A 实例看不到用户 B 的任何目录。
- 组授权：加入组→重启→可见共享目录；移出→不可见。
- `danger-full-access`（若存在）下重复上述，结论不变（内核边界仍在）。
- 服务器重启后网关与常用实例自动恢复。

## 上游同步（§15）

生产实例运行钉死版本的 `@deepseek-ai/dsh`；`SystemdLauncher` 的 `ExecStart` 指向 npm 安装的 `dsh` 二进制（`{port}` 占位）。升级=改版本号→契约测试→滚动 `systemctl restart`。

## 执行说明

P2-1 的命令构造与 `systemd.ts` 可在 macOS 单测；P2-2/3/4 的真实 systemctl/useradd/挂载命名空间行为必须在 Linux 主机验证。建议在目标 Linux 服务器上按 Task 顺序执行并用 shell 实测每条边界。
