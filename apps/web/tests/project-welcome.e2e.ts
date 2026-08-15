/** Read-only project welcome acknowledgement through the shipped Host and Client composition. */

import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  WELCOME_NOTICE_COPY, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

function projectAuthority() {
  return {
    participant: {
      userId: 7,
      username: 'lin',
      displayName: 'Lin',
      role: 'user',
      scope: {
        kind: 'project',
        projectId: 9,
        projectName: 'Payments migration',
        mode: 'ro',
      },
    },
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    authorize: () => Promise.reject(new Error('session authorization is not exercised')),
    readableSessionIds: (ids: readonly string[]) => Promise.resolve(new Set(ids)),
    claimInteraction: () => Promise.resolve(true),
  }
}

interface ProjectCollaborationContext {
  provide(name: 'collaboration', service: {
    capture(): ReturnType<typeof projectAuthority>
    currentCreation(): undefined
    withSessionCreation<T>(creation: unknown, operation: () => Promise<T>): Promise<T>
  }): void
}

describe.skipIf(MODE === 'record')('web e2e: project welcome notice', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ welcomeNoticePending: true })
    const authority = projectAuthority()
    const context = scaffold.ctx as unknown as ProjectCollaborationContext
    context.provide('collaboration', {
      capture: () => authority,
      currentCreation: () => undefined,
      withSessionCreation: (_creation, operation) => operation(),
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('advances process-locally and presents the notice again after reload', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(
      () => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 15_000 },
    ).toBe(false)

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
