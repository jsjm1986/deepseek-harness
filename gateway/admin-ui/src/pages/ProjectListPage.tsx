import { ArrowUpRight, Folder, FolderKanban, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { createProject, listProjects, type Project } from '../api.ts'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'

export function ProjectListPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [originFilter, setOriginFilter] = useState<'all' | 'admin' | 'user'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [createError, setCreateError] = useState('')
  const [name, setName] = useState('')

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setProjects(await listProjects(originFilter === 'all' ? undefined : originFilter))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [originFilter])

  useEffect(() => { void reload(true) }, [reload])

  function openCreate() {
    setCreateError('')
    setCreateOpen(true)
  }

  function closeCreate() {
    if (pending) return
    setCreateError('')
    setCreateOpen(false)
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setCreateError('')
    try {
      await createProject({ name: name.trim() })
      setName('')
      setCreateOpen(false)
      await reload()
    } catch (cause) {
      setCreateError(projectMessageFrom(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="项目"
        description="统一查看管理员发起和用户发起的工作空间，并配置成员权限。"
        meta={loading ? undefined : `${projects.length} 个项目`}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
      />
      <ErrorBanner message={error} />
      <div className="segmented" role="group" aria-label="项目来源筛选">
        <button type="button" aria-pressed={originFilter === 'all'} onClick={() => setOriginFilter('all')}>全部</button>
        <button type="button" aria-pressed={originFilter === 'admin'} onClick={() => setOriginFilter('admin')}>管理员发起</button>
        <button type="button" aria-pressed={originFilter === 'user'} onClick={() => setOriginFilter('user')}>用户发起</button>
      </div>
      <Section className="responsiveSection" title="项目目录" meta={loading ? undefined : `${projects.length} 条记录`}>
        {loading ? <LoadingState label="正在加载项目" /> : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="还没有项目"
            detail="管理员项目登记现有目录；用户项目由账户在受控项目根目录中创建。"
            action={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>来源 / 所有者</th>
                    <th>目录</th>
                    <th>成员</th>
                    <th aria-label="打开" />
                  </tr>
                </thead>
                <tbody>
                  {projects.map(project => (
                    <tr key={project.id}>
                      <td>
                        <Link className="projectLink" to={`/projects/${project.id}`}>
                          <Folder aria-hidden="true" />
                          <span>{project.name}</span>
                        </Link>
                      </td>
                      <td>
                        <div className="projectOriginCell">
                          <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? '用户发起' : '管理员发起'}</StatusBadge>
                          <span>{project.owner?.displayName || project.owner?.username || '组织管理'}</span>
                        </div>
                      </td>
                      <td><span className="pathText">{project.path}</span></td>
                      <td><StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{project.memberCount} 位成员</StatusBadge></td>
                      <td className="alignRight"><Link className="iconLink" to={`/projects/${project.id}`} aria-label={`打开 ${project.name}`} title="打开项目"><ArrowUpRight aria-hidden="true" /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {projects.map(project => (
                <Link className="mobileItem mobileProjectLink" key={project.id} to={`/projects/${project.id}`}>
                  <div className="mobileItemHeader">
                    <div className="projectIdentity">
                      <span className="itemIcon"><Folder aria-hidden="true" /></span>
                      <span><strong>{project.name}</strong><span>ID {project.id}</span></span>
                    </div>
                    <ArrowUpRight className="mobileChevron" aria-hidden="true" />
                  </div>
                  <div className="mobileItemBody">
                    <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? `用户发起 · ${project.owner?.displayName || project.owner?.username || '未知所有者'}` : '管理员发起'}</StatusBadge>
                    <span className="pathText">{project.path}</span>
                    <StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{project.memberCount} 位成员</StatusBadge>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </Section>

      <Dialog
        open={createOpen}
        title="新建项目"
        description="输入名称即可，Gateway 会自动创建项目目录。"
        onClose={closeCreate}
        footer={(
          <>
            <Button type="button" onClick={closeCreate} disabled={pending}>取消</Button>
            <Button type="submit" form="create-project-form" variant="primary" loading={pending}>创建项目</Button>
          </>
        )}
      >
        <form id="create-project-form" className="formGrid" onSubmit={event => void onCreate(event)}>
          <div className="formSpanFull"><ErrorBanner message={createError} /></div>
          <Field label="项目名称" hint="Gateway 会在项目根目录自动创建同名目录。" className="formSpanFull">
            <input className="input" required autoFocus value={name} onChange={event => { setName(event.target.value); setCreateError('') }} placeholder="例如：产品文档" />
          </Field>
        </form>
      </Dialog>
    </div>
  )
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function projectMessageFrom(cause: unknown): string {
  const message = messageFrom(cause)
  if (message === 'project-name-invalid') {
    return '项目名称不能为空，也不能包含路径分隔符。'
  }
  if (message === 'project-root-not-directory') {
    return '项目根路径不是目录，请检查 Gateway 配置。'
  }
  if (message === 'project-path-outside-root') {
    return '项目目录必须位于 Gateway 配置的项目根目录内。'
  }
  if (message === 'project-path-not-found') {
    return '目录不存在。请先在 Gateway 主机上创建该目录，再登记为项目。'
  }
  if (message === 'project-path-not-directory') {
    return '该路径不是目录。请填写 Gateway 主机上的现有目录。'
  }
  if (message === 'project-path-inaccessible') {
    return 'Gateway 无权访问该目录，请检查目录权限。'
  }
  if (message.startsWith('duplicate project name')) return '项目名称已存在。'
  if (message.startsWith('duplicate project path')) return '该目录已经登记为项目。'
  if (message.startsWith('path is a user ')) return '不能把用户主目录或 DSH 数据目录登记为项目。'
  return message
}
