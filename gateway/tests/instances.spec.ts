import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import type { InstanceRepository, RuntimeTarget } from '../src/instances.ts'
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
  writeFileSync(join(guardDir, 'cordis.admin.patch.yml'), '- id: permission\n  config:\n    presets:\n      danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
  const governanceDir = join(root, 'plugins', 'dsh-model-governance')
  mkdirSync(governanceDir, { recursive: true })
  writeFileSync(join(governanceDir, 'package.json'), '{}')
  writeFileSync(join(governanceDir, 'cordis.patch.yml'), '- insert:\n    - id: governance\n')
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_DSH_REPO_ROOT: root,
    HGW_READINESS_TIMEOUT_MS: '10000',
    HGW_INSTANCE_PORT_BASE: '43100',
    ...extraEnv,
  })
  cfg.dshCommand = [process.execPath, '-e', FAKE_DSH, '{port}']
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  manager = new InstanceManager(db, cfg)
  return { root, db, cfg, users, alice, manager }
}

class ProjectRepository implements InstanceRepository {
  private state = 'stopped'
  private generation = 0

  constructor(private readonly projectPath: string, private readonly port: number) {}

  initialize(): Promise<void> { return Promise.resolve() }
  portOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.port) }
  stateOf(_target: RuntimeTarget): Promise<string> { return Promise.resolve(this.state) }
  generationOf(_target: RuntimeTarget): Promise<number> { return Promise.resolve(this.generation) }
  touch(_target: RuntimeTarget, _at: number): Promise<void> { return Promise.resolve() }
  beginStart(_target: RuntimeTarget, _at: number, _runtimeTokenHash: Buffer): Promise<number> {
    this.state = 'starting'
    this.generation += 1
    return Promise.resolve(this.generation)
  }
  markReady(_target: RuntimeTarget, _generation: number): Promise<void> {
    this.state = 'ready'
    return Promise.resolve()
  }
  idleTargets(_cutoff: number): Promise<RuntimeTarget[]> { return Promise.resolve([]) }
  markStopping(_target: RuntimeTarget): Promise<void> {
    this.state = 'stopping'
    return Promise.resolve()
  }
  markStopped(_target: RuntimeTarget): Promise<void> {
    this.state = 'stopped'
    return Promise.resolve()
  }
  owner(_target: RuntimeTarget): Promise<{
    kind: 'project'
    id: number
    username: string
    homePath: string
    name: string
  }> {
    return Promise.resolve({
      kind: 'project',
      id: 41,
      username: 'project-41',
      homePath: this.projectPath,
      name: 'Compiler',
    })
  }
}

