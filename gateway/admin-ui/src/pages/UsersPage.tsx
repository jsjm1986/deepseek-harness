import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  controlInstance,
  createUser,
  listUsers,
  patchUser,
  resetPassword,
  type AdminUser,
} from '../api.ts'

export function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')

  const reload = useCallback(async () => {
    try {
      setUsers(await listUsers())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function run(action: () => Promise<void>) {
    try {
      await action()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      await createUser({
        username,
        password,
        role,
        displayName: displayName === '' ? undefined : displayName,
      })
      setUsername('')
      setPassword('')
      setDisplayName('')
      setRole('user')
    })
  }

  return (
    <div className="card">
      <h1>用户</h1>
      {error === '' ? null : <p className="error">{error}</p>}
      <form onSubmit={event => void onCreate(event)}>
        <h2>新建用户</h2>
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="用户名" required />
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="密码" required />
        <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="显示名" />
        <select value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">创建</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>显示名</th>
            <th>角色</th>
            <th>账号状态</th>
            <th>实例状态</th>
            <th>端口</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <UserRow key={user.id} user={user} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UserRow({ user, run }: { user: AdminUser; run: (action: () => Promise<void>) => Promise<void> }) {
  const [name, setName] = useState(user.displayName)
  const [newPassword, setNewPassword] = useState('')
  useEffect(() => { setName(user.displayName) }, [user.displayName])

  return (
    <tr>
      <td>{user.username}</td>
      <td>
        <input value={name} onChange={e => setName(e.target.value)} aria-label={`${user.username} 显示名`} />
        <button type="button" onClick={() => void run(() => patchUser(user.id, { displayName: name }))}>保存显示名</button>
      </td>
      <td>
        <select
          aria-label={`${user.username} 角色`}
          value={user.role}
          onChange={e => void run(() => patchUser(user.id, { role: e.target.value as 'admin' | 'user' }))}
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td>
        {user.status}
        {user.status === 'active'
          ? (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (!confirm('确认禁用该用户？')) return
                  void run(() => patchUser(user.id, { status: 'disabled' }))
                }}
              >
                禁用
              </button>
            )
          : (
              <button type="button" onClick={() => void run(() => patchUser(user.id, { status: 'active' }))}>
                启用
              </button>
            )}
      </td>
      <td>
        {user.instanceState}
        <button type="button" onClick={() => void run(() => controlInstance(user.id, 'start'))}>启动</button>
        <button type="button" onClick={() => void run(() => controlInstance(user.id, 'stop'))}>停止</button>
        <button type="button" onClick={() => void run(() => controlInstance(user.id, 'restart'))}>重启</button>
      </td>
      <td>{user.port}</td>
      <td>
        <input
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          type="password"
          placeholder="新密码"
          aria-label={`${user.username} 新密码`}
        />
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (!confirm('确认重置密码？')) return
            void run(async () => {
              await resetPassword(user.id, newPassword)
              setNewPassword('')
            })
          }}
        >
          重置密码
        </button>
      </td>
    </tr>
  )
}
