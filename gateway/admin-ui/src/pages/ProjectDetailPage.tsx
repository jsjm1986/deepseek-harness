import { ArrowLeft, Pencil, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteProject,
  getProject,
  listUsers,
  removeMember,
  renameProject,
  setMember,
  type AdminUser,
  type GrantMode,
  type ProjectDetail,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'

type MatrixMode = GrantMode | 'none'

export function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const projectId = Number(id)
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [removeTarget, setRemoveTarget] = useState<AdminUser | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const reload = useCallback(async (showLoading = false) => {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setError('项目 ID 无效')
      setLoading(false)
      return
    }
    if (showLoading) setLoading(true)
    try {
      const [nextProject, nextUsers] = await Promise.all([getProject(projectId), listUsers()])
      setProject(nextProject)
      setProjectName(nextProject.name)
      setUsers(nextUsers)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reload(true) }, [reload])

  const assigned = useMemo(() => new Map((project?.members ?? []).map(member => [member.userId, member.mode])), [project])

  async function applyMode(userId: number, mode: GrantMode) {
    setPending(`member:${userId}`)
    try {
      await setMember(projectId, userId, mode)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function confirmRemove() {
    if (removeTarget === null) return
    setPending(`member:${removeTarget.id}`)
    try {
      await removeMember(projectId, removeTarget.id)
      setRemoveTarget(null)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function onRename(event: FormEvent) {
    event.preventDefault()
    setPending('rename')
    try {
      await renameProject(projectId, projectName)
      setRenameOpen(false)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function onDelete() {
    setPending('delete')
    try {
      await deleteProject(projectId)
      navigate('/projects')
    } catch (cause) {
      setError(messageFrom(cause))
      setPending('')
    }
  }

  return (
    <div className="page">
      <Link className="breadcrumb" to="/projects"><ArrowLeft aria-hidden="true" />返回项目</Link>
      <PageHeader
        title={project?.name ?? '项目详情'}
        description={project?.path}
        meta={project === null ? undefined : `${project.memberCount} 位成员`}
        actions={project === null ? undefined : <Button icon={Pencil} onClick={() => setRenameOpen(true)}>重命名</Button>}
      />
      <ErrorBanner message={error} />
      {loading ? <Section><LoadingState label="正在加载项目" /></Section> : project === null ? (
        <Section><EmptyState title="无法加载项目" detail="请返回项目列表后重试。" /></Section>
      ) : (
        <>
          <Section className="responsiveSection" title="成员权限" meta={`${users.length} 位可分配用户`}>
            {users.length === 0 ? (
              <EmptyState icon={Users} title="没有可分配用户" detail="先在用户页面创建账号，再配置项目权限。" />
            ) : (
              <>
                <div className="tableWrap desktopOnly">
                  <table className="dataTable permissionTable">
                    <thead><tr><th>用户</th><th>账号</th><th>目录权限</th></tr></thead>
                    <tbody>
                      {users.map(user => {
                        const mode: MatrixMode = assigned.get(user.id) ?? 'none'
                        return (
                          <tr key={user.id}>
                            <td><MemberIdentity user={user} /></td>
                            <td><StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? '正常' : '已禁用'}</StatusBadge></td>
                            <td><PermissionControl user={user} mode={mode} pending={pending === `member:${user.id}`} onChange={value => changeMode(user, mode, value, setRemoveTarget, applyMode)} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mobileList">
                  {users.map(user => {
                    const mode: MatrixMode = assigned.get(user.id) ?? 'none'
                    return (
                      <article className="mobileItem" key={user.id}>
                        <div className="mobileItemHeader">
                          <MemberIdentity user={user} />
                          <StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? '正常' : '已禁用'}</StatusBadge>
                        </div>
                        <div className="mobileItemBody">
                          <span className="fieldLabel">目录权限</span>
                          <PermissionControl user={user} mode={mode} pending={pending === `member:${user.id}`} onChange={value => changeMode(user, mode, value, setRemoveTarget, applyMode)} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </Section>
          <div className="dangerZone">
            <div><strong>删除项目</strong><p>删除授权记录，不会删除宿主机上的项目目录或文件。</p></div>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>删除项目</Button>
          </div>
        </>
      )}

      <Dialog
        open={renameOpen}
        title="重命名项目"
        description="项目路径和成员权限不会改变。"
        onClose={() => { if (pending !== 'rename') setRenameOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={pending === 'rename'} onClick={() => setRenameOpen(false)}>取消</Button>
            <Button type="submit" form="rename-project-form" variant="primary" loading={pending === 'rename'}>保存名称</Button>
          </>
        )}
      >
        <form id="rename-project-form" onSubmit={event => void onRename(event)}>
          <Field label="项目名称"><input className="input" required autoFocus value={projectName} onChange={event => setProjectName(event.target.value)} /></Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除项目成员"
        description={`移除 ${removeTarget?.username ?? ''} 后，该用户将失去此项目目录的访问权限。`}
        confirmLabel="确认移除"
        pending={removeTarget !== null && pending === `member:${removeTarget.id}`}
        onClose={() => { if (!pending.startsWith('member:')) setRemoveTarget(null) }}
        onConfirm={() => void confirmRemove()}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除项目"
        description={`删除 ${project?.name ?? ''} 的授权记录？宿主机目录不会被删除。`}
        confirmLabel="确认删除"
        pending={pending === 'delete'}
        onClose={() => { if (pending !== 'delete') setDeleteOpen(false) }}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}

function MemberIdentity({ user }: { user: AdminUser }) {
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{(user.displayName || user.username).slice(0, 1)}</span>
      <span className="identityText"><strong>{user.displayName || user.username}</strong><span>@{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</span></span>
    </div>
  )
}

function PermissionControl({ user, mode, pending, onChange }: {
  user: AdminUser
  mode: MatrixMode
  pending: boolean
  onChange: (mode: MatrixMode) => void
}) {
  return (
    <div className="segmented permissionControl" aria-label={`${user.username} 目录权限`}>
      {([
        ['none', '无权限'],
        ['ro', '只读'],
        ['rw', '读写'],
      ] as const).map(([value, label]) => (
        <button key={value} type="button" aria-pressed={mode === value} disabled={pending} onClick={() => onChange(value)}>{label}</button>
      ))}
    </div>
  )
}

function changeMode(
  user: AdminUser,
  current: MatrixMode,
  next: MatrixMode,
  setRemoveTarget: (user: AdminUser) => void,
  applyMode: (userId: number, mode: GrantMode) => Promise<void>,
) {
  if (current === next) return
  if (next === 'none') {
    setRemoveTarget(user)
    return
  }
  void applyMode(user.id, next)
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
