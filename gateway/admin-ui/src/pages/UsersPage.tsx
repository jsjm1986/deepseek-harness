import {
  KeyRound,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Square,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  controlInstance,
  createUser,
  deleteUser,
  listUsers,
  patchUser,
  resetPassword,
  type AdminUser,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'

type UserRole = AdminUser['role']

type UserDraft = {
  username: string
  password: string
  displayName: string
  role: UserRole
}

const EMPTY_USER: UserDraft = {
  username: '',
  password: '',
  displayName: '',
  role: 'user',
}

export function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<UserDraft>(EMPTY_USER)
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<UserRole>('user')
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setUsers(await listUsers())
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void reload(true) }, [reload])

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    setPending(key)
    try {
      await action()
      await reload()
      return true
    } catch (cause) {
      setError(messageFrom(cause))
      return false
    } finally {
      setPending('')
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    const saved = await run('create', async () => {
      await createUser({
        username: createDraft.username,
        password: createDraft.password,
        role: createDraft.role,
        displayName: createDraft.displayName === '' ? undefined : createDraft.displayName,
      })
    })
    if (!saved) return
    setCreateDraft(EMPTY_USER)
    setCreateOpen(false)
  }

  function openEdit(user: AdminUser) {
    setEditTarget(user)
    setEditName(user.displayName)
    setEditRole(user.role)
  }

  async function onEdit(event: FormEvent) {
    event.preventDefault()
    if (editTarget === null) return
    const saved = await run(`edit:${editTarget.id}`, () => patchUser(editTarget.id, {
      displayName: editName,
      role: editRole,
    }))
    if (saved) setEditTarget(null)
  }

  async function onResetPassword(event: FormEvent) {
    event.preventDefault()
    if (passwordTarget === null) return
    const saved = await run(`password:${passwordTarget.id}`, () => resetPassword(passwordTarget.id, newPassword))
    if (!saved) return
    setNewPassword('')
    setPasswordTarget(null)
  }

  async function onDisable() {
    if (disableTarget === null) return
    const saved = await run(`status:${disableTarget.id}`, () => patchUser(disableTarget.id, { status: 'disabled' }))
    if (saved) setDisableTarget(null)
  }

  async function onDelete() {
    if (deleteTarget === null) return
    const saved = await run(`delete:${deleteTarget.id}`, () => deleteUser(deleteTarget.id))
    if (saved) setDeleteTarget(null)
  }

  return (
    <div className="page">
      <PageHeader
        title="用户管理"
        description="管理账号权限、登录状态和每位用户的独立 Harness 实例。"
        meta={loading ? undefined : `${users.length} 位用户`}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建用户</Button>}
      />
      <ErrorBanner message={error} />
      <Section className="responsiveSection" title="账号与实例" meta={loading ? undefined : `${users.length} 条记录`}>
        {loading ? <LoadingState label="正在加载用户" /> : users.length === 0 ? (
          <EmptyState
            icon={Users}
            title="还没有用户"
            detail="创建第一个账号后，可在这里配置角色并控制其 Harness 实例。"
            action={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建用户</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>角色</th>
                    <th>账号</th>
                    <th>实例</th>
                    <th>端口</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user.id}>
                      <td><UserIdentity user={user} /></td>
                      <td><RoleBadge role={user.role} /></td>
                      <td><AccountBadge status={user.status} /></td>
                      <td><InstanceCell user={user} pending={pending} run={run} /></td>
                      <td><span className="codeText">{user.port}</span></td>
                      <td>
                        <UserActions
                          user={user}
                          pending={pending}
                          onEdit={() => openEdit(user)}
                          onPassword={() => { setPasswordTarget(user); setNewPassword('') }}
                          onDisable={() => setDisableTarget(user)}
                          onDelete={() => setDeleteTarget(user)}
                          onEnable={() => { void run(`status:${user.id}`, () => patchUser(user.id, { status: 'active' })) }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {users.map(user => (
                <article className="mobileItem" key={user.id}>
                  <div className="mobileItemHeader">
                    <UserIdentity user={user} />
                    <AccountBadge status={user.status} />
                  </div>
                  <div className="mobileItemBody">
                    <dl className="definitionGrid">
                      <Definition label="角色"><RoleBadge role={user.role} /></Definition>
                      <Definition label="端口"><span className="codeText">{user.port}</span></Definition>
                    </dl>
                    <div className="mobileControlRow">
                      <InstanceState state={user.instanceState} />
                      <InstanceControls user={user} pending={pending} run={run} />
                    </div>
                    <UserActions
                      mobile
                      user={user}
                      pending={pending}
                      onEdit={() => openEdit(user)}
                      onPassword={() => { setPasswordTarget(user); setNewPassword('') }}
                      onDisable={() => setDisableTarget(user)}
                      onDelete={() => setDeleteTarget(user)}
                      onEnable={() => { void run(`status:${user.id}`, () => patchUser(user.id, { status: 'active' })) }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>

      <Dialog
        open={createOpen}
        title="新建用户"
        description="创建登录账号并分配初始管理角色。"
        onClose={() => { if (pending !== 'create') setCreateOpen(false) }}
        footer={(
          <>
            <Button type="button" onClick={() => setCreateOpen(false)} disabled={pending === 'create'}>取消</Button>
            <Button type="submit" form="create-user-form" variant="primary" loading={pending === 'create'}>创建用户</Button>
          </>
        )}
      >
        <form id="create-user-form" className="formGrid" onSubmit={event => void onCreate(event)}>
          <Field label="用户名" hint="用于登录，创建后不可修改。">
            <input className="input" required autoComplete="off" value={createDraft.username} onChange={event => setCreateDraft({ ...createDraft, username: event.target.value })} />
          </Field>
          <Field label="显示名">
            <input className="input" value={createDraft.displayName} onChange={event => setCreateDraft({ ...createDraft, displayName: event.target.value })} placeholder="可选" />
          </Field>
          <Field label="初始密码" className="formSpanFull">
            <input className="input" required type="password" autoComplete="new-password" value={createDraft.password} onChange={event => setCreateDraft({ ...createDraft, password: event.target.value })} />
          </Field>
          <Field label="角色" className="formSpanFull">
            <select className="select" value={createDraft.role} onChange={event => setCreateDraft({ ...createDraft, role: event.target.value as UserRole })}>
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        title={`编辑 ${editTarget?.username ?? ''}`}
        description="更新显示名和管理角色。"
        onClose={() => { if (!pending.startsWith('edit:')) setEditTarget(null) }}
        footer={(
          <>
            <Button type="button" onClick={() => setEditTarget(null)} disabled={pending.startsWith('edit:')}>取消</Button>
            <Button type="submit" form="edit-user-form" variant="primary" loading={pending.startsWith('edit:')}>保存更改</Button>
          </>
        )}
      >
        <form id="edit-user-form" className="formGrid" onSubmit={event => void onEdit(event)}>
          <Field label="显示名">
            <input className="input" value={editName} onChange={event => setEditName(event.target.value)} />
          </Field>
          <Field label="角色">
            <select className="select" value={editRole} onChange={event => setEditRole(event.target.value as UserRole)}>
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={passwordTarget !== null}
        title={`重置 ${passwordTarget?.username ?? ''} 的密码`}
        description="新密码会立即替换当前登录密码。"
        onClose={() => { if (!pending.startsWith('password:')) setPasswordTarget(null) }}
        footer={(
          <>
            <Button type="button" onClick={() => setPasswordTarget(null)} disabled={pending.startsWith('password:')}>取消</Button>
            <Button type="submit" form="reset-password-form" variant="primary" loading={pending.startsWith('password:')}>重置密码</Button>
          </>
        )}
      >
        <form id="reset-password-form" onSubmit={event => void onResetPassword(event)}>
          <Field label="新密码">
            <input className="input" required autoFocus type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} />
          </Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={disableTarget !== null}
        title="禁用用户"
        description={`禁用 ${disableTarget?.username ?? ''} 后，该账号将无法继续登录。`}
        confirmLabel="确认禁用"
        pending={pending.startsWith('status:')}
        onClose={() => { if (!pending.startsWith('status:')) setDisableTarget(null) }}
        onConfirm={() => void onDisable()}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除用户"
        description={`删除 ${deleteTarget?.username ?? ''} 后会立即撤销登录、停止实例并移除项目成员关系。审计、用量、协作会话和本地历史会保留，用户名不可复用；此操作不可恢复。`}
        confirmLabel="确认删除"
        pending={pending.startsWith('delete:')}
        onClose={() => { if (!pending.startsWith('delete:')) setDeleteTarget(null) }}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}

function UserIdentity({ user }: { user: AdminUser }) {
  const initial = (user.displayName || user.username).slice(0, 1)
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{initial}</span>
      <span className="identityText">
        <strong>{user.displayName || user.username}</strong>
        <span>@{user.username} · ID {user.id}</span>
      </span>
    </div>
  )
}

function RoleBadge({ role }: { role: UserRole }) {
  return <StatusBadge tone={role === 'admin' ? 'info' : 'neutral'}>{role === 'admin' ? '管理员' : '普通用户'}</StatusBadge>
}

function AccountBadge({ status }: { status: AdminUser['status'] }) {
  return <StatusBadge tone={status === 'active' ? 'success' : 'danger'}>{status === 'active' ? '正常' : '已禁用'}</StatusBadge>
}

function InstanceState({ state }: { state: string }) {
  const labels: Record<string, string> = {
    running: '运行中',
    starting: '启动中',
    stopping: '停止中',
    stopped: '已停止',
    failed: '异常',
  }
  const tone = state === 'running' ? 'success' : state === 'starting' ? 'info' : state === 'failed' ? 'danger' : state === 'stopping' ? 'warning' : 'neutral'
  return <StatusBadge tone={tone}>{labels[state] ?? state}</StatusBadge>
}

function InstanceCell({ user, pending, run }: UserOperationProps) {
  return (
    <div className="instanceBlock">
      <InstanceState state={user.instanceState} />
      <InstanceControls user={user} pending={pending} run={run} />
    </div>
  )
}

type UserOperationProps = {
  user: AdminUser
  pending: string
  run: (key: string, action: () => Promise<void>) => Promise<boolean>
}

function InstanceControls({ user, pending, run }: UserOperationProps) {
  const busy = pending.startsWith(`instance:${user.id}:`)
  return (
    <div className="compactActions" aria-label={`${user.username} 实例操作`}>
      <IconButton
        label="启动实例"
        icon={Play}
        disabled={busy || user.instanceState === 'running'}
        loading={pending === `instance:${user.id}:start`}
        onClick={() => void run(`instance:${user.id}:start`, () => controlInstance(user.id, 'start'))}
      />
      <IconButton
        label="停止实例"
        icon={Square}
        disabled={busy || user.instanceState === 'stopped'}
        loading={pending === `instance:${user.id}:stop`}
        onClick={() => void run(`instance:${user.id}:stop`, () => controlInstance(user.id, 'stop'))}
      />
      <IconButton
        label="重启实例"
        icon={RefreshCw}
        disabled={busy || user.instanceState !== 'running'}
        loading={pending === `instance:${user.id}:restart`}
        onClick={() => void run(`instance:${user.id}:restart`, () => controlInstance(user.id, 'restart'))}
      />
    </div>
  )
}

function UserActions({ user, pending, onEdit, onPassword, onDisable, onDelete, onEnable, mobile = false }: {
  user: AdminUser
  pending: string
  onEdit: () => void
  onPassword: () => void
  onDisable: () => void
  onDelete: () => void
  onEnable: () => void
  mobile?: boolean
}) {
  const statusPending = pending === `status:${user.id}`
  const deletePending = pending === `delete:${user.id}`
  if (mobile) {
    return (
      <div className="mobileActions">
        <Button icon={Pencil} onClick={onEdit}>编辑</Button>
        <Button icon={KeyRound} onClick={onPassword}>密码</Button>
        <Button
          variant={user.status === 'active' ? 'danger' : 'secondary'}
          icon={Power}
          loading={statusPending}
          onClick={user.status === 'active' ? onDisable : onEnable}
        >
          {user.status === 'active' ? '禁用' : '启用'}
        </Button>
        <Button variant="danger" icon={Trash2} loading={deletePending} onClick={onDelete}>删除</Button>
      </div>
    )
  }
  return (
    <div className="rowActions">
      <IconButton label="编辑用户" icon={Pencil} onClick={onEdit} />
      <IconButton label="重置密码" icon={KeyRound} onClick={onPassword} />
      <IconButton
        label={user.status === 'active' ? '禁用用户' : '启用用户'}
        icon={user.status === 'active' ? Power : UserRound}
        variant={user.status === 'active' ? 'danger' : 'ghost'}
        loading={statusPending}
        onClick={user.status === 'active' ? onDisable : onEnable}
      />
      <IconButton
        label="删除用户"
        icon={Trash2}
        variant="danger"
        loading={deletePending}
        onClick={onDelete}
      />
    </div>
  )
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
