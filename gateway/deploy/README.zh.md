# 生产部署手册

[English](README.md) | 中文

在 Linux 主机上以 systemd 内核约束上线网关，并把公网域名切换到它。全文使用的布局：网关代码在 `/srv/harness/gateway`，数据在 `/srv/harness/gateway-data`，用户目录在 `/srv/harness/users` 下，管理员登记的项目数据在 `/srv/harness/projects` 下，用户创建的项目数据在 `/srv/harness/projects/user-projects` 下，共享项目运行时 home 在 `/srv/harness/project-runtimes` 下，目录守卫在 `/srv/harness/plugins/dsh-directory-guard`，强制模型治理在 `/srv/harness/plugins/dsh-model-governance`。

## 前置条件

- 带 systemd 的 Linux、root 权限、Docker Compose、供一次性导入/回滚使用的 `sqlite3`，以及 Node 25（`/usr/local/bin/node`；nvm 布局需调整单元内路径）。创建共享项目单元使用的不可登录 `harness-project` 账户，创建各个 `HGW_PROJECT_PATH_ROOTS` 目录，并授予该账户这些根目录下每个项目目录所需的 Unix 读写权限。两个受控根都必须让后续创建的目录继承这份权限，例如执行 `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects`（无法使用组继承时改用等效默认 ACL）。setgid 父目录会让 Gateway 以 `0770` 创建的项目目录带上共享运行时组。
- 钉死版本的 dsh：`npm install -g @deepseek-ai/dsh@0.1.0-rc.5`（升级 = 改版本号 + 滚动重启，绝不检出源码）。注意：开发 clone 里未提交的本地工作（例如 UI 改动）在合入上游前不在 npm 发行版内。
- 公网域名的 DNS/入口控制权（Nginx 或 Cloudflare Tunnel）。

## 安装

在精确的发布 checkout 中执行 `pnpm install --frozen-lockfile && pnpm run build:production`。该生产入口会构建 Harness 库与 Web 应用、两个树外插件和 Admin SPA，对 Gateway 做类型检查，并在缺少任何 CLI、Web、Gateway、Admin、插件、管理员覆盖层或协作 migration 产物时拒绝发布。

1. 把构建完成的 `gateway/` 目录复制到 `/srv/harness/gateway`；用生产 Node 在该目录执行 `npm install && npm rebuild better-sqlite3 argon2`。`public/admin` 已被 gitignore，因此只能在 `build:production` 生成该目录后再从 checkout 复制。
2. 把构建完成的 `plugins/dsh-directory-guard/` 目录复制到 `/srv/harness/plugins/dsh-directory-guard`，把 `plugins/dsh-model-governance/` 复制到 `/srv/harness/plugins/dsh-model-governance`。钉死的 npm dsh 以纯 Node 运行插件 `lib/`，不使用 tsx。即使 `HGW_GUARD_PATCH=off`，模型治理仍是强制项。
3. 把公司默认凭据写入 `/srv/harness/gateway-data/company.env`（`DEEPSEEK_API_KEY=...`，权限 600）。每次运行时启动都会把它复制到 `$DSH_HOME/.env`；用户在 Settings 里设置的个人 key 存放于 `.credentials.yaml`，优先级更高，共享项目运行时则把凭据设置暴露为只读并使用公司来源。
4. 启动 [`deploy/postgres/`](postgres/README.md)，应用 migration，并创建权限为 `0600` 的数据库 URL 文件。在启动 Gateway 前，导入冻结的 SQLite 控制面，或创建配置的企业与计算节点。
5. 创建仅所有者可访问的 `/srv/harness/gateway-data/principal-keys` 和 `/srv/harness/gateway-data/runtime-credentials`，以及 `/srv/harness/project-runtimes` 和项目根目录。为两个受控根配置组继承，例如执行 `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects`；通过显式路径导入的目录仍需显式授予 `harness-project` 读写权限。把 `deploy/harness-gateway.service` 复制到 `/etc/systemd/system/`；调整数据库 URL 文件、`HGW_ORGANIZATION_SLUG`、`HGW_COMPUTE_NODE_NAME`、`HGW_PUBLIC_ORIGINS`、`HGW_PROJECT_PATH_ROOTS`、`HGW_PROJECTS_ROOT`、`HGW_USER_PROJECTS_ROOT`、项目运行时账户/根目录、principal/凭据目录、插件路径和其他宿主机路径，然后执行 `systemctl daemon-reload && systemctl enable --now harness-gateway`。
6. 数据库中没有用户时，首次启动会把引导管理员密码打进 journal：`journalctl -u harness-gateway | grep 'bootstrap admin'`。

## 每用户开号

