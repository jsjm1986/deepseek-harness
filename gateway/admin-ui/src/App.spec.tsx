import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

vi.mock('./pages/UsersPage.tsx', () => ({ UsersPage: () => <h1>用户页面</h1> }))
vi.mock('./pages/ProjectListPage.tsx', () => ({ ProjectListPage: () => <h1>项目页面</h1> }))
vi.mock('./pages/ProjectDetailPage.tsx', () => ({ ProjectDetailPage: () => <h1>项目详情页面</h1> }))
vi.mock('./pages/ModelsPage.tsx', () => ({ ModelsPage: () => <h1>模型页面</h1> }))
vi.mock('./pages/UsagePage.tsx', () => ({ UsagePage: () => <h1>用量页面</h1> }))
vi.mock('./pages/AuditPage.tsx', () => ({ AuditPage: () => <h1>审计页面</h1> }))

describe('App', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/')
  })

  afterEach(() => cleanup())

  it('exposes matching desktop and mobile navigation and changes routes', async () => {
    render(<App />)
    expect(screen.getByTestId('admin-app')).toBeTruthy()
    expect(screen.getAllByRole('navigation', { name: '管理导航' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: '用户' })).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '用户页面' })).toBeTruthy()
    await userEvent.click(screen.getAllByRole('link', { name: '项目' })[0]!)
    expect(screen.getByRole('heading', { name: '项目页面' })).toBeTruthy()
  })
})
