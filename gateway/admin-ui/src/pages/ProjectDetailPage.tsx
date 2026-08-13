import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  deleteProject,
  getProject,
  listUsers,
  removeMember,
  setMember,
  type AdminUser,
  type GrantMode,
  type ProjectDetail,
} from '../api.ts'

type MatrixMode = GrantMode | 'none'

export function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const projectId = Number(id)
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setError('invalid project id')
      return
    }
    try {
      const [nextProject, nextUsers] = await Promise.all([getProject(projectId), listUsers()])
      setProject(nextProject)
      setUsers(nextUsers)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => { void reload() }, [reload])

  async function applyMode(userId: number, mode: MatrixMode) {
    if (mode === 'none') {
      if (!confirm('确认移除该成员？')) return
      await removeMember(projectId, userId)
    } else {
      await setMember(projectId, userId, mode)
    }
    await reload()
  }

  async function onDelete() {
    if (!confirm('确认删除该项目？')) return
    try {
      await deleteProject(projectId)
      navigate('/projects')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const assigned = new Map((project?.members ?? []).map(member => [member.userId, member.mode]))

  return (
    <div className="card">
      <h1>{project?.name ?? '项目详情'}</h1>
      {project === null ? null : <p className="muted">{project.path}</p>}
      {error === '' ? null : <p className="error">{error}</p>}
      <h2>成员矩阵</h2>
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>无</th>
            <th>ro</th>
            <th>rw</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => {
            const mode: MatrixMode = assigned.get(user.id) ?? 'none'
            const name = `member-${user.id}`
            return (
              <tr key={user.id}>
                <td>{user.username}</td>
                {(['none', 'ro', 'rw'] as const).map(value => (
                  <td key={value}>
                    <input
                      type="radio"
                      name={name}
                      aria-label={`${user.username} ${value === 'none' ? '无' : value}`}
                      checked={mode === value}
                      onChange={() => {
                        void applyMode(user.id, value).catch(err => {
                          setError(err instanceof Error ? err.message : String(err))
                        })
                      }}
                    />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p>
        <button type="button" className="danger" onClick={() => void onDelete()}>删除项目</button>
      </p>
    </div>
  )
}
