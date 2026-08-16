import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteUser, getProjectUsage, listAudit, listUsers, patchUser, setMember, setQuota } from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonOk(body: unknown = {}, status = 200) {
  return {
    ok: true,
    status,
    json: async () => body,
  }
}

describe('admin api URLs', () => {
  it('GETs /admin/api/users with same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk([]))
    vi.stubGlobal('fetch', fetchMock)
    await listUsers()
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users', {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('PATCHes /admin/api/users/:id without a handwritten Origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await patchUser(7, { status: 'disabled' })
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users/7', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers', expect.objectContaining({ origin: expect.anything() }))
  })

  it('DELETEs /admin/api/users/:id with same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await deleteUser(7)
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users/7', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('PUTs member mode and GETs audit with actionPrefix', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk(undefined, 204))
      .mockResolvedValueOnce(jsonOk([]))
    vi.stubGlobal('fetch', fetchMock)
    await setMember(3, 9, 'rw')
    await listAudit({ userId: 9, actionPrefix: 'admin.', limit: 50, offset: 0 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/projects/3/members/9')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/api/audit?userId=9&actionPrefix=admin.&limit=50&offset=0')
  })

  it('GETs project usage and PUTs an explicit project quota source', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk({ month: '2026-08' }))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await getProjectUsage(3, '2026-08')
    await setQuota({
      subjectType: 'project',
      subjectId: '3',
      tokenLimit: 'inherit',
      companyCostMicrosLimit: 'inherit',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/usage?projectId=3&month=2026-08')
    expect(fetchMock.mock.calls[1]).toEqual([
      '/admin/api/quotas',
      {
        method: 'PUT',
        body: JSON.stringify({
          subjectType: 'project',
          subjectId: '3',
          tokenLimit: 'inherit',
          companyCostMicrosLimit: 'inherit',
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      },
    ])
  })

  it('throws Error from JSON error on !res.ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'cannot-remove-last-admin' }),
    }))
    await expect(patchUser(1, { status: 'disabled' })).rejects.toThrow('cannot-remove-last-admin')
  })
})
