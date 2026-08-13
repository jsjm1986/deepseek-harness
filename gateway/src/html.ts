export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}
main{max-width:960px;margin:48px auto;padding:0 24px}
.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:24px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 12px}
input,select{font:inherit;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;margin:4px 8px 4px 0}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer}
button.danger{background:#d70015}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e5ea}
.error{color:#d70015;margin:8px 0}.muted{color:#86868b;font-size:13px}
nav a{margin-right:16px;color:#0071e3;text-decoration:none}
</style></head><body><main>${body}</main></body></html>`
}

export function loginPage(error = ''): string {
  return layout('登录 - Harness', `<div class="card" style="max-width:380px;margin:80px auto">
<h1>DeepSeek Harness</h1>
${error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`}
<form method="post" action="/login">
<p><input name="username" placeholder="用户名" autocomplete="username" required style="width:100%"></p>
<p><input name="password" type="password" placeholder="密码" autocomplete="current-password" required style="width:100%"></p>
<p><button style="width:100%">登录</button></p>
</form></div>`)
}

export function passwordPage(error = ''): string {
  return layout('修改密码 - Harness', `<div class="card" style="max-width:380px;margin:80px auto">
<h1>请设置新密码</h1>
${error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`}
<form method="post" action="/account/password">
<p><input name="password" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" required style="width:100%"></p>
<p><button style="width:100%">保存并继续</button></p>
</form></div>`)
}

export function waitingPage(): string {
  return layout('正在启动 - Harness', `<meta http-equiv="refresh" content="2">
<div class="card" style="max-width:380px;margin:80px auto;text-align:center">
<h1>正在启动您的工作台…</h1><p class="muted">通常需要几秒钟，页面会自动刷新。</p></div>`)
}
