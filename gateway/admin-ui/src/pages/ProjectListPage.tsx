import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { createProject, listProjects, type Project } from '../api.ts'

export function ProjectListPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  const reload = useCallback(async () => {
    try {
      setProjects(await listProjects())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    try {
      await createProject({ name, path })
      setName('')
      setPath('')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="card">
      <h1>项目</h1>
      {error === '' ? null : <p className="error">{error}</p>}
      <form onSubmit={event => void onCreate(event)}>
        <h2>新建项目</h2>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="名称" required />
        <input value={path} onChange={e => setPath(e.target.value)} placeholder="路径" required />
        <button type="submit">创建</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>路径</th>
            <th>成员数</th>
          </tr>
        </thead>
        <tbody>
          {projects.map(project => (
            <tr key={project.id}>
              <td><Link to={`/projects/${project.id}`}>{project.name}</Link></td>
              <td>{project.path}</td>
              <td>{project.memberCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
