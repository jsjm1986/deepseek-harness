/**
 * Shell viewport-mode acceptance over the assembled application: the compact
 * topbar + drawer + scrim pair, the medium rail with no details track, the
 * expanded three-track grid, and a wide/compact round-trip — the assembled
 * narrow-viewport walkthrough the shell previously lacked. Keyless: every
 * scenario is pure shell behavior over a cold world, no model turns.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/responsive-shell', import.meta.url))
const DRAWER_EXPECTED = join(SNAPSHOT_DIR, 'compact-drawer.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: responsive shell modes', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page?.close()
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'responsive shell e2e cleanup failed')
  })

  async function openAt(width: number, height: number): Promise<Page> {
    const opened = await browser.newPage({ viewport: { width, height }, locale: 'en-US' })
    tripwire = watchConsole(opened)
    await opened.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await opened.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return opened
  }

  it('compact: single CSS-owned column under the shell topbar; the drawer opens and scrim-dismisses', async () => {
    page = await openAt(390, 844)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-compact'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('compact')
    // CSS owns the compact template: no inline column tracks, no drag handles.
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns)).toBe('')
    expect(await page.locator('[class*="handle"]').count()).toBe(0)

    // Stable class anchor: the toggle's accessible name flips between
    // Open/Close sidebar with the drawer state.
    const toggle = page.locator('[class*="topbarToggle"]').first()
    await toggle.waitFor({ timeout: 10_000 })
    expect(await toggle.getAttribute('aria-label')).toBe('Open sidebar')
    const drawer = page.locator('[class*="drawer"]').first()
    expect(await drawer.getAttribute('data-open')).toBeNull()

    await toggle.click()
    await expect.poll(() => drawer.getAttribute('data-open'), { timeout: 5_000 }).toBe('true')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getAttribute('aria-label')).toBe('Close sidebar')
    // The drawer renders the full expanded sidebar (its New Session control is reachable).
    await drawer.getByRole('button', { name: /new session/i }).first().waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="drawer"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DRAWER_EXPECTED, snapshot, MODE)

    // Tap the scrim strip right of the drawer (the drawer covers the left 320px).
    const scrim = page.locator('[class*="scrim"][data-open]').first()
    await scrim.click({ position: { x: 370, y: 420 } })
    await expect.poll(() => drawer.getAttribute('data-open'), { timeout: 5_000 }).toBeNull()
  }, 60_000)

  it('medium: rail column with two grid tracks and no drag handles while collapsed', async () => {
    page = await openAt(900, 700)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-medium'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('medium')
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBe('true')
    // The browser serializes the track list with explicit px units.
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toBe('56px minmax(0px, 1fr)')
    expect(await page.locator('[class*="handle"]').count()).toBe(0)
    // The shell topbar is compact-only; medium keeps the rail as the toggle host.
    expect(await page.locator('[class*="topbar"]').count()).toBe(0)
  }, 60_000)

  it('expanded: three grid tracks with details closed and the sidebar handle present', async () => {
    page = await openAt(1280, 800)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-expanded'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('expanded')
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toMatch(/^\d+px minmax\(0px, 1fr\) 0px$/)
    expect(await page.locator('[class*="handle"]').count()).toBe(1)
  }, 60_000)

  it('wide/compact round-trip re-seats the shell cleanly', async () => {
    page = await openAt(1680, 1000)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-responsive-roundtrip'))
    const frame = page.locator('[class*="frame"]').first()
    expect(await frame.getAttribute('data-viewport')).toBe('wide')
    expect(await page.locator('[class*="topbar"]').count()).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => frame.getAttribute('data-viewport'), { timeout: 5_000 }).toBe('compact')
    await page.getByRole('button', { name: 'Open sidebar' }).waitFor({ timeout: 10_000 })

    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => frame.getAttribute('data-viewport'), { timeout: 5_000 }).toBe('wide')
    await expect.poll(() => page.locator('[class*="topbar"]').count(), { timeout: 5_000 }).toBe(0)
    expect(await frame.evaluate(node => (node as HTMLElement).style.gridTemplateColumns))
      .toMatch(/^\d+px minmax\(0px, 1fr\) \d+px$/)
  }, 60_000)
})
