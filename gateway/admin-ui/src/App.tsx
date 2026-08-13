export function App() {
  return (
    <div data-testid="admin-app">
      <nav>
        <a href="/admin/users">用户</a>
        {' / '}
        <a href="/admin/projects">项目</a>
        {' / '}
        <a href="/admin/audit">审计</a>
      </nav>
      <h1>管理</h1>
    </div>
  )
}
