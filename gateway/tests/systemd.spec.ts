import { describe, expect, it } from 'vitest'
import { renderUserUnit, unitName, type SystemdOptions, type SystemdUser } from '../src/systemd.ts'

const OPTS: SystemdOptions = {
  usersRoot: '/srv/harness/users',
  execStart: '/usr/local/bin/node /opt/dsh/lib/bin.js web --port {port}',
  gatewayDir: '/srv/harness/gateway',
  memoryMax: '1G',
  cpuQuota: '100%',
}

const ALICE: SystemdUser = {
  username: 'alice',
  port: 42001,
  homePath: '/srv/harness/users/alice/home',
  dshHome: '/srv/harness/users/alice/dsh',
}

describe('unitName', () => {
  it('derives a per-user unit name', () => {
    expect(unitName('alice')).toBe('harness-alice.service')
  })
})

describe('renderUserUnit', () => {
  const grants = [
    { path: '/srv/harness/users/alice/home', mode: 'rw' as const },
    { path: '/data/team-alpha', mode: 'rw' as const },
    { path: '/data/company-docs', mode: 'ro' as const },
  ]
  const unit = renderUserUnit(ALICE, grants, OPTS)

  it('applies kernel hardening: strict system, no-new-privs, private tmp', () => {
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('NoNewPrivileges=yes')
    expect(unit).toContain('PrivateTmp=yes')
    expect(unit).toContain('ProtectHome=yes')
  })

  it('hides all user dirs then binds only this user home and grants', () => {
    // Every user directory is masked read-only...
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/users:ro')
    // ...then this user's home + rw grants are bound writable...
    expect(unit).toContain('BindPaths=/srv/harness/users/alice/home')
    expect(unit).toContain('BindPaths=/data/team-alpha')
    // ...and ro grants bound read-only.
    expect(unit).toContain('BindReadOnlyPaths=/data/company-docs')
    // A ro grant must NOT appear as a writable bind.
    expect(unit).not.toContain('BindPaths=/data/company-docs')
  })

  it('marks the gateway dir inaccessible', () => {
    expect(unit).toContain('InaccessiblePaths=-/srv/harness/gateway')
  })

  it('runs as a per-user system account under the user home with the grants file', () => {
    expect(unit).toContain('User=harness-alice')
    expect(unit).toContain('WorkingDirectory=/srv/harness/users/alice/home')
    expect(unit).toContain('Environment=DSH_HOME=/srv/harness/users/alice/dsh')
    expect(unit).toContain('Environment=DSH_DIRECTORY_GRANTS=/srv/harness/users/alice/dsh/directory-grants.json')
  })

  it('substitutes the port into ExecStart and applies resource limits', () => {
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/dsh/lib/bin.js web --port 42001')
    expect(unit).toContain('MemoryMax=1G')
    expect(unit).toContain('CPUQuota=100%')
  })

  it('rejects grant paths that would break the unit file (newline / colon)', () => {
    expect(() => renderUserUnit(ALICE, [{ path: '/data/evil\nExecStart=/bin/sh', mode: 'rw' }], OPTS)).toThrow()
    expect(() => renderUserUnit(ALICE, [{ path: '/data/a:b', mode: 'rw' }], OPTS)).toThrow()
  })

  it('rejects an unsafe username', () => {
    expect(() => renderUserUnit({ ...ALICE, username: 'bad name' }, grants, OPTS)).toThrow()
  })
})
