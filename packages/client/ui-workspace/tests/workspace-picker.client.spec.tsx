// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DirectoryListing, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const sessions: SessionListState = {
  ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
  listDirectory?: WorkspacePickerProps['listDirectory'],
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const { probe, renderSlot } = flowProbe()
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useWorkspaces={hook(workspaceState(nextItems))}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
      listDirectory={listDirectory}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, probe, occupancy,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseAdd(): void {
  fireEvent.click(screen.getByRole('menuitem', { name: '添加工作区…' }))
}

describe('WorkspacePicker', () => {
  it('lists same-title Workspaces separately and forwards the selected id', () => {
    const b = mount([workspace('alpha', 'Shared'), workspace('beta', 'Shared')])
    const entries = screen.getAllByRole('menuitem', { name: 'Shared' })
    expect(entries).toHaveLength(2)
    fireEvent.click(entries[1]!)
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('opens the composed directory flow, adopts its picked path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const b = mount([workspace('alpha', 'Alpha')], createWorkspace)
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    chooseAdd()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    await act(async () => { b.probe.owner!.onPicked('/tmp/project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    // Successful adoption withdraws the flow request.
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('raises the flow straight from the anchor gesture when adding is the only entry', () => {
    // Nothing to list and one action left: a one-row menu would offer no
    // choice, so the owner's open request lands in the flow itself.
    const b = mount([])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('treats flow cancellation as a silent no-op', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a non-Error adoption failure in the folder-error surface', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw 'permission denied' }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('permission denied')
    expect(b.probe.owner!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(b.probe.owner!.open).toBe(true)
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables every menu action from flow open through adoption, and reports busy to the flow', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    // The flow is open but nothing is picked yet: a chooser pending on the
    // host display must already block concurrent workspace actions.
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('shows the flow-reported failure in the folder-error surface', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes the folder-error surface when the user cancels', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([workspace('alpha', 'Alpha')]))}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu up while the list baseline is still in flight', () => {
    const state: WorkspaceListState = {
      ...workspaceState([]), phase: 'pending', state: 'loading', baselinesReady: false,
    }
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    // An empty list is not final yet: jumping into the directory flow here
    // would pre-empt the workspaces about to arrive.
    expect(screen.getByRole('status').textContent).toBe('正在加载工作区…')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('shows no popover at all when nothing is listed and nothing can be added', () => {
    // A composition mounting this package without any directory-picker: the
    // hero anchor has neither a Workspace to pick nor a way to add one, so it
    // must not claim a choice with an empty menu.
    const b = mount([], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('holds the anchor gesture while an adoption is still settling', async () => {
    // The auto-open path obeys the same busy rule as the disabled menu entry:
    // an occupant that re-registers mid-adoption must not raise a second flow.
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    // The list empties under the still-settling adoption (the workspace was
    // deleted elsewhere), which would otherwise make add the only entry.
    act(() => { b.rerenderItems([]) })
    expect(b.createWorkspace).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('hides the add entry while the directory-flow hole is empty', () => {
    mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })

  it('shows the add entry when a flow package activates after the first paint', () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    // Registration changes flow through the subscription, no re-render needed.
    act(() => { b.occupancy.flip(true) })
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('keeps Choose again inert while the flow occupant is gone, and snaps back a flow opened over an empty hole', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw new Error('adoption failed') }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy() })
    // The occupant unloads while the error dialog is up: retrying would open
    // a flow nobody can serve or cancel, so the button goes inert.
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新选择' }).disabled).toBe(true)
    // Cancel stays the way out, and the menu actions are usable again.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
  })

  it('withdraws an open flow when its occupant unloads, re-enabling the menu actions', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    // The flow plugin unloads mid-interaction (HMR): nobody is left to
    // cancel, so the owner withdraws and the actions come back.
    act(() => { b.occupancy.flip(false) })
    expect(b.probe.owner!.open).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })

  it('refuses to open an existing workspace whose path is outside the authorized roots', async () => {
    const revoked = { ...workspace('revoked', 'Revoked'), path: '/revoked' }
    const listDirectory = vi.fn(async () => ({
      path: '/allowed',
      home: '/allowed',
      crumbs: [],
      entries: [{ name: 'allowed', path: '/allowed', hidden: false }],
      truncated: false,
    }))
    const b = mount([revoked], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('此工作区已不在授权范围内，无法打开。')
    expect(b.onPick).not.toHaveBeenCalled()
    expect(listDirectory).toHaveBeenCalledWith()
  })

  it('opens an existing workspace that sits on an authorized root', async () => {
    const nested = { ...workspace('ok', 'Ok'), path: '/allowed/child' }
    const listDirectory = vi.fn(async () => ({
      path: '/allowed',
      home: '/allowed',
      crumbs: [],
      entries: [{ name: 'allowed', path: '/allowed', hidden: false }],
      truncated: false,
    }))
    const b = mount([nested], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ok' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(wid('ok')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('skips the grant check when listDirectory returns a normal home listing', async () => {
    const outside = { ...workspace('out', 'Out'), path: '/revoked' }
    const listDirectory = vi.fn(async () => ({
      path: '/home/u',
      home: '/home/u',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'u', path: '/home/u', hidden: false },
      ],
      entries: [{ name: 'docs', path: '/home/u/docs', hidden: false }],
      truncated: false,
    }))
    const b = mount([outside], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Out' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(wid('out')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a listDirectory failure in the folder-error surface', async () => {
    const revoked = { ...workspace('revoked', 'Revoked'), path: '/revoked' }
    const listDirectory = vi.fn(async () => { throw new Error('roots unavailable') })
    const b = mount([revoked], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('roots unavailable')
    })
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('opens an existing workspace when listDirectory is omitted', () => {
    const revoked = { ...workspace('revoked', 'Revoked'), path: '/revoked' }
    const b = mount([revoked])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('revoked'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens an existing workspace when injected listDirectory reports browse unavailable', async () => {
    // Production always injects listDirectory. Native standalone dsh web
    // answers host.listDirectory with this code; the fence must fail-open.
    const revoked = { ...workspace('revoked', 'Revoked'), path: '/revoked' }
    const listDirectory = vi.fn(async () => {
      throw new DirectoryBrowseError({
        code: 'directory-picker-unavailable',
        message: 'host.listDirectory needs the browse capability; the composed picker serves "native"',
        details: { capability: 'native' },
      })
    })
    const b = mount([revoked], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(wid('revoked')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('drops a stale unauthorized listing after a later authorized pick', async () => {
    const revoked = { ...workspace('revoked', 'Revoked'), path: '/revoked' }
    const allowed = { ...workspace('ok', 'Ok'), path: '/allowed' }
    const grantListing: DirectoryListing = {
      path: '/allowed',
      home: '/allowed',
      crumbs: [],
      entries: [{ name: 'allowed', path: '/allowed', hidden: false }],
      truncated: false,
    }
    let releaseRevoked!: (listing: DirectoryListing) => void
    const revokedPending = new Promise<DirectoryListing>((resolve) => { releaseRevoked = resolve })
    const listDirectory = vi.fn()
      .mockImplementationOnce(() => revokedPending)
      .mockImplementationOnce(async () => grantListing)
    const b = mount([revoked, allowed], vi.fn(), occupancySource(), listDirectory)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoked' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ok' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(wid('ok')) })
    await act(async () => { releaseRevoked(grantListing) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.onPick).toHaveBeenCalledTimes(1)
  })
})
