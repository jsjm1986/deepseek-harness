import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ProjectDetailPage } from './ProjectDetailPage.tsx'

vi.mock('../api.ts', () => ({
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  getProjectUsage: vi.fn(),
  listUsers: vi.fn(),
  removeMember: vi.fn(),
  renameProject: vi.fn(),
  setMember: vi.fn(),
  setQuota: vi.fn(),
}))

const project = {
  id: 7,
  name: 'People',
  path: '/srv/people',
  memberCount: 1,
  members: [{ userId: 1, username: 'alice', mode: 'rw' as const }],
}

const alice = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  role: 'user' as const,
  status: 'active' as const,
  homePath: '/home/alice',
  mustChangePassword: false,
  port: 9101,
  instanceState: 'running',
}

const usage = {
  month: '2026-08',
  inputTokens: 700,
  outputTokens: 300,
  cacheReadTokens: 50,
  cacheWriteTokens: 20,
  totalTokens: 1_070,
  estimatedCostMicros: 2_000_000,
  companyCostMicros: 1_500_000,
  calls: 4,
  missingUsageCalls: 0,
  tokenLimit: 10_000,
  companyCostMicrosLimit: 5_000_000,
  alerts: [],
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7']}>
      <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('ProjectDetailPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getProject).mockResolvedValue(project)
    vi.mocked(api.listUsers).mockResolvedValue([alice])
    vi.mocked(api.getProjectUsage).mockResolvedValue(usage)
    vi.mocked(api.setQuota).mockResolvedValue(undefined)
  })

  it('shows project usage and reloads it for the selected month', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy()
    expect(within(await screen.findByLabelText('项目用量汇总')).getByText('1070')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    await waitFor(() => expect(api.getProjectUsage).toHaveBeenLastCalledWith(7, '2026-07'))
  })

  it('requires an explicit source and can restore inherited project quotas', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    expect((dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(dialog.getByLabelText(/继承普通成员额度/))
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project',
      subjectId: '7',
      tokenLimit: 'inherit',
      companyCostMicrosLimit: 'inherit',
    }))
  })

  it('saves independent Token and company-cost limits together', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    await user.click(dialog.getByLabelText(/项目独立额度/))
    const modeSelects = dialog.getAllByLabelText('额度模式')
    await user.selectOptions(modeSelects[0]!, 'custom')
    await user.selectOptions(modeSelects[1]!, 'custom')
    await user.type(dialog.getByLabelText('每月 Token'), '12000')
    await user.type(dialog.getByLabelText('每月人民币元'), '8.5')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project',
      subjectId: '7',
      tokenLimit: 12_000,
      companyCostMicrosLimit: 8_500_000,
    }))
  })
})
