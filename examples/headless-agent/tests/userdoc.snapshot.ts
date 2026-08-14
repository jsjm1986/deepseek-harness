import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots', 'userdoc-prompt')
const replayFile = join(scenarioDir, 'replay.override.json')
const sessionFixture = join(scenarioDir, 'session.jsonl')
const streamFixture = join(scenarioDir, 'stream-json.expected.jsonl')
const configPath = fileURLToPath(new URL('../userdoc.cordis.snapshot.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/userdoc-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

interface JsonObject { [key: string]: unknown }

function jsonl(value: string): JsonObject[] {
  return value.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as JsonObject)
}

function normalizeUserDocValue(value: unknown, key?: string): unknown {
  if (key === 'modifiedAt' && typeof value === 'number') return 0
  if (typeof value === 'string') {
    if (key === 'docId') return value.replace(/^\d{4}-\d{2}-\d{2}\//, '{{uploadDate}}/')
    return value.replaceAll(/(\/uploads\/)\d{4}-\d{2}-\d{2}(?=\/)/g, '$1{{uploadDate}}')
  }
  if (Array.isArray(value)) return value.map(item => normalizeUserDocValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      normalizeUserDocValue(entryValue, entryKey),
    ]))
  }
  return value
}

function normalizeUserDocFields(content: string): string {
  return content.split('\n').map((line) => {
    if (line.trim() === '') return line
    return JSON.stringify(normalizeUserDocValue(JSON.parse(line)))
  }).join('\n')
}

function contextFor(content: string): NormalizeContext {
  const first = jsonl(content)[0]
  const id = typeof first?.id === 'string' ? first.id : '\0no-session\0'
  const cwd = typeof first?.cwd === 'string' ? first.cwd : '\0no-cwd\0'
  return { sessionIds: [id], cwd }
}

function normalizedStream(content: string, cwd: string): string {
  const records = jsonl(content)
  const final = records.at(-1)
  if (final?.type !== 'result') throw new Error('user-document snapshot has no result record')
  const sessionIds = [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))]
  if (sessionIds.length !== 1) throw new Error('user-document snapshot must use one session')
  const context: NormalizeContext = { sessionIds, cwd }
  const events = records.slice(0, -1).map(record => record.event as JsonObject)
  const normalizedEvents = jsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`, context,
  )))
  const normalized = records.map((record, index) => index < normalizedEvents.length
    ? { ...record, event: normalizedEvents[index] }
    : record)
  return normalizeStdout(`${normalized.map(record => JSON.stringify(record)).join('\n')}\n`, context)
}

async function persistedSession(cwd: string): Promise<string> {
  const files = (await readdir(join(cwd, '.sessions'), { recursive: true }))
    .filter(file => file.endsWith('.jsonl'))
  if (files.length !== 1 || files[0] === undefined) throw new Error(`expected one persisted session, found ${files.length}`)
  return readFile(join(cwd, '.sessions', files[0]), 'utf8')
}

describe('assembled user-document prompt snapshots', () => {
  it('replays the frozen document representation and attached event without a key', async () => {
    const prompt = 'Summarize the uploaded brief and prove its durable representation.'
    let cwd = ''
    let session = ''
    const result = await runLoaderSmoke({
      label: 'user-document prompt snapshot',
      tempDirPrefix: 'headless-snapshot-userdoc-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: sessionFixture,
        DSH_SNAPSHOT_OVERRIDE: replayFile,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (runCwd) => { cwd = runCwd },
      inspect: async (runCwd) => { session = await persistedSession(runCwd) },
    })
    expect(result.stderr).toBe('')
    const normalizedSession = normalizeUserDocFields(
      scrubRequestHeaders(normalizeSessionLog(session, contextFor(session))),
    )
    const normalized = normalizeUserDocFields(normalizedStream(result.stdout, cwd))
    const expectedSession = await readFile(sessionFixture, 'utf8').catch(() => '')
    const expectedStream = await readFile(streamFixture, 'utf8').catch(() => '')
    if (refreshing) {
      await writeFile(sessionFixture, normalizedSession)
      await writeFile(streamFixture, normalized)
    } else {
      expect(normalizedSession).toBe(expectedSession)
      expect(normalized).toBe(expectedStream)
    }
    expect(normalizedSession).toContain('userdoc/attached')
    expect(normalizedSession).toContain('frozen document text')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
