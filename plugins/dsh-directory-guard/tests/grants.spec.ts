import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, loadGrants } from '../src/grants.ts'

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dg-')))
}

describe('loadGrants', () => {
  it('returns [] when the file is absent', () => {
    expect(loadGrants(join(scratch(), 'nope.json'))).toEqual([])
  })

  it('loads, realpaths, drops missing dirs, and sorts by path length desc', () => {
    const root = scratch()
    const a = join(root, 'a'); mkdirSync(a)
    const ab = join(root, 'a', 'b'); mkdirSync(ab)
    const file = join(root, 'grants.json')
    writeFileSync(file, JSON.stringify([
      { path: a, mode: 'ro' },
      { path: ab, mode: 'rw' },
      { path: join(root, 'ghost'), mode: 'rw' },
    ]))
    const grants = loadGrants(file)
    expect(grants.map(g => g.path)).toEqual([ab, a])
    expect(grants.find(g => g.path === ab)?.mode).toBe('rw')
  })
})

describe('classify', () => {
  it('matches containment with longest-prefix winning', () => {
    const root = scratch()
    const a = join(root, 'a'); mkdirSync(a)
    const ab = join(root, 'a', 'b'); mkdirSync(ab)
    const grants = [
      { path: ab, mode: 'rw' as const },
      { path: a, mode: 'ro' as const },
    ]
    expect(classify(grants, join(ab, 'c.ts'))).toBe('rw')
    expect(classify(grants, join(a, 'x.ts'))).toBe('ro')
    expect(classify(grants, ab)).toBe('rw')
    expect(classify(grants, a)).toBe('ro')
    expect(classify(grants, join(root, 'other', 'y.ts'))).toBe('none')
  })

  it('does not treat a sibling prefix as containment', () => {
    const grants = [{ path: '/data/team', mode: 'rw' as const }]
    expect(classify(grants, '/data/team-secret/x')).toBe('none')
    expect(classify(grants, '/data/team/x')).toBe('rw')
  })
})
