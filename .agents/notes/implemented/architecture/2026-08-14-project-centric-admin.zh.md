# Agent Note: 项目制管理端的 browse 授权根与未授权工作区打开

Status: implemented

[English](2026-08-14-project-centric-admin.md) | 中文

## 问题

网关用户通过应用内目录浏览器在实例文件系统上添加工作区。默认列举若不知晓授权，对话框会从操作系统家目录起遍历整盘。管理员撤掉项目成员后，工作区菜单仍列出旧路径，`onPick` 仍会打开它，被撤权的项目会继续作为当前工作区，直到别处失败。

授权文件已带可选 `label` 供显示；[directory-guard](../feature/2026-08-14-directory-guard.md) 忽略未知字段，只按 `path`／`mode` 强制。独立 `dsh web` 没有授权文件，必须仍从操作系统家目录列举。

## 决策

browse 后端（`BrowseDirectoryPicker`）在构造时读取一次 `$DSH_DIRECTORY_GRANTS` 或 `$DSH_HOME/directory-grants.json`，路径与 directory-guard 相同。`loadGrantRoots()` 解析 JSON 数组，保留 `label` 作为列举行名称，忽略其余未知字段，对每条 `path` 做 `realpath`，目录已不存在的条目跳过。至少留下一条根时，无路径的 `list()` 返回第一条根的 `{ path, home }`、`crumbs: []`，以及全部根的 `entries`（`name = label || basename(path)`）。`list(path)` 与 `createDirectory` 在 `classify` 为 `none` 时抛 `directory-unreadable`／`directory-create-failed`（段感知前缀，与 guard 的 `contains` 相同）。根内路径的 crumbs 从该授权根起算。文件缺失、非数组 JSON、或有效列表为空时，保持操作系统家目录列举。

`WorkspacePickFlow.handleSelect` 对已有工作区调用可选的无路径 `listDirectory()`。空 crumbs 表示授权根列举：若 `workspace.path` 不是某根或其子孙，流程把 `menu.workspaceUnauthorized` 放到文件夹错误对话框且不 `onPick`。没有 `listDirectory`、`DirectoryBrowseError` 且 code 为 `directory-picker-unavailable`（native Host；生产仍会注入该回调）、或列举仍带祖先 crumbs（操作系统家目录），则跳过检查，以免独立 dsh web 拒绝工作区。并发点选递增 generation；较慢的未授权结果不得在随后的已授权 `onPick` 之后再打开对话框。该可选回调是 inject 成员，不改 SlotMap。`ui-workspace` 在 zh 与 en 注册 `menu.workspaceUnauthorized`。

相关所有者：[目录选择 seam](2026-07-28-directory-picker-capability-seam.md)、[directory-guard](../feature/2026-08-14-directory-guard.md)、[网关公网设置与 browse](2026-08-14-gateway-public-settings-and-browse.md)。

## 考虑过的替代方案

**新的 Host RPC 返回 `{ path, mode, label }[]`。** 否决：无路径的 `list()` 已到达客户端，第二条授权通道会与对话框正在展示的列举脱节。

**`BrowseDirectoryPicker.Config` 浏览根列表。** 否决：网关已写授权文件；第二份 Config 副本会在重启时不同步。

**扩大 directory-flow SlotMap** 带上授权根。否决：该检查属于点选菜单，不是占用方会话（`open`／`onPicked`）的一部分。

**始终用 `list()` 的 entries 栅栏点选。** 否决：独立操作系统家目录列举的 entries 是家目录的子项，会拒绝家目录自身或家目录之外的工作区——没有授权文件时不得出现这种回归。空 `crumbs` 是 browse 用来区分授权根列举的约定。

**从 `dsh-directory-guard` 导入 `loadGrants`。** 否决：该插件在树外，不是 host 包的 workspace 依赖；browse 必须保留 `label` 供显示，而 guard 会丢掉它。

## 后果

从会话选择器点选工作区时，若 inject 存在会发一次无路径的 `host.listDirectory`；授权根列举只有少量行，操作系统家目录列举可能很大，随后被栅栏忽略。native 的 `directory-picker-unavailable` 视为无栅栏并 `onPick`。`workspace.create` 仍接受任意路径——browse 与选择器检查只限定 UX 范围；安全边界仍是 directory-guard 与 systemd 挂载命名空间。browse 复制了一小段 contains／classify，而不是依赖树外插件。

## 测试

browse 的 `service.spec.ts` 写入带 `label`、垃圾条目和缺失目录的临时授权文件；`list()` 恰好是那两个根，`list('/etc')` 与 `createDirectory('/etc', …)` 抛错，crumbs 停在授权根，缺失／非数组文件仍列举 `homedir()`。directory-guard 的 `grants.spec.ts` 加载带 label 的 fixture，对授权外路径仍分类为 `none`。ui-workspace 选择器规格：`/revoked` 对照授权根 entries 不 `onPick` 并显示 `menu.workspaceUnauthorized`；根的子孙会 `onPick`；带 crumbs 的操作系统家目录列举跳过检查；省略 `listDirectory` 与注入的 `directory-picker-unavailable` 跳过栅栏并 `onPick`；较慢的未授权列举在随后的已授权点选之后不打开对话框。
