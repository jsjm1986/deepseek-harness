import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { ProjectService } from '../src/projects.ts'
import { UserService } from '../src/users.ts'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users') })
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  const shared = join(root, 'shared'); mkdirSync(shared)
  const docs = join(root, 'docs'); mkdirSync(docs)
  return { db, cfg, users, projects: new ProjectService(db, cfg), alice, shared, docs, root }
}

describe('ProjectService', () => {
  it('effective grants are home plus member projects with labels', async () => {
    const { projects, alice, shared } = await setup()
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'ro')
    expect(projects.effectiveGrants(alice.id)).toEqual([
      { path: alice.homePath, mode: 'rw', label: '主目录' },
      { path: realpathSync(shared), mode: 'ro', label: 'Alpha' },
    ])
  })

  it('omits projects the user is not a member of', async () => {
    const { projects, users, alice, shared } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.effectiveGrants(bob.id)).toEqual([
      { path: bob.homePath, mode: 'rw', label: '主目录' },
    ])
  })

  it('rejects duplicate name, duplicate path, missing path, home, and dsh path', async () => {
    const { projects, cfg, alice, shared, docs } = await setup()
    projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    expect(() => projects.create({ name: 'Alpha', path: docs, createdBy: alice.id })).toThrow()
    expect(() => projects.create({ name: 'Beta', path: shared, createdBy: alice.id })).toThrow()
    expect(() => projects.create({ name: 'Ghost', path: join(cfg.usersRoot, 'no-such-dir'), createdBy: alice.id })).toThrow()
    expect(() => projects.create({ name: 'Home', path: alice.homePath, createdBy: alice.id })).toThrow()
    expect(() => projects.create({ name: 'Dsh', path: join(cfg.usersRoot, 'alice', 'dsh'), createdBy: alice.id })).toThrow()
  })

  it('setMember updates mode', async () => {
    const { projects, alice, shared } = await setup()
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'ro')
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.effectiveGrants(alice.id)).toContainEqual({
      path: realpathSync(shared), mode: 'rw', label: 'Alpha',
    })
    expect(projects.getById(p.id)?.members).toEqual([
      { userId: alice.id, username: 'alice', mode: 'rw' },
    ])
  })

  it('remove returns sorted member ids', async () => {
    const { projects, users, alice, shared } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, bob.id, 'ro')
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.remove(p.id)).toEqual([alice.id, bob.id].sort((a, b) => a - b))
    expect(projects.getById(p.id)).toBeNull()
    expect(projects.effectiveGrants(alice.id)).toEqual([
      { path: alice.homePath, mode: 'rw', label: '主目录' },
    ])
  })
})
