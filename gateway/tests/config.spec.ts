import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('provides workable defaults', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8899)
    expect(cfg.instancePortBase).toBe(42000)
    expect(cfg.publicOrigins).toEqual(['http://127.0.0.1:8899'])
    expect(cfg.secureCookies).toBe(false)
    expect(cfg.dshCommand).toContain('{port}')
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
      HGW_IDLE_TIMEOUT_MS: '60000',
    })
    expect(cfg.port).toBe(9001)
    expect(cfg.organizationSlug).toBe('internal')
    expect(cfg.computeNodeName).toBe('mac-mini')
    expect(cfg.publicOrigins).toEqual(['https://harness.maycran.com', 'http://127.0.0.1:9001'])
    expect(cfg.usersRoot).toBe('/srv/harness/users')
    expect(cfg.idleTimeoutMs).toBe(60000)
    expect(cfg.secureCookies).toBe(true)
  })
})
