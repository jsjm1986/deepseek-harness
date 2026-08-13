import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserRow } from './auth.ts'
import type { GatewayDeps, GatewayHandlers } from './server.ts'
import { escapeHtml, layout } from './html.ts'

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

function overview(deps: GatewayDeps): string {
  const users = deps.users.list()
  const projects = deps.projects.list()
  const userRows = users.map(u => `<tr>
<td>${escapeHtml(u.username)}</td><td>${u.role}</td><td>${u.status}</td>
<td>${u.instanceState} :${u.port}</td>
<td>
<form method="post" action="/admin/users/status" style="display:inline"><input type="hidden" name="id" value="${u.id}"><input type="hidden" name="status" value="${u.status === 'active' ? 'disabled' : 'active'}"><button>${u.status === 'active' ? '禁用' : '启用'}</button></form>
<form method="post" action="/admin/instances/stop" style="display:inline"><input type="hidden" name="id" value="${u.id}"><button class="danger">停实例</button></form>
</td></tr>`).join('')
  const projectRows = projects.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.path)}</td><td>${p.memberCount}</td></tr>`).join('')
  return layout('管理后台 - Harness', `
<nav class="card"><a href="/admin">总览</a><a href="/admin/audit">审计</a><a href="/">返回工作台</a>
<form method="post" action="/logout" style="display:inline;float:right"><button>退出登录</button></form></nav>
<div class="card"><h2>用户</h2><table><tr><th>用户名</th><th>角色</th><th>状态</th><th>实例</th><th>操作</th></tr>${userRows}</table>
<h2 style="margin-top:24px">创建用户</h2>
<form method="post" action="/admin/users">
<input name="username" placeholder="用户名(小写字母数字-)" required>
<input name="password" placeholder="初始密码" required>
<select name="role"><option value="user">user</option><option value="admin">admin</option></select>
<button>创建</button></form></div>
<div class="card"><h2>项目</h2><table><tr><th>名称</th><th>路径</th><th>成员</th></tr>${projectRows}</table></div>`)
}

function auditPage(deps: GatewayDeps, limit: number): string {
  const rows = deps.audit.query({ limit }).map(r => `<tr>
<td>${new Date(r.ts).toISOString()}</td><td>${r.userId ?? ''}</td><td>${escapeHtml(r.action)}</td>
<td>${escapeHtml(r.methodPath)}</td><td>${r.status ?? ''}</td><td>${escapeHtml(r.ip)}</td></tr>`).join('')
  return layout('审计 - Harness', `<nav class="card"><a href="/admin">总览</a><a href="/admin/audit">审计</a></nav>
<div class="card"><h2>审计日志</h2><table><tr><th>时间</th><th>用户</th><th>动作</th><th>方法</th><th>状态</th><th>IP</th></tr>${rows}</table></div>`)
}

export function createAdminHandler(deps: GatewayDeps): NonNullable<GatewayHandlers['admin']> {
  return async (req: IncomingMessage, res: ServerResponse, admin: UserRow, pathname: string, body: string): Promise<boolean> => {
    const form = new URLSearchParams(body)
    const field = (name: string): string => form.get(name) ?? ''
    const id = () => Number(field('id'))
    const write = (action: string, detail: Record<string, unknown>) =>
      deps.audit.write({ userId: admin.id, action, detail: JSON.stringify(detail), ip: req.socket.remoteAddress ?? '' })

    if (req.method === 'GET') {
      if (pathname === '/admin') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(overview(deps)); return true
      }
      if (pathname === '/admin/audit') {
        const limit = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 200)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(auditPage(deps, limit)); return true
      }
      return false
    }

    if (req.method !== 'POST') return false
    switch (pathname) {
      case '/admin/users': {
        const role = field('role') === 'admin' ? 'admin' : 'user'
        await deps.users.create({ username: field('username'), password: field('password'), role })
        write('admin.users', { username: field('username'), role }); break
      }
      case '/admin/users/status': {
        const status = field('status') === 'disabled' ? 'disabled' : 'active'
        deps.users.setStatus(id(), status)
        if (status === 'disabled') await deps.instances.stop(id())
        write('admin.users.status', { id: id(), status }); break
      }
      case '/admin/users/role':
        deps.users.setRole(id(), field('role') === 'admin' ? 'admin' : 'user')
        write('admin.users.role', { id: id(), role: field('role') }); break
      case '/admin/users/reset-password':
        await deps.users.resetPassword(id(), field('password'))
        write('admin.users.reset-password', { id: id() }); break
      case '/admin/instances/stop':
        await deps.instances.stop(id())
        write('admin.instances.stop', { id: id() }); break
      case '/admin/instances/restart': {
        await deps.instances.stop(id())
        const target = deps.users.getById(id())
        if (target !== null) await deps.instances.ensureRunning(target)
        write('admin.instances.restart', { id: id() }); break
      }
      default:
        return false
    }
    redirect(res, '/admin')
    return true
  }
}