在 `/admin` 创建用户，然后以 root 执行一次 `deploy/provision-user.sh <username>`：它创建 `harness-<username>` 系统账号并 chown `/srv/harness/users/<username>/{home,dsh}`。个人单元在每次启动时按该用户当前授权自动渲染。管理员发起的项目只凭名称创建，在 `HGW_PROJECTS_ROOT` 下得到 `0770` 受管目录；导入既有显式路径仍可用，并需显式授予 `harness-project` 访问权。用户发起的项目会在 `HGW_USER_PROJECTS_ROOT` 下创建空目录；前面的 setgid/默认 ACL 配置会让项目单元继承访问权，创建者成为 `rw` 所有者。两种来源都分配一个共享运行时，支持 `ro`/`rw` 邀请，并使用同一套对话与文件夹 scope。项目目录不能与用户数据、运行时数据、Gateway 目录或另一项目重叠。成员身份和个人目录权限写入会在需要时重启正在运行的个人运行时；项目 ACL 按请求检查，不要求重启共享运行时。管理员在个人和项目 scope 都保留 `danger-full-access` 预设，但项目运行时仍受内核项目路径约束。

## 数据库切换与回滚

最终导入前先停止现有 Gateway，防止任何 SQLite 写入与权威切换竞态。创建 SQLite 在线备份，把这份独立文件导入配置的 PostgreSQL 企业/节点，再运行 `pg:backup` 与 `pg:restore-check`。四项操作全部成功后才能启动 PostgreSQL Gateway。认证会话与 intake token 明确不在导入范围内，因此重新登录并重新投影实例策略是预期行为。

冻结的 SQLite 备份必须与切换前的精确 Gateway 产物一起保留。回滚会停止 PostgreSQL Gateway，恢复这两份产物，并且只启动 SQLite 版本。不得复制正在使用 WAL 的数据库、不得让两个版本同时运行，也不得尝试把 PostgreSQL 写入合并回 SQLite。PostgreSQL 保留用于诊断和后续干净切换。

## TLS 入口与切流

把公网域名指向网关，并关闭实例直连端口。Nginx server 块要点：

```nginx
server {
  listen 443 ssl;
  server_name harness.example.com;
  location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
```

切流清单：设置 `HGW_PUBLIC_ORIGINS=https://<域名>`（Secure Cookie 随之开启），把入口上游改为 `127.0.0.1:8899`，然后**停掉此前直接暴露的单个 dsh 实例**（或改绑回环）——切流后除 TLS 入口外任何来源都不得触达主机端口。

## 验收

- 网关行为：`HGW_ACCEPT_DATABASE_URL=postgresql://.../harness_accept bash scripts/accept-phase1.sh`（需要库名以 `_test`、`_accept` 或 `_acceptance` 结尾的临时 PostgreSQL 数据库；无需 API key）。
- 内核约束：以测试用户登录一次让单元启动，然后 `sudo bash scripts/accept-phase2.sh <user> <other-user> [ro-path] [rw-path]`——从挂载命名空间内部验证同伴不可见、自身主目录可写、`ProtectSystem`、ro/rw 授权语义。把会话切到 `danger-full-access` 后重跑：内核边界必须保持不变。
- 协作：让两个测试用户加入同一项目，验证共享历史与参与者归属；再把一位成员改为 `ro`，确认 composer 和直接 Host 写入/审批路径都拒绝；确认第二位成员看不到私密对话。
- 项目生命周期：从账户创建一个用户发起项目，接受邀请，并确认管理端项目列表能区分管理员发起和用户发起。分别以管理员进入个人和项目 scope，确认返回 `fullAccess`；确认普通成员不能通过 `/permission` 或新会话默认设置选择该预设。
- 重启韧性：`reboot` 后确认 `harness-gateway` 活跃，个人/项目登录都能重新到达可用运行时。

## macOS 变体（launchd，隧道入口）

macOS 主机（例如挂在 Cloudflare Tunnel 后面的办公机）以 `HGW_LAUNCHER=local` 运行同一网关，用 launchd 取代 systemd：`~/Library/LaunchAgents/com.maycran.harness-gateway.plist`（KeepAlive、RunAtLoad）在网关目录内执行 `node --import tsx/esm src/index.ts` 并带上 PostgreSQL 及其他 `HGW_*` 变量，隧道配置的 ingress 上游指向 `http://127.0.0.1:8899`。为 `HGW_PROJECT_RUNTIMES_ROOT`、`HGW_PRINCIPAL_KEY_DIR` 和 `HGW_RUNTIME_CREDENTIAL_DIR` 设置由 launchd 账户拥有的明确可写路径。macOS 上不存在内核目录约束：个人和共享项目进程依赖 directory-guard 插件与普通账户权限，因此 macOS 部署应视为受信团队形态，而非完整的 Phase 2 边界。切流时停用旧的直连 LaunchAgent（`launchctl bootout` 并重命名 plist，防止 RunAtLoad 再拉起）。

## 升级与备份

升级 dsh：先在 staging `npm install -g @deepseek-ai/dsh@<next>`，跑两个验收脚本和协作冒烟测试，然后逐个滚动生产运行时（`systemctl restart harness-<user>` / `systemctl restart harness-project-<id>`，或让闲置运行时在下次访问时使用新二进制）。升级网关：替换 `/srv/harness/gateway`、应用 PostgreSQL migration，再执行 `systemctl restart harness-gateway`（既有运行时保持运行，但涉及协议/包变化时需要滚动重启）。数据库：把 `deploy/postgres/backup-postgres.sh` 挂进 cron，保留经过恢复校验的 dump，并把成功备份复制到第二台机器或 NAS。
