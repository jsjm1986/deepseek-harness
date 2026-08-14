import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { UserService } from '../src/users.ts'

const FAKE_DSH = `require('http').createServer((q, s) => { if (q.url === '/exit') { s.end('bye'); process.exit(0); return } s.end('ok') }).listen(Number(process.argv[1]), '127.0.0.1')`

let manager: InstanceManager | undefined
afterEach(async () => { await manager?.stopAll() })

async function setup(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  // A stand-in guard plugin package: the default guardPatch derives from
  // HGW_DSH_REPO_ROOT, and starting fails loud when the patch is absent.
  const guardDir = join(root, 'plugins', 'dsh-directory-guard')
  mkdirSync(guardDir, { recursive: true })
  writeFileSync(join(guardDir, 'cordis.patch.yml'), '- insert: []\n')
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_DSH_REPO_ROOT: root,
    HGW_READINESS_TIMEOUT_MS: '10000',
    HGW_INSTANCE_PORT_BASE: '43100',
    ...extraEnv,
  })
  cfg.dshCommand = [process.execPath, '-e', FAKE_DSH, '{port}']
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  manager = new InstanceManager(db, cfg)
  return { root, db, cfg, alice, manager }
}

describe('InstanceManager', () => {
  it('spawns, reports ready, and dedupes concurrent starts', async () => {
    const { alice, manager } = await setup()
    const [a, b] = await Promise.all([manager.ensureRunning(alice), manager.ensureRunning(alice)])
    expect(a.port).toBe(43100)
    expect(b.port).toBe(43100)
    expect(manager.stateOf(alice.id)).toBe('ready')
    const response = await fetch(`http://127.0.0.1:${a.port}/`)
    expect(response.status).toBe(200)
  })

  it('reaps idle instances but keeps active ones', async () => {
    const { db, alice, manager } = await setup({ HGW_IDLE_TIMEOUT_MS: '50' })
    await manager.ensureRunning(alice)
    manager.wsRef(alice.id, 1)
    await new Promise(r => setTimeout(r, 120))
    expect(await manager.reapIdle()).toBe(0)
    manager.wsRef(alice.id, -1)
    db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now() - 60_000, alice.id)
    expect(await manager.reapIdle()).toBe(1)
    expect(manager.stateOf(alice.id)).toBe('stopped')
  })

  it('treats a crashed ready child as not live and respawns through ensureRunning', async () => {
    const { alice, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43120' })
    const { port } = await manager.ensureRunning(alice)
    expect(manager.isLive(alice.id)).toBe(true)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await new Promise(r => setTimeout(r, 50))
    expect(manager.stateOf(alice.id)).toBe('ready')
    expect(manager.isLive(alice.id)).toBe(false)
    await manager.ensureRunning(alice)
    expect(manager.isLive(alice.id)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
  })

  it('stop terminates the child process', async () => {
    const { alice, manager } = await setup()
    const { port } = await manager.ensureRunning(alice)
    await manager.stop(alice.id)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('mounts the guard: home patch layer written and plugin linked into the profile node_modules', async () => {
    const { root, alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const dshHome = join(root, 'users', 'alice', 'dsh')
    // The bundle patch becomes the instance's home-level user layer, applied
    // by dsh over every profile without touching the launch argv.
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toBe('- insert: []\n')
    const link = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-directory-guard')
    expect(readlinkSync(link)).toBe(join(root, 'plugins', 'dsh-directory-guard'))
  })

  it('HGW_GUARD_PATCH=off starts without mounting anything', async () => {
    const { root, alice, manager } = await setup({ HGW_GUARD_PATCH: 'off', HGW_INSTANCE_PORT_BASE: '43140' })
    await manager.ensureRunning(alice)
    expect(existsSync(join(root, 'users', 'alice', 'dsh', 'cordis.patch.yml'))).toBe(false)
  })

  it('seeds the company default env into $DSH_HOME/.env on every start', async () => {
    const { root, alice, manager, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43180' })
    const seed = join(root, 'company.env')
    writeFileSync(seed, 'DEEPSEEK_API_KEY=company-key\n')
    cfg.defaultEnvFile = seed
    await manager.ensureRunning(alice)
    const target = join(root, 'users', 'alice', 'dsh', '.env')
    expect(readFileSync(target, 'utf8')).toBe('DEEPSEEK_API_KEY=company-key\n')
    // Rotation: a changed company file reaches the instance on its next start.
    writeFileSync(seed, 'DEEPSEEK_API_KEY=rotated\n')
    await manager.stop(alice.id)
    await manager.ensureRunning(alice)
    expect(readFileSync(target, 'utf8')).toBe('DEEPSEEK_API_KEY=rotated\n')
  })

  it('refuses to start when the configured guard patch is missing (fail loud, not unguarded)', async () => {
    const { alice, manager } = await setup({ HGW_GUARD_PATCH: '/nowhere/guard.yml', HGW_INSTANCE_PORT_BASE: '43160' })
    await expect(manager.ensureRunning(alice)).rejects.toThrow(/directory-guard patch not found/)
    expect(manager.stateOf(alice.id)).not.toBe('ready')
  })

  it('serializes concurrent stop and ensureRunning so state and process stay consistent (no orphan)', async () => {
    const { alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const port = manager.portOf(alice.id)

    // stop enqueued before ensureRunning: final state is ready, and it is reachable.
    await Promise.all([manager.stop(alice.id), manager.ensureRunning(alice)])
    expect(manager.stateOf(alice.id)).toBe('ready')
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

    // ensureRunning enqueued before stop: final state is stopped, and NOTHING
    // is left listening (the fix's core invariant — no orphaned process).
    await Promise.all([manager.ensureRunning(alice), manager.stop(alice.id)])
    expect(manager.stateOf(alice.id)).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })
})
