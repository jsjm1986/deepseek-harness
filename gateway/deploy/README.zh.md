# 生产部署手册

[English](README.md) | 中文

在 Linux 主机上以 systemd 内核约束上线网关，并把公网域名切换到它。全文使用的布局：网关代码在 `/srv/harness/gateway`，数据在 `/srv/harness/gateway-data`，用户目录在 `/srv/harness/users` 下，守卫插件在 `/srv/harness/plugins/dsh-directory-guard`。

## 前置条件

- 带 systemd 的 Linux、root 权限、`sqlite3`、Node 25（`/usr/local/bin/node`；nvm 布局需调整单元内路径）。
- 钉死版本的 dsh：`npm install -g @deepseek-ai/dsh@0.1.0-rc.5`（升级 = 改版本号 + 滚动重启，绝不检出源码）。注意：开发 clone 里未提交的本地工作（例如 UI 改动）在合入上游前不在 npm 发行版内。
- 公网域名的 DNS/入口控制权（Nginx 或 Cloudflare Tunnel）。

## 安装

1. 把 `gateway/` 复制到 `/srv/harness/gateway`；用生产 Node 在该目录执行 `npm install && npm rebuild better-sqlite3 argon2`。`public/admin` 已被 gitignore，因此还须执行 `npm run build --prefix gateway/admin-ui`（在仓库根目录；复制之后则是 `npm run build --prefix admin-ui`），否则不会提供管理端 SPA。
2. 把 `plugins/dsh-directory-guard/` 复制到 `/srv/harness/plugins/dsh-directory-guard`；执行 `npm install --omit=dev && npx tsc -p tsconfig.build.json`（实例加载它构建出的 `lib/`；钉死的 npm dsh 以纯 Node 运行，没有 tsx）。
3. 把公司默认凭据写入 `/srv/harness/gateway-data/company.env`（`DEEPSEEK_API_KEY=...`，权限 600）。每次实例启动都会把它复制为该用户的 `$DSH_HOME/.env`；用户在 Settings 里设置的个人 key 存放于 `.credentials.yaml`，优先级更高。
4. 把 `deploy/harness-gateway.service` 复制到 `/etc/systemd/system/`，把 `HGW_PUBLIC_ORIGINS` 调整为真实 https 源以及有差异的路径，然后 `systemctl daemon-reload && systemctl enable --now harness-gateway`。
5. 首次启动会把引导管理员密码打进 journal：`journalctl -u harness-gateway | grep 'bootstrap admin'`。

## 每用户开号

在 `/admin` 创建用户，然后以 root 执行一次 `deploy/provision-user.sh <username>`：它创建 `harness-<username>` 系统账号并 chown `/srv/harness/users/<username>/{home,dsh}`。实例单元在每次启动时按该用户当前授权自动渲染。成员身份与权限写入会立即重启正在运行的实例。

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

- 网关行为：`bash scripts/accept-phase1.sh`（任意主机，23 项检查，无需 API key）。
- 内核约束：以测试用户登录一次让单元启动，然后 `sudo bash scripts/accept-phase2.sh <user> <other-user> [ro-path] [rw-path]`——从挂载命名空间内部验证同伴不可见、自身主目录可写、`ProtectSystem`、ro/rw 授权语义。把会话切到 `danger-full-access` 后重跑：内核边界必须保持不变。
- 重启韧性：`reboot` 后确认 `harness-gateway` 活跃，登录能重新到达可用实例。

## macOS 变体（launchd，隧道入口）

macOS 主机（例如挂在 Cloudflare Tunnel 后面的办公机）以 `HGW_LAUNCHER=local` 运行同一网关，用 launchd 取代 systemd：`~/Library/LaunchAgents/com.maycran.harness-gateway.plist`（KeepAlive、RunAtLoad）在网关目录内执行 `node --import tsx/esm src/index.ts` 并带上 `HGW_*` 变量，隧道配置的 ingress 上游指向 `http://127.0.0.1:8899`。macOS 上不存在内核目录约束——隔离只有每用户独立进程加 directory-guard 插件——因此 macOS 部署应视为受信团队形态，而非完整的 Phase 2 边界。切流时停用旧的直连 LaunchAgent（`launchctl bootout` 并重命名 plist，防止 RunAtLoad 再拉起）。

## 升级与备份

升级 dsh：先在 staging `npm install -g @deepseek-ai/dsh@<next>`，跑两个验收脚本，然后逐个滚动生产实例（`systemctl restart harness-<user>`，或让闲置实例在下次登录时用新二进制拉起）。升级网关：替换 `/srv/harness/gateway` 后 `systemctl restart harness-gateway`（实例保持运行）。数据库：把 `deploy/backup-sqlite.sh` 挂进 cron（每日，保留 30 份）。
