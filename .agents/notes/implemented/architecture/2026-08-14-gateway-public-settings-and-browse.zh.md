# Agent Note: 网关公网设置与应用内目录浏览

Status: implemented

[English](2026-08-14-gateway-public-settings-and-browse.md) | 中文

## 问题

隧道公网源（`harness.maycran.com`）上的浏览器用的就是操作者在 `127.0.0.1` 打开的同一单用户实例，但两处客户端检查把公网主机名当成未认证的局域网客户端。设置 scope 根据 `connection.isLoopback` 绑定 `memory` 持久化，因此插件配置、主题、语言、模型、凭据和权限行从不调用 `settings.describe`，渲染为空白。网关实例在带显示的机器上绑定 `127.0.0.1`，`directory-picker-auto` 会挂上系统选文件夹框；网关把 `Host`/`Origin` 改写成实例回环，于是 `host.pickDirectory` 成功，Finder 对话框开在宿主桌面上，另一台设备上的浏览器看不见。

## 决策

`SettingsScopeBinder.bind` 一律使用 Host 持久化。抛错或非 ok 的 `settings.describe` 发布 `unavailable`，卡片隐藏而不是停在 `loading`。Host `PRIVILEGED_METHODS` 栅栏不变：仍要求回环 `Host` 头。登录后的公网页能打通这些 RPC，靠的是网关既有的头改写。`settings.openDocument` 和 `host.openPath` 仍只在 loopback 页面出现，因为它们驱动的是宿主桌面。

directory-guard 的 home 补丁停用 `directory-picker-auto` 并插入 browse 的 Host/客户端组合，与 `apps/web/tests/pin-browse-picker.overlay.yml` 的 disable+insert 相同。每个网关拉起的实例因此提供应用内「选择工作区目录」对话框。不带该补丁的直接 `dsh web` 仍按绑定地址、SSH 和显示解析 `-auto`。

相关所有者：[directory-picker seam](2026-07-28-directory-picker-capability-seam.md)、[配置面边界](2026-07-30-config-plane-boundaries.md)、[Host 支撑的 Web 偏好](../bug-fix/2026-08-06-host-backed-web-preferences.md)、[产品 onboarding](../feature/2026-08-13-shared-modal-product-onboarding.md)。

## 考虑过的替代方案

**实例改听 `0.0.0.0`。** 否决：隧道已经打到 `127.0.0.1`，全接口绑定会把每用户实例端口暴露在网关旁边。

**把页面主机名当成回环，或把 `trustedHosts` 加入 `PRIVILEGED_METHODS`。** 否决：那会让没有登录的 `--trusted-host` 进程也能改设置和凭据。Host 栅栏保持；只是客户端不再拒绝调用。

**用环境变量或新的 auto Config 字段钉死 browse。** 否决：seam 已经写明直接组合 `-browse`，e2e overlay 也已经使用 disable+insert。

**同一进程上对本机用 native、对远程用 browse。** 否决：seam 已删除为此所需的线路通告，且网关实例没有可服务的本机桌面操作者。

## 后果

登录后的公网页可以配置插件、主题、语言、模型、凭据和权限预设，并可通过应用内目录浏览器在实例文件系统上添加工作区（仍受授权约束，Linux 上还有 systemd 挂载命名空间）。不经网关的直接 `--trusted-host` 仍会对特权方法返回 403。操作者必须重启每个网关实例，才会重新复制 home 补丁。代理以仍存活的子进程为准，而不是 `ready` 行：已退出的子进程会先显示等待页，再由 `ensureRunning` 拉起；只信数据库行会反代到死端口并返回 `instance-unreachable`。在宿主操作系统应用中打开产出文件或设置文档，仍是 loopback 页面上的手势。
