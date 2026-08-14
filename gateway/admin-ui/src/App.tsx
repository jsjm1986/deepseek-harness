import { NavLink, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { AuditPage } from './pages/AuditPage.tsx'
import { ProjectDetailPage } from './pages/ProjectDetailPage.tsx'
import { ProjectListPage } from './pages/ProjectListPage.tsx'
import { UsersPage } from './pages/UsersPage.tsx'
import { ModelsPage } from './pages/ModelsPage.tsx'
import { UsagePage } from './pages/UsagePage.tsx'

export function App() {
  return (
    <Router basename="/admin">
      <div data-testid="admin-app">
        <main>
          <nav>
            <NavLink to="/">用户</NavLink>
            <NavLink to="/projects">项目</NavLink>
            <NavLink to="/models">模型</NavLink>
            <NavLink to="/usage">用量</NavLink>
            <NavLink to="/audit">审计</NavLink>
          </nav>
          <Routes>
            <Route path="/" element={<UsersPage />} />
            <Route path="/projects" element={<ProjectListPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/audit" element={<AuditPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  )
}
