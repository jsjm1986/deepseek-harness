import {
  ChartNoAxesCombined,
  FolderKanban,
  PanelsTopLeft,
  ScrollText,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react'
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
      <div className="adminShell" data-testid="admin-app">
        <aside className="sidebar">
          <Brand />
          <AdminNav className="sidebarNav" />
          <div className="sidebarFooter">管理中心</div>
        </aside>
        <header className="mobileHeader">
          <Brand compact />
        </header>
        <main className="mainContent">
          <Routes>
            <Route path="/" element={<UsersPage />} />
            <Route path="/projects" element={<ProjectListPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/audit" element={<AuditPage />} />
          </Routes>
        </main>
        <AdminNav className="mobileNav" />
      </div>
    </Router>
  )
}

const NAV_ITEMS: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: '用户', icon: Users, end: true },
  { to: '/projects', label: '项目', icon: FolderKanban },
  { to: '/models', label: '模型', icon: Sparkles },
  { to: '/usage', label: '用量', icon: ChartNoAxesCombined },
  { to: '/audit', label: '审计', icon: ScrollText },
]

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brandCompact' : ''}`}>
      <span className="brandMark"><PanelsTopLeft aria-hidden="true" /></span>
      <span className="brandCopy">
        <strong>DeepSeek Harness</strong>
        {compact ? null : <span>Admin</span>}
      </span>
    </div>
  )
}

function AdminNav({ className }: { className: string }) {
  return (
    <nav className={className} aria-label="管理导航">
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
