/** Project collaboration controls through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedBlankSession, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/project-collaboration', import.meta.url))
const SHARING_EXPECTED = join(SNAPSHOT_DIR, 'sharing.expected.md')
const READ_ONLY_EXPECTED = join(SNAPSHOT_DIR, 'read-only.expected.md')
const MODE = webSnapshotMode()
const SESSION_ID = 'project-collaboration-web-e2e'
const BLANK_SESSION_ID = 'project-collaboration-project-blank'
const SEEDED_PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'

type ProjectMode = 'ro' | 'rw'

function collaborationContext(mode: ProjectMode) {
  return {
    user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' },
    scope: { kind: 'project', projectId: 9, projectName: 'Payments migration', mode },
    projects: [
      { projectId: 9, name: 'Payments migration', path: '/srv/payments', mode },
      { projectId: 10, name: 'Audit platform', path: '/srv/audit', mode: mode === 'ro' ? 'rw' : 'ro' },
    ],
  }
}

function conversationDetail(
  mode: ProjectMode,
  sessionId: string = SESSION_ID,
  visibility: 'project' | 'private' = 'project',
) {
  const writable = mode === 'rw'
  return {
    access: {
      sessionId,
      rootSessionId: sessionId,
      projectId: 9,
      visibility,
      creatorUserId: 7,
      mode,
      canRead: true,
      canWrite: writable,
      canManage: writable,
    },
    conversation: {
      sessionId,
      creatorUserId: 7,
      creatorDisplayName: 'Lin',
      visibility,
      updatedAt: 1_786_767_200_000,
      participants: [
        { userId: 7, displayName: 'Lin', contributionCount: 3, lastContributedAt: 1_786_767_100_000 },
        { userId: 8, displayName: 'Zhou', contributionCount: 1, lastContributedAt: 1_786_767_150_000 },
      ],
    },
  }
}

async function mockGateway(page: Page, mode: ProjectMode): Promise<{
  visibilityBodies: string[]
  conversationReads: string[]
  visibilityBySession: Map<string, 'project' | 'private'>
}> {
  const visibilityBodies: string[] = []
  const conversationReads: string[] = []
  const visibilityBySession = new Map<string, 'project' | 'private'>()
  await page.route('**/account/api/context', async (route) => {
    await route.fulfill({ json: collaborationContext(mode) })
  })
  await page.route('**/account/api/scope', async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await page.route('**/account/api/conversations/*', async (route) => {
    if (route.request().method() === 'PATCH') {
      visibilityBodies.push(route.request().postData() ?? '')
      await route.fulfill({ status: 204, body: '' })
      return
    }
    const pathname = new URL(route.request().url()).pathname
    const sessionId = decodeURIComponent(pathname.slice('/account/api/conversations/'.length))
    await route.fulfill({
      json: conversationDetail(mode, sessionId, visibilityBySession.get(sessionId) ?? 'project'),
    })
    conversationReads.push(sessionId)
  })
  return { visibilityBodies, conversationReads, visibilityBySession }
}

async function openSeededSession(page: Page, scaffold: WebScaffold): Promise<void> {
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(SEEDED_PROMPT)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
}

describe.skipIf(MODE === 'record')('web e2e: project collaboration controls', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const seeded = await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID)
    const blank = await seedBlankSession(scaffold, BLANK_SESSION_ID, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(seeded)
    await workspace.attachSession(blank)
    browser = await chromium.launch()
  }, 120_000)

  afterEach(async () => {
    try {
      expect(tripwire?.warnings ?? []).toEqual([])
      expect(tripwire?.pageErrors ?? []).toEqual([])
    } finally {
      await page?.close()
      page = undefined
      tripwire = undefined
    }
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'project collaboration e2e cleanup failed')
  })

  it('shows project scope, staged visibility, participants, and creator sharing controls', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const gateway = await mockGateway(page, 'rw')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-sharing'))
    await openSeededSession(page, scaffold)

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    expect(await scope.textContent()).toContain('Payments migration')
    expect(await scope.textContent()).toContain('Can edit')
    await scope.click()
    await page.getByText('New conversation visibility', { exact: true }).waitFor()
    await page.getByRole('menuitem', { name: /Only me/ }).click()

    const sharing = page.getByRole('button', { name: 'Manage conversation sharing' })
    await expect.poll(() => sharing.isEnabled(), { timeout: 10_000 }).toBe(true)
    await sharing.click()
    await page.getByText('Created by Lin', { exact: true }).waitFor()
    expect(await page.getByText('Participants (2)', { exact: true }).count()).toBe(1)
    expect(await page.getByText('3 contributions', { exact: true }).count()).toBe(1)
    expect(await page.getByText('1 contributions', { exact: true }).count()).toBe(1)
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SHARING_EXPECTED, snapshot, MODE)

    await page.getByRole('menuitem', { name: /Only me/ }).click()
    await expect.poll(() => gateway.visibilityBodies, { timeout: 10_000 })
      .toEqual(['{"visibility":"private"}'])
    await expect.poll(() => sharing.textContent(), { timeout: 10_000 }).toContain('Only me')
  }, 60_000)

  it('creates a private blank instead of reusing a project blank, then reuses the matching private blank', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const gateway = await mockGateway(page, 'rw')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-private-create'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    await scope.click()
    await page.getByRole('menuitem', { name: /Only me/ }).click()

    const before = new Set(scaffold.ctx.agents.list().map(agent => String(agent.session.id)))
    const newSession = page.getByRole('button', { name: 'New session' }).last()
    await newSession.click()
    let privateSessionId = ''
    await expect.poll(() => {
      const created = scaffold.ctx.agents.list()
        .map(agent => String(agent.session.id))
        .filter(sessionId => !before.has(sessionId))
      privateSessionId = created[0] ?? ''
      return created.length
    }, { timeout: 10_000 }).toBe(1)
    expect(privateSessionId).not.toBe(BLANK_SESSION_ID)
    expect(gateway.conversationReads).toContain(BLANK_SESSION_ID)

    gateway.visibilityBySession.set(privateSessionId, 'private')
    const agentCount = scaffold.ctx.agents.list().length
    await newSession.click()
    await expect.poll(() => gateway.conversationReads.at(-1), { timeout: 10_000 })
      .toBe(privateSessionId)
    await page.waitForTimeout(100)
    expect(scaffold.ctx.agents.list()).toHaveLength(agentCount)
    expect(scaffold.ctx.agents.get(SessionId(privateSessionId))).toBeDefined()
  }, 60_000)

  it('replaces the complete composer for read-only project members', async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await mockGateway(page, 'ro')
    onTestFailed(() => saveFailureShot(page!, 'web-e2e-project-collaboration-read-only'))
    await openSeededSession(page, scaffold)

    const scope = page.getByRole('button', { name: 'Switch personal or project scope' })
    await scope.waitFor({ timeout: 10_000 })
    expect(await scope.textContent()).toContain('Read only')
    await scope.click()
    expect(await page.getByText('New conversation visibility', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')

    const readOnly = page.getByRole('status').filter({ hasText: 'Read-only project' })
    await readOnly.waitFor({ timeout: 10_000 })
    expect(await readOnly.textContent()).toContain('Your project role does not allow changes to this conversation.')
    expect(await page.locator('textarea:enabled:visible').count()).toBe(0)
    expect(await page.getByRole('status').count()).toBe(1)
    const snapshot = await captureStableAria(page, '[role="status"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(READ_ONLY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['read-only.expected.md', 'sharing.expected.md'])
  })
})
