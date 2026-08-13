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
  const groups = deps.grants.listGroups()
  const grants = deps.grants.listGrants()
  const userRows = users.map(u => `<tr>
<td>${escapeHtml(u.username)}</td><td>${u.role}</td><td>${u.status}</td>
<td>${u.instanceState} :${u.port}</td>
<td>
<form method="post" action="/admin/users/status" style="display:inline"><input type="hidden" name="id" value="${u.id}"><input type="hidden" name="status" value="${u.status === 'active' ? 'disabled' : 'active'}"><button>${u.status === 'active' ? '禁用' : '启用'}</button></form>
<form method="post" action="/admin/instances/stop" style="display:inline"><input type="hidden" name="id" value="${u.id}"><button class="danger">停实例</button></form>
</td></tr>`).join('')
  const groupRows = groups.map(g => `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.members.join(', '))}</td>
<td><form method="post" action="/admin/groups/delete" style="display:inline"><input type="hidden" name="id" value="${g.id}"><button class="danger">删除</button></form></td></tr>`).join('')
  const grantRows = grants.map(g => `<tr><td>${g.subjectType}#${g.subjectId}</td><td>${escapeHtml(g.path)}</td><td>${g.mode}</td>
<td><form method="post" action="/admin/grants/delete" style="display:inline"><input type="hidden" name="id" value="${g.id}"><button class="danger">删除</button></form></td></tr>`).join('')
  const userOptions = users.map(u => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join('')
  const groupOptions = groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')
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
<div class="card"><h2>组</h2><table><tr><th>组名</th><th>成员</th><th>操作</th></tr>${groupRows}</table>
<form method="post" action="/admin/groups"><input name="name" placeholder="组名" required><button>建组</button></form>
<form method="post" action="/admin/groups/members/add"><select name="groupId">${groupOptions}</select><select name="userId">${userOptions}</select><button>加入组</button></form>
<form method="post" action="/admin/groups/members/remove"><select name="groupId">${groupOptions}</select><select name="userId">${userOptions}</select><button class="danger">移出组</button></form></div>
<div class="card"><h2>目录授权</h2><table><tr><th>主体</th><th>路径</th><th>模式</th><th>操作</th></tr>${grantRows}</table>
<form method="post" action="/admin/grants">
<select name="subjectType"><option value="user">用户</option><option value="group">组</option></select>
<input name="subjectId" placeholder="主体ID" size="6" required>
<input name="path" placeholder="/绝对/路径" size="32" required>
<select name="mode"><option value="ro">只读</option><option value="rw">读写</option></select>
<button>添加授权</button></form>
<p class="muted">路径必须已存在；Phase 1 仅登记授权，Phase 2 在 Linux 生产由 systemd 强制，dsh-directory-guard 插件在实例内强制。</p></div>`)
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
      case '/admin/groups':
        deps.grants.createGroup(field('name'))
        write('admin.groups', { name: field('name') }); break
      case '/admin/groups/delete':
        deps.grants.deleteGroup(id())
        write('admin.groups.delete', { id: id() }); break
      case '/admin/groups/members/add':
        deps.grants.addMember(Number(field('groupId')), Number(field('userId')))
        write('admin.groups.members.add', { groupId: field('groupId'), userId: field('userId') }); break
      case '/admin/groups/members/remove':
        deps.grants.removeMember(Number(field('groupId')), Number(field('userId')))
        write('admin.groups.members.remove', { groupId: field('groupId'), userId: field('userId') }); break
      case '/admin/grants': {
        const subjectType = field('subjectType') === 'group' ? 'group' : 'user'
        deps.grants.addGrant({ subjectType, subjectId: Number(field('subjectId')), path: field('path'), mode: field('mode') === 'rw' ? 'rw' : 'ro', createdBy: admin.id })
        write('admin.grants', { subjectType, subjectId: field('subjectId'), path: field('path'), mode: field('mode') }); break
      }
      case '/admin/grants/delete':
        deps.grants.removeGrant(id())
        write('admin.grants.delete', { id: id() }); break
      default:
        return false
    }
    redirect(res, '/admin')
    return true
  }
}
