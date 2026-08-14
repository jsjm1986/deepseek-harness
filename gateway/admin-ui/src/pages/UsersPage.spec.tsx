import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UsersPage } from './UsersPage.tsx'

vi.mock('../api.ts', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
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
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.mocked(api.listUsers).mockResolvedValue([alice])
    vi.mocked(api.patchUser).mockResolvedValue(undefined)
  })

  it('renders the username and disable button; disable confirms then patches', async () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    render(<UsersPage />)
    expect(await screen.findByText('alice')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '禁用' }))
    expect(confirm).toHaveBeenCalled()
    expect(confirm.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(api.patchUser).mock.invocationCallOrder[0]!)
    expect(api.patchUser).toHaveBeenCalledWith(1, { status: 'disabled' })
  })
})
