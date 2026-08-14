/**
 * Shell frame, registered into the built-in 'root' slot (the web shell
 * renders only 'root'). One frame, three viewport modes (viewport.ts):
 * expanded/wide keep the three grid columns (sidebar | center | details),
 * the drag handles (pointer capture + rAF throttle), and the concession
 * chain (columns.ts); medium keeps the rail-or-squeezed sidebar column but
 * lifts details into a right-edge overlay above the center; compact renders
 * a single column under a shell topbar, with the sidebar as a left drawer
 * and details as a full-frame overlay, both scrim-dismissed. Slots stay
 * mounted across open/close inside one mode (overlays hide by transform);
 * crossing a mode boundary may re-seat the sidebar and details subtrees.
 * The sidebar slot renders with live parameters from the mode decision, and
 * the session-aware occupants render in fixed positions; strict entries gate
 * themselves on current-session availability while session-maybe entries
 * retain identity. Pure component: everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { computeColumns, DETAILS_DEFAULT, SIDEBAR_DEFAULT } from './columns.ts'
import { viewportClassOf } from './viewport.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share + locale seat. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'layout'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The mode-switching shell frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const currentSession = useSessions(s => s.current)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const mode = viewportClassOf(viewport)
  // compact and medium lift details out of the grid into an overlay; the
  // sidebar column survives into medium (rail or squeezed-open) while
  // compact re-seats it as the drawer.
  const overlayPanels = mode === 'compact' || mode === 'medium'

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Compact session navigation dismisses the drawer: tapping a session in it
  // must land on the conversation, not stay under the still-open drawer.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const lastNavigation = useRef(currentSession)
  useEffect(() => {
    if (lastNavigation.current === currentSession) return
    lastNavigation.current = currentSession
    if (modeRef.current === 'compact') actions.collapseNarrow()
  }, [actions, currentSession])

  // Shrinking INTO compact drops the narrow override: a medium squeeze-open
  // sidebar must not reappear as the modal drawer blocking the content
  // (narrow itself does not flip across that boundary, so setNarrow cannot).
  const lastMode = useRef(mode)
  useEffect(() => {
    if (lastMode.current === mode) return
    const entered = mode === 'compact' && lastMode.current !== 'compact'
    lastMode.current = mode
    if (entered) actions.collapseNarrow()
  }, [actions, mode])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports (compact + medium) auto-collapse the sidebar; the store
  // mirror keeps toggleSidebar's semantics right (narrow toggles flip the
  // manual open override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a medium re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze, while compact renders the override as the drawer.
  const narrow = overlayPanels
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // Overlay modes keep details out of the track solve (the chain would
  // auto-close it against the narrow width); its open state is the overlay's.
  const cols = computeColumns(viewport, sidebarPreference, overlayPanels || detailsSession === undefined ? 0 : panels.details)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const drawerOpen = mode === 'compact' && panels.narrowExpanded
  const detailsOpen = overlayPanels && detailsSession !== undefined && panels.details > 0

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      // The compact template is CSS-owned (topbar row + single column); the
      // wider modes drive their column tracks from the mode decision here.
      style={mode === 'compact'
        ? undefined
        : {
          gridTemplateColumns: overlayPanels
            ? `${cols.sidebar}px minmax(0, 1fr)`
            : `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
        }}
      data-viewport={mode}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={(overlayPanels ? !detailsOpen : cols.details === 0) || undefined}
      data-dragging={dragging || undefined}
    >
      {mode === 'compact' && (
        <div className={css.topbar}>
          {/* The compact mode has no rail, so the shell owns the drawer
              affordance; ui-sidebar's own toggle serves the wider modes. */}
          <button
            type="button"
            className={css.topbarToggle}
            aria-label={drawerOpen ? t('drawer.close') : t('drawer.open')}
            aria-expanded={drawerOpen}
            onClick={() => { actions.toggleSidebar() }}
          >
            <IconPanelLeftOutline16 />
          </button>
        </div>
      )}
      {mode === 'compact'
        ? (
          <>
            {/* Drawer pair: the scrim owns pointer dismissal (keyboard users
                  close through the topbar toggle); the drawer keeps the sidebar
                  slot mounted across open/close and slides by transform. */}
            <div className={css.scrim} data-open={drawerOpen || undefined} aria-hidden onClick={() => { actions.collapseNarrow() }} />
            <div className={css.drawer} data-open={drawerOpen || undefined}>
              {renderSlot('sidebar', { collapsed: false, width: SIDEBAR_DEFAULT })}
            </div>
          </>
        )
        : (
          <div className={css.sidebarCol}>
            {/* Render-site slot call with live concession output: a closed
                  sidebar keeps the mounted slot at the compact-rail width, and the
                  component sees its rendered state as owner params decided here
                  (collapsed follows the resolved rail, so a derived auto-collapse
                  renders the rail UI too). */}
            {renderSlot('sidebar', {
              collapsed: sidebarCollapsed,
              width: cols.sidebar,
            })}
          </div>
        )}
      {/* Both occupants stay at fixed tree positions from first paint — no
          loading gate: a bare status line reads worse than the shell's own
          pending rendering. The conversation is session-maybe; the strict
          details entry naturally renders empty while no session is current. */}
      <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
      {overlayPanels
        ? (
          <>
            <div className={css.scrim} data-open={detailsOpen || undefined} aria-hidden onClick={() => { actions.closeDetails() }} />
            <div
              className={css.detailsOverlay}
              data-open={detailsOpen || undefined}
              // Medium caps the overlay at the details contract default;
              // compact stretches it edge to edge (AppFrame.module.css).
              style={{ '--frame-details-overlay-width': `${DETAILS_DEFAULT}px` } as CSSProperties}
            >
              {renderSlot('details', {})}
            </div>
          </>
        )
        : <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width and the compact drawer is not a
          column: resize handles belong to the wider modes only. */}
      {mode !== 'compact' && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
