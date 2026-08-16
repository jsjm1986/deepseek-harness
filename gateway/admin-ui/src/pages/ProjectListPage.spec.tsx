import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ProjectListPage } from './ProjectListPage.tsx'

vi.mock('../api.ts', () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
}))

describe('ProjectListPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.mocked(api.listProjects).mockReset().mockResolvedValue([])
    vi.mocked(api.createProject).mockReset()
  })

  it('creates a project from its name without asking for a host path', async () => {
    vi.mocked(api.createProject).mockResolvedValue({
      id: 1,
      name: 'People',
      path: '/srv/harness/projects/People',
      memberCount: 0,
    })
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.type(dialog.getByLabelText(/^项目名称/), '  People  ')
    await user.click(dialog.getByRole('button', { name: '创建项目' }))

    expect(api.createProject).toHaveBeenCalledWith({ name: 'People' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull())
  })

  it('keeps an invalid project name error inside the create dialog', async () => {
    vi.mocked(api.createProject).mockRejectedValue(new Error('project-name-invalid'))
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.type(dialog.getByLabelText(/^项目名称/), '../People')
    await user.click(dialog.getByRole('button', { name: '创建项目' }))

    expect(api.createProject).toHaveBeenCalledWith({ name: '../People' })
    expect((await dialog.findByRole('alert')).textContent).toContain('不能包含路径分隔符')
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeTruthy()
    expect((dialog.getByLabelText(/^项目名称/) as HTMLInputElement).value).toBe('../People')
  })
})
