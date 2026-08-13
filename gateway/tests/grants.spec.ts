import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { GrantService } from '../src/grants.ts'
import { UserService } from '../src/users.ts'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const users = new UserService(db, loadConfig({ HGW_USERS_ROOT: join(root, 'users') }))
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  const shared = join(root, 'shared'); mkdirSync(shared)
  const docs = join(root, 'docs'); mkdirSync(docs)
  return { db, grants: new GrantService(db), alice, shared, docs }
}

describe('GrantService', () => {
  it('merges user and group grants with rw beating ro, home always rw', async () => {
    const { grants, alice, shared, docs } = await setup()
    const g = grants.createGroup('team-a')
    grants.addMember(g, alice.id)
    grants.addGrant({ subjectType: 'group', subjectId: g, path: shared, mode: 'ro' })
    grants.addGrant({ subjectType: 'user', subjectId: alice.id, path: shared, mode: 'rw' })
    grants.addGrant({ subjectType: 'group', subjectId: g, path: docs, mode: 'ro' })
    const effective = grants.effectiveGrants(alice.id)
    expect(effective).toContainEqual({ path: realpathSync(shared), mode: 'rw' })
    expect(effective).toContainEqual({ path: realpathSync(docs), mode: 'ro' })
    expect(effective).toContainEqual({ path: alice.homePath, mode: 'rw' })
  })

  it('rejects grants on missing paths and cleans up with group deletion', async () => {
    const { grants, alice } = await setup()
    expect(() => grants.addGrant({ subjectType: 'user', subjectId: alice.id, path: '/no/such/dir-xyz', mode: 'ro' }))
      .toThrow()
    const g = grants.createGroup('temp')
    grants.addMember(g, alice.id)
    grants.deleteGroup(g)
    expect(grants.listGroups()).toHaveLength(0)
  })
})
