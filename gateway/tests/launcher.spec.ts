import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { LocalLauncher, SystemdLauncher, selectLauncher, type SystemdLauncherOptions } from '../src/launcher.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}))

function systemdOptions(unitDir: string, calls: string[][]): SystemdLauncherOptions {
  return {
    systemd: {
      usersRoot: '/srv/harness/users',
      projectRuntimesRoot: '/srv/harness/project-runtimes',
      projectPathRoots: ['/data'],
      execStart: '/usr/local/bin/node /opt/dsh/lib/bin.js web --port {port}',
      gatewayDir: '/srv/harness/gateway',
      memoryMax: '1G',
      cpuQuota: '100%',
    },
    grantsProvider: () => [
      { path: '/srv/harness/users/alice/home', mode: 'rw' },
      { path: '/data/docs', mode: 'ro' },
    ],
    credentialDir: join(unitDir, 'credentials'),
    unitDir,
    run: async (args) => { calls.push(args) },
  }
}

describe('SystemdLauncher', () => {
  it('writes a per-user confinement unit and restarts any process holding the prior credential', async () => {
    const unitDir = mkdtempSync(join(tmpdir(), 'units-'))
    const calls: string[][] = []
    const launcher = new SystemdLauncher(systemdOptions(unitDir, calls))

    const proc = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, gatewayCredential: '{"token":"test"}',
    })

    const unit = readFileSync(join(unitDir, 'harness-alice.service'), 'utf8')
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/users:ro')
    expect(unit).toContain('BindPaths=/srv/harness/users/alice/home')
    expect(unit).toContain('BindReadOnlyPaths=/data/docs')
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/dsh/lib/bin.js web --port 42001')
    expect(calls).toEqual([['daemon-reload'], ['restart', 'harness-alice.service']])

    await proc.terminate(1000)
    expect(calls).toContainEqual(['stop', 'harness-alice.service'])
    expect(proc.hasExited()).toBe(false)
  })
})

describe('LocalLauncher', () => {
  it('inherits runtime stderr while reserving fd 3 for the private credential', async () => {
    spawnMock.mockReset()
    const credentialPipe = new PassThrough()
    let credential = ''
    credentialPipe.on('data', chunk => { credential += String(chunk) })
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, credentialPipe],
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    spawnMock.mockReturnValue(child)
    const cfg = loadConfig({})
    cfg.dshCommand = ['node', 'runtime.js', '--port', '{port}']
    cfg.dshRepoRoot = '/srv/harness/repo'
    const launcher = new LocalLauncher(cfg)

    await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, gatewayCredential: '{"token":"test"}',
    })

    expect(spawnMock).toHaveBeenCalledWith('node', ['runtime.js', '--port', '42001'], expect.objectContaining({
      cwd: '/srv/harness/users/alice/home',
      stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
      env: expect.objectContaining({ DSH_GATEWAY_CREDENTIAL_FD: '3' }),
    }))
    expect(credential).toBe('{"token":"test"}')
  })
})

describe('selectLauncher', () => {
  it('returns LocalLauncher by default and never builds systemd options', () => {
    const launcher = selectLauncher(loadConfig({}), () => { throw new Error('systemd options must not be built for local') })
    expect(launcher).toBeInstanceOf(LocalLauncher)
  })

  it('returns SystemdLauncher when HGW_LAUNCHER=systemd', () => {
    const calls: string[][] = []
    const unitDir = mkdtempSync(join(tmpdir(), 'units-'))
    const launcher = selectLauncher(loadConfig({
      HGW_LAUNCHER: 'systemd',
      HGW_PROJECT_PATH_ROOTS: '/data',
    }), () => systemdOptions(unitDir, calls))
    expect(launcher).toBeInstanceOf(SystemdLauncher)
  })
})