describe('InstanceManager', () => {
  it('spawns, reports ready, and dedupes concurrent starts', async () => {
    const { alice, manager } = await setup()
    const [a, b] = await Promise.all([manager.ensureRunning(alice), manager.ensureRunning(alice)])
    expect(a.port).toBe(43100)
    expect(b.port).toBe(43100)
    expect(await manager.stateOf(alice.id)).toBe('ready')
    const response = await fetch(`http://127.0.0.1:${a.port}/`)
    expect(response.status).toBe(200)
  })

  it('reaps idle instances but keeps active ones', async () => {
    const { db, alice, manager } = await setup({ HGW_IDLE_TIMEOUT_MS: '50' })
    await manager.ensureRunning(alice)
    await manager.wsRef(alice.id, 1)
    await new Promise(r => setTimeout(r, 120))
    expect(await manager.reapIdle()).toBe(0)
    await manager.wsRef(alice.id, -1)
    db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now() - 60_000, alice.id)
    expect(await manager.reapIdle()).toBe(1)
    expect(await manager.stateOf(alice.id)).toBe('stopped')
  })

  it('treats a crashed ready child as not live and respawns through ensureRunning', async () => {
    const { alice, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43120' })
    const { port } = await manager.ensureRunning(alice)
    expect(await manager.isLive(alice.id)).toBe(true)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await new Promise(r => setTimeout(r, 50))
    expect(await manager.stateOf(alice.id)).toBe('ready')
    expect(await manager.isLive(alice.id)).toBe(false)
    await manager.ensureRunning(alice)
    expect(await manager.isLive(alice.id)).toBe(true)
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
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toBe(
      '- insert:\n    - id: governance\n- insert: []\n',
    )
    const modules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    expect(readlinkSync(join(modules, 'dsh-directory-guard'))).toBe(join(root, 'plugins', 'dsh-directory-guard'))
    expect(readlinkSync(join(modules, 'dsh-model-governance'))).toBe(join(root, 'plugins', 'dsh-model-governance'))
  })

  it('appends the administrator permission overlay after the restricted guard patch', async () => {
    const { root, users, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43130' })
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    await manager.ensureRunning(admin)
    const patch = readFileSync(join(root, 'users', 'admin', 'dsh', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- insert: []\n- id: permission\n')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
  })

  it('refuses an administrator start when the configured guard has no admin overlay', async () => {
    const { root, users, manager } = await setup({ HGW_INSTANCE_PORT_BASE: '43150' })
    rmSync(join(root, 'plugins', 'dsh-directory-guard', 'cordis.admin.patch.yml'))
    const admin = await users.create({ username: 'admin', password: 'pw-123456', role: 'admin' })
    await expect(manager.ensureRunning(admin)).rejects.toThrow(/directory-guard admin patch not found/)
    expect(await manager.stateOf(admin.id)).not.toBe('ready')
  })

  it('HGW_GUARD_PATCH=off disables only the directory guard and keeps model governance', async () => {
    const { root, alice, manager } = await setup({ HGW_GUARD_PATCH: 'off', HGW_INSTANCE_PORT_BASE: '43140' })
    await manager.ensureRunning(alice)
    const dshHome = join(root, 'users', 'alice', 'dsh')
    expect(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')).toBe('- insert:\n    - id: governance\n')
    const modules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
    expect(readlinkSync(join(modules, 'dsh-model-governance'))).toBe(join(root, 'plugins', 'dsh-model-governance'))
    expect(existsSync(join(modules, 'dsh-directory-guard'))).toBe(false)
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

  it('mounts shared persistence and collaboration plugins for project runtimes only', async () => {
    const { root, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43190' })
    const projectPath = join(root, 'shared-project')
    mkdirSync(projectPath, { recursive: true })
    const dshHome = join(root, 'project-runtimes', '41', 'dsh')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: personal\n')
    const seed = join(root, 'company.env')
    writeFileSync(seed, 'DEEPSEEK_API_KEY=company-key\n')
    cfg.defaultEnvFile = seed
    manager = new InstanceManager(new ProjectRepository(projectPath, 43190), cfg)

    await manager.ensureRunning({ kind: 'project', id: 41, name: 'Compiler', path: projectPath })

    const patch = readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: session-persistence-jsonl\n  disabled: true\n')
    expect(patch).toContain('danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n')
    for (const plugin of [
      '@deepseek-ai/dsh-gateway-runtime',
      '@deepseek-ai/dsh-collaboration-gateway',
      '@deepseek-ai/dsh-collaboration-context',
      '@deepseek-ai/dsh-session-persistence-gateway',
    ]) expect(patch).toContain(`name: '${plugin}'`)
    expect(existsSync(join(dshHome, '.credentials.yaml'))).toBe(false)
    expect(readFileSync(join(dshHome, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=company-key\n')
  })

  it('refuses to start when the configured guard patch is missing (fail loud, not unguarded)', async () => {
    const { alice, manager } = await setup({ HGW_GUARD_PATCH: '/nowhere/guard.yml', HGW_INSTANCE_PORT_BASE: '43160' })
    await expect(manager.ensureRunning(alice)).rejects.toThrow(/directory-guard patch not found/)
    expect(await manager.stateOf(alice.id)).not.toBe('ready')
  })

  it('serializes concurrent stop and ensureRunning so state and process stay consistent (no orphan)', async () => {
    const { alice, manager } = await setup()
    await manager.ensureRunning(alice)
    const port = await manager.portOf(alice.id)

    // stop enqueued before ensureRunning: final state is ready, and it is reachable.
    await Promise.all([manager.stop(alice.id), manager.ensureRunning(alice)])
    expect(await manager.stateOf(alice.id)).toBe('ready')
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

    // ensureRunning enqueued before stop: final state is stopped, and NOTHING
    // is left listening (the fix's core invariant — no orphaned process).
    await Promise.all([manager.ensureRunning(alice), manager.stop(alice.id)])
    expect(await manager.stateOf(alice.id)).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('keeps a runtime stopped until destructive work releases its operation slot', async () => {
    const { root, cfg } = await setup({ HGW_INSTANCE_PORT_BASE: '43210' })
    const projectPath = join(root, 'shared-delete')
    mkdirSync(projectPath, { recursive: true })
    const project = { kind: 'project' as const, id: 41, name: 'Compiler', path: projectPath }
    const target = { kind: 'project' as const, id: project.id }
    manager = new InstanceManager(new ProjectRepository(projectPath, 43210), cfg)
    await manager.ensureRunning(project)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const destructive = manager.withStopped(target, async () => {
      enter()
      expect(await manager!.stateOf(target)).toBe('stopped')
      await held
      return 'deleted'
    })
    await entered

    let restarted = false
    const restart = manager.ensureRunning(project).then((result) => {
      restarted = true
      return result
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(restarted).toBe(false)

    release()
    await expect(destructive).resolves.toBe('deleted')
    await expect(restart).resolves.toMatchObject({ port: 43210 })
    expect(await manager.stateOf(target)).toBe('ready')
  })
})
