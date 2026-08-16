import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES, loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('provides workable defaults', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8899)
    expect(cfg.instancePortBase).toBe(42000)
    expect(cfg.publicOrigins).toEqual(['http://127.0.0.1:8899'])
    expect(cfg.secureCookies).toBe(false)
    expect(cfg.dshCommand).toContain('{port}')
    expect(cfg.runtimeApiBodyLimitBytes).toBe(DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES)
    expect(cfg.projectPathRoots).toEqual([])
    expect(cfg.userProjectsRoot).toMatch(/user-projects$/)
    expect(cfg.projectsRoot).toMatch(/harness-projects$/)
    // The default CLI entry must be an ABSOLUTE path (resolved against
    // dshRepoRoot), because instances spawn with cwd = user home.
    const bin = cfg.dshCommand.find(arg => arg.endsWith('apps/cli/src/bin.ts'))
    expect(bin).toBeDefined()
    expect(isAbsolute(bin as string)).toBe(true)
  })

  it('resolves the default CLI entry against HGW_DSH_REPO_ROOT', () => {
    const cfg = loadConfig({ HGW_DSH_REPO_ROOT: '/opt/harness' })
    expect(cfg.dshCommand).toContain('/opt/harness/apps/cli/src/bin.ts')
  })

  it('resolves the tsx loader to an absolute file for the real repo (instances spawn outside it)', () => {
    const cfg = loadConfig({})
    const importIndex = cfg.dshCommand.indexOf('--import')
    const loader = cfg.dshCommand[importIndex + 1] as string
    expect(isAbsolute(loader)).toBe(true)
    expect(loader).toMatch(/tsx.*esm.*\.mjs$/)
  })

  it('derives the directory-guard patch from the repo root, honors overrides, and accepts off', () => {
    expect(loadConfig({ HGW_DSH_REPO_ROOT: '/opt/harness' }).guardPatch)
      .toBe('/opt/harness/plugins/dsh-directory-guard/cordis.patch.yml')
    expect(loadConfig({ HGW_GUARD_PATCH: '/x/guard.yml' }).guardPatch).toBe('/x/guard.yml')
    expect(loadConfig({ HGW_GUARD_PATCH: 'off' }).guardPatch).toBe('')
  })

  it('honors HGW_ environment overrides', () => {
    const cfg = loadConfig({
      HGW_PORT: '9001',
      HGW_ORGANIZATION_SLUG: 'internal',
      HGW_COMPUTE_NODE_NAME: 'mac-mini',
      HGW_PUBLIC_ORIGINS: 'https://harness.maycran.com,http://127.0.0.1:9001',
      HGW_USERS_ROOT: '/srv/harness/users',
      HGW_USER_PROJECTS_ROOT: '/srv/harness/projects/user-projects',
      HGW_PROJECTS_ROOT: '/srv/harness/projects/admin',
      HGW_IDLE_TIMEOUT_MS: '60000',
      HGW_RUNTIME_API_BODY_LIMIT_BYTES: '8388608',
    })
    expect(cfg.port).toBe(9001)
    expect(cfg.organizationSlug).toBe('internal')
    expect(cfg.computeNodeName).toBe('mac-mini')
    expect(cfg.publicOrigins).toEqual(['https://harness.maycran.com', 'http://127.0.0.1:9001'])
    expect(cfg.usersRoot).toBe('/srv/harness/users')
    expect(cfg.userProjectsRoot).toBe('/srv/harness/projects/user-projects')
    expect(cfg.projectsRoot).toBe('/srv/harness/projects/admin')
    expect(cfg.idleTimeoutMs).toBe(60000)
    expect(cfg.runtimeApiBodyLimitBytes).toBe(8 * 1024 * 1024)
    expect(cfg.secureCookies).toBe(true)
  })

  it('rejects a project runtime account that systemd cannot address', () => {
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: 'Project Runtime' }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: `harness-${'x'.repeat(40)}` }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: 'root' }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
  })

  it('requires non-overlapping project path roots for the systemd launcher', () => {
    expect(() => loadConfig({ HGW_LAUNCHER: 'systemd' })).toThrow(/HGW_PROJECT_PATH_ROOTS/)
    expect(loadConfig({ HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects,/mnt/projects' })
      .projectPathRoots).toEqual(['/srv/projects', '/mnt/projects'])
    expect(() => loadConfig({ HGW_PROJECT_PATH_ROOTS: '/srv/projects,/srv/projects/team' }))
      .toThrow(/overlapping roots/)
    expect(() => loadConfig({ HGW_PROJECT_PATH_ROOTS: '/' })).toThrow(/filesystem root/)
  })

  it('keeps managed user projects inside a data root and away from reserved paths', () => {
    expect(loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects',
      HGW_USER_PROJECTS_ROOT: '/srv/projects/managed/',
    }).userProjectsRoot).toBe('/srv/projects/managed')
    expect(() => loadConfig({ HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects' }))
      .not.toThrow()
    expect(() => loadConfig({ HGW_USER_PROJECTS_ROOT: 'relative/projects' }))
      .toThrow(/HGW_USER_PROJECTS_ROOT/)
    expect(() => loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects', HGW_USER_PROJECTS_ROOT: '/srv/projects',
    })).toThrow(/strict descendant/)
    expect(() => loadConfig({
      HGW_USER_PROJECTS_ROOT: '/tmp', HGW_USERS_ROOT: '/tmp/users',
    })).toThrow(/reserved Gateway directory/)
  })

  it('keeps the managed admin project root isolated and away from reserved paths', () => {
    expect(loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects',
      HGW_PROJECTS_ROOT: '/srv/projects/admin/',
    }).projectsRoot).toBe('/srv/projects/admin')
    expect(() => loadConfig({ HGW_PROJECTS_ROOT: 'relative/projects' }))
      .toThrow(/HGW_PROJECTS_ROOT/)
    expect(() => loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects', HGW_PROJECTS_ROOT: '/srv/projects',
    })).toThrow(/strict descendant/)
    expect(() => loadConfig({
      HGW_PROJECTS_ROOT: '/tmp', HGW_USERS_ROOT: '/tmp/users',
    })).toThrow(/reserved Gateway directory/)
    expect(() => loadConfig({
      HGW_PROJECTS_ROOT: '/srv/projects', HGW_USER_PROJECTS_ROOT: '/srv/projects/managed',
    })).toThrow(/reserved Gateway directory/)
  })

  it('rejects an invalid runtime API body limit', () => {
    expect(() => loadConfig({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '0' }))
      .toThrow(/positive safe integer/)
    expect(() => loadConfig({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: 'not-a-number' }))
      .toThrow(/positive safe integer/)
  })

  it('rejects an invalid instance port base', () => {
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: '1023' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: '65536' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: 'not-a-number' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
  })
})
