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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [createError, setCreateError] = useState('')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setProjects(await listProjects())
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

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
      await createProject({ name: name.trim(), path: path.trim() })
      setName('')
      setPath('')
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
        description="按项目目录配置成员及其只读或读写权限。"
        meta={loading ? undefined : `${projects.length} 个项目`}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
      />
      <ErrorBanner message={error} />
      <Section className="responsiveSection" title="项目目录" meta={loading ? undefined : `${projects.length} 条记录`}>
        {loading ? <LoadingState label="正在加载项目" /> : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="还没有项目"
            detail="登记宿主机上的现有目录，然后为用户分配访问权限。"
            action={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>项目</th>
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
        description="项目路径必须是 Gateway 宿主机上已经存在的绝对目录。"
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
          <Field label="项目名称" className="formSpanFull">
            <input className="input" required autoFocus value={name} onChange={event => { setName(event.target.value); setCreateError('') }} placeholder="例如：产品文档" />
          </Field>
          <Field label="绝对路径" hint="该目录不会由管理端自动创建。" className="formSpanFull">
            <input className="input codeText" required value={path} onChange={event => { setPath(event.target.value); setCreateError('') }} placeholder="/srv/harness/projects/docs" />
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
