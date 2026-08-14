// @vitest-environment jsdom
/**
 * useMediaQuery spec: jsdom implements no matchMedia, so the stubbed list
 * drives both the absent-API fallback branch and live change dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMediaQuery } from '@deepseek-ai/dsh-client-ui-primitives/src/use-media-query.ts'

/** Minimal MediaQueryList stub: one listener slot plus a settable match state. */
function mediaListStub(initial: boolean) {
  let matches = initial
  let listener: (() => void) | null = null
  const list = {
    get matches() { return matches },
    addEventListener: (_type: string, fn: () => void) => { listener = fn },
    removeEventListener: () => { listener = null },
  } as unknown as MediaQueryList
  return {
    list,
    set(next: boolean) { matches = next; listener?.() },
    get subscribed() { return listener !== null },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useMediaQuery', () => {
  it('returns false where matchMedia is unavailable (jsdom default)', () => {
    const { result } = renderHook(() => useMediaQuery('(pointer: coarse)'))
    expect(result.current).toBe(false)
  })

  it('tracks the query list through change events', () => {
    const stub = mediaListStub(false)
    vi.stubGlobal('matchMedia', vi.fn(() => stub.list))
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(false)
    act(() => { stub.set(true) })
    expect(result.current).toBe(true)
    act(() => { stub.set(false) })
    expect(result.current).toBe(false)
  })

  it('resubscribes when the query changes and unsubscribes on unmount', () => {
    const lists = new Map<string, ReturnType<typeof mediaListStub>>()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => {
      let entry = lists.get(query)
      if (entry === undefined) { entry = mediaListStub(query === '(pointer: coarse)'); lists.set(query, entry) }
      return entry.list
    }))
    const { result, rerender, unmount } = renderHook(({ q }: { q: string }) => useMediaQuery(q), {
      initialProps: { q: '(max-width: 767px)' },
    })
    expect(result.current).toBe(false)
    rerender({ q: '(pointer: coarse)' })
    expect(result.current).toBe(true)
    expect(lists.get('(max-width: 767px)')!.subscribed).toBe(false)
    unmount()
    expect(lists.get('(pointer: coarse)')!.subscribed).toBe(false)
  })
})
