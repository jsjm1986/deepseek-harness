/**
 * Media-query subscription for JS-side branches that CSS cannot express:
 * floating surfaces rendered outside the shell frame (portals never see the
 * frame's `data-viewport` stamp) and pointer-capability decisions. Component
 * CSS inside the frame selects on `[data-viewport]` or container queries
 * instead of calling this (docs/web-styling.md#responsive-layout).
 */
import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribe to a media query.
 * @param query - media query string, e.g. `'(pointer: coarse)'`.
 * @returns true while the query matches; false where matchMedia is
 * unavailable (jsdom and node e2e runs booting the client tree).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    // jsdom (the unit lane) implements no matchMedia despite lib.dom's
    // non-optional typing; the optional call keeps that lane unsubscribed.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    const list = window.matchMedia?.(query)
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (list === undefined) return () => {}
    list.addEventListener('change', onChange)
    return () => { list.removeEventListener('change', onChange) }
  }, [query])
  // jsdom (the unit lane) implements no matchMedia despite lib.dom's
  // non-optional typing; the optional call keeps that lane on false.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false)
}
