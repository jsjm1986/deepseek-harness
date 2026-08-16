# @deepseek-ai/dsh-directory-guard

[English](README.md) | 中文

一个树外 dsh 插件 bundle，在 dsh 实例**内部**强制执行按用户的目录权限，是网关操作系统层（systemd）强制的 philosophy-native 对应层。见平台设计文档 §7 与 §14。

## 功能

- 注册一个 `tools/pre-execute` 监听器（文档钦定的"权限门"扩展点——不改 agent loop），**拒绝**解析到授权目录之外的文件系统工具调用。
- 通过 `cordis.patch.yml` 重述普通用户的 `permission` 预设表并**移除 `danger-full-access`**。网关管理的管理员会在其后追加 `cordis.admin.patch.yml`，恢复随产品交付的 Full access 预设。
- 停用 `directory-picker-auto` 并挂上 browse 的 Host/客户端组合，使公网域名上的浏览器得到应用内「选择工作区目录」对话框，而不是宿主桌面上的系统选文件夹框。

## 强制规则

授权是 `{ path, mode: 'ro' | 'rw' }` 条目，也可以带 `label`（browse 根列表的显示名）。强制只读 `path` 与 `mode`，忽略其余字段。普通用户的主目录恒为 `rw`；网关管理的管理员得到一条文件系统根目录的 `rw` 授权。对每个带已知路径参数的工具调用：

| 工具 | 路径参数 | 操作 |
|---|---|---|
| `read` | `file_path` | 读 |
| `write`、`edit` | `file_path` | 写 |
| `str_replace_editor` | `path` | `view` = 读；`create`/`str_replace`/`insert` = 写 |

- **写**目标不在任何 `rw` 授权内 → 拒绝。
- **读**目标在所有授权之外 → 拒绝。
- 路径先按会话 cwd 解析（缺省回退进程 cwd），再对最近存在的祖先做 `realpath`，以挫败符号链接逃逸。

## 边界（诚实声明）

本门覆盖上述**结构化路径 fs 工具**。它有意**不**解析 `bash`（任意 `cd`/命令）与 workspace/host API 面（`workspace.create`、`host.listDirectory`）。这些由以下层兜底：

- dsh 的 `ctx.sandbox` 层，以及
- **Linux 生产环境每实例的 systemd 挂载命名空间**约束（权威的读+写边界）。

macOS 开发环境（无 systemd）下，本插件是普通用户的主要目录强制层。管理员的根目录授权与 Full access 选择会有意开放 Gateway 进程账户能够访问的所有路径。

## 授权交接

网关在每次启动前把按角色解析的用户授权写入实例的 `$DSH_HOME/directory-grants.json`。插件在加载时读取一次 `$DSH_DIRECTORY_GRANTS`（或 `$DSH_HOME/directory-grants.json`）；任何授权或角色变更都会由网关重启实例，因此存活进程始终反映当前授权。

## 上游耦合（同步策略）

所有 dsh 内部类型导入（`Context`、`ToolExecution`、`PreToolDecision`）集中在单个文件 [`src/dsh-adapter.ts`](src/dsh-adapter.ts)。上游重命名只触及这一个文件。`src/grants.ts` 与 `src/guard.ts` 是纯 Node 逻辑，无 dsh 依赖，承载完整单元测试。

## 挂载方式

- **开发（源码工作区）：** 使包可解析（链接进 profile / 工作区 `node_modules`），然后带补丁启动：`pnpm dsh web --patch plugins/dsh-directory-guard/cordis.patch.yml`。
- **生产（钉死版本的 npm dsh）：** `dsh plugin --profile <name> add <本包>`，安装进 profile 并激活其 `dsh.bundle` 补丁。

不启动即可检查组合树：普通用户的 `cordis.patch.yml` 应显示 `directory-guard` 行及不含 `danger-full-access` 的 `permission` 表；继续追加 `cordis.admin.patch.yml` 后，该预设应恢复，同时保留 guard 与 browse 行。

## 测试

`npm test` 运行纯逻辑套件（`grants`、`guard`），外加钉住模型可见拒绝文案的快照（`guard.snapshot.spec.ts`）。`npm run typecheck` 对照构建出的 dsh 声明验证 dsh 类型接线。

## 待验证项（手动，需要模型/API key）

挂载本插件启动真实实例，端到端驱动一次被拒工具调用（agent 尝试写授权外路径 → 门返回拒绝结果）。与网关的双用户 e2e 属同一手动验收桶。
