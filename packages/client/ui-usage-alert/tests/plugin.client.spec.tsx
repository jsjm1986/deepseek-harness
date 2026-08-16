// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { UsageAlert } from '../src/client/UsageAlert.tsx'
import { apply, inject, type UsageAlertInjected, type UsageView } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'global' } },
  } as never, (() => null) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('shell.overlay')[0]
  if (entry === undefined) throw new Error('usage alert slot entry was not registered')
  return {
    ctx,
    fiber,
    face: (entry.inject as unknown as (() => UsageAlertInjected) | undefined)?.(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const kit = {
  useSessions: (() => { throw new Error('unused by usage alert') }) as never,
  useWorkspaces: (() => { throw new Error('unused by usage alert') }) as never,
}

describe('usage alert browser plugin', () => {
  it('registers one overlay entry and removes it with the plugin fiber', async () => {
    const b = await bench()
    expect(b.face?.loadUsage).toBeTypeOf('function')
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(1)

    await b.fiber.dispose()

    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('loads the authenticated same-origin account summary', async () => {
    const view: UsageView = { month: '2026-08', alerts: [] }
    const fetchCall = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(view) })
    vi.stubGlobal('fetch', fetchCall)
    const b = await bench()

    await expect(b.face?.loadUsage()).resolves.toEqual(view)
    expect(fetchCall).toHaveBeenCalledWith('/account/api/usage', { credentials: 'same-origin' })
  })

  it('keeps non-success and failed advisory reads out of the shell', async () => {
    const fetchCall = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchCall)
    const b = await bench()

    await expect(b.face?.loadUsage()).resolves.toBeNull()
    await expect(b.face?.loadUsage()).resolves.toBeNull()
  })

  it('the node half applies without host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

describe('UsageAlert', () => {
  it('renders nothing before data arrives or when no crossing exists', async () => {
    const pending = deferred<UsageView | null>()
    const view = render(<UsageAlert {...kit} loadUsage={() => pending.promise} />)
    expect(view.container.firstChild).toBeNull()

    await act(async () => { pending.resolve({ month: '2026-08', alerts: [] }) })
    expect(view.container.firstChild).toBeNull()
  })

  it('renders token and company-cost crossings supplied by the gateway', async () => {
    render(<UsageAlert {...kit} loadUsage={() => Promise.resolve({
      month: '2026-08',
      alerts: [
        { metric: 'tokens', threshold: 80, createdAt: 1 },
        { metric: 'company-cost', threshold: 100, createdAt: 2 },
      ],
    })} />)

    await waitFor(() => { expect(screen.getAllByRole('status')).toHaveLength(2) })
    expect(screen.getByText(/本月 Token 用量已达到额度的 80%/)).toBeTruthy()
    expect(screen.getByText(/本月公司模型成本已达到额度的 100%/)).toBeTruthy()
  })

  it('ignores a load that settles after unmount', async () => {
    const pending = deferred<UsageView | null>()
    const view = render(<UsageAlert {...kit} loadUsage={() => pending.promise} />)
    view.unmount()

    await act(async () => { pending.resolve({
      month: '2026-08',
      alerts: [{ metric: 'tokens', threshold: 80, createdAt: 1 }],
    }) })
  })
})
