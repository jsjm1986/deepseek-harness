import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UsersPage } from './UsersPage.tsx'

vi.mock('../api.ts', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  patchUser: vi.fn(),
  resetPassword: vi.fn(),
  controlInstance: vi.fn(),
}))

const alice = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  role: 'user' as const,
  status: 'active' as const,
  homePath: '/home/alice',
  mustChangePassword: false,
  port: 9101,
  instanceState: 'stopped',
}

describe('UsersPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.mocked(api.listUsers).mockResolvedValue([alice])
    vi.mocked(api.patchUser).mockResolvedValue(undefined)
    vi.mocked(api.deleteUser).mockResolvedValue(undefined)
    vi.mocked(api.createUser).mockResolvedValue(alice)
  })

  it('confirms account disabling in an accessible dialog before patching', async () => {
    render(<UsersPage />)
    expect(await screen.findAllByText('@alice · ID 1')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '禁用用户' }))
    expect(screen.getByRole('heading', { name: '禁用用户' })).toBeTruthy()
    expect(api.patchUser).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '确认禁用' }))
    expect(api.patchUser).toHaveBeenCalledWith(1, { status: 'disabled' })
  })

  it('creates a user through the dialog form', async () => {
    const user = userEvent.setup()
    render(<UsersPage />)
    await screen.findAllByText('@alice · ID 1')
    await user.click(screen.getByRole('button', { name: '新建用户' }))
    const dialog = within(screen.getByRole('dialog', { name: '新建用户' }))
    await user.type(dialog.getByLabelText(/^用户名/), 'bob')
    await user.type(dialog.getByLabelText('显示名'), 'Bob')
    await user.type(dialog.getByLabelText('初始密码'), 'secret-pass')
    await user.selectOptions(dialog.getByLabelText('角色'), 'admin')
    await user.click(dialog.getByRole('button', { name: '创建用户' }))
    expect(api.createUser).toHaveBeenCalledWith({
      username: 'bob',
      password: 'secret-pass',
      displayName: 'Bob',
      role: 'admin',
    })
  })

  it('confirms user deletion and removes the account from the list', async () => {
    vi.mocked(api.deleteUser).mockImplementation(async () => {
      vi.mocked(api.listUsers).mockResolvedValue([])
    })
    render(<UsersPage />)
    expect(await screen.findAllByText('@alice · ID 1')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '删除用户' }))
    expect(screen.getByRole('heading', { name: '删除用户' })).toBeTruthy()
    expect(api.deleteUser).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(api.deleteUser).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryAllByText('@alice · ID 1')).toHaveLength(0))
  })
})
