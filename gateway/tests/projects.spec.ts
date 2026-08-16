import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECTS_ROOT: join(root, 'projects'),
  })
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  const shared = join(root, 'shared'); mkdirSync(shared)
  const docs = join(root, 'docs'); mkdirSync(docs)
  return { db, cfg, users, projects: new ProjectService(db, cfg), alice, shared, docs, root }
}

describe('ProjectService', () => {
  it('creates a managed directory from a name when no path is supplied', async () => {
    const { projects, cfg, alice } = await setup()
    const project = projects.create({ name: '  产品文档  ', createdBy: alice.id })
    expect(project.name).toBe('产品文档')
    expect(project.path).toBe(realpathSync(join(cfg.projectsRoot, '产品文档')))
    expect(statSync(project.path).isDirectory()).toBe(true)
    expect(statSync(project.path).mode & 0o777).toBe(0o770)
  })

  it('rejects managed names that could escape the project root', async () => {
    const { projects, alice } = await setup()
    expect(() => projects.create({ name: '../outside', createdBy: alice.id })).toThrow('project-name-invalid')
    expect(() => projects.create({ name: 'nested/docs', createdBy: alice.id })).toThrow('project-name-invalid')
  })

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
    const { projects, cfg, alice, shared, docs, root } = await setup()
    projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    expect(() => projects.create({ name: 'Alpha', path: docs, createdBy: alice.id })).toThrow(/duplicate project name/)
    expect(() => projects.create({ name: 'Beta', path: shared, createdBy: alice.id })).toThrow(/duplicate project path/)
    expect(() => projects.create({ name: 'Ghost', path: join(cfg.usersRoot, 'no-such-dir'), createdBy: alice.id }))
      .toThrow('project-path-not-found')
    const file = join(root, 'file')
    writeFileSync(file, 'not a directory')
    expect(() => projects.create({ name: 'File', path: file, createdBy: alice.id }))
      .toThrow('project-path-not-directory')
    expect(() => projects.create({ name: 'Home', path: alice.homePath, createdBy: alice.id })).toThrow(/user home/)
    expect(() => projects.create({ name: 'Dsh', path: join(cfg.usersRoot, 'alice', 'dsh'), createdBy: alice.id })).toThrow(/dsh/)
  })

  it('rejects project paths nested inside another project or reserved runtime data', async () => {
    const { projects, cfg, alice, shared, root } = await setup()
    projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    const nested = join(shared, 'nested')
    mkdirSync(nested)
    expect(() => projects.create({ name: 'Nested', path: nested, createdBy: alice.id }))
      .toThrow(/overlaps existing project/)
    expect(() => projects.create({ name: 'Users root', path: cfg.usersRoot, createdBy: alice.id }))
      .toThrow(/reserved path/)
    const parent = realpathSync(root)
    expect(() => projects.create({ name: 'Parent', path: parent, createdBy: alice.id }))
      .toThrow(/reserved path|user home/)
  })

  it('creates a project when another user dsh directory is missing', async () => {
    const { projects, users, alice, shared, cfg } = await setup()
    await users.create({ username: 'bob', password: 'pw-123456' })
    rmSync(join(cfg.usersRoot, 'bob', 'dsh'), { recursive: true })
    expect(projects.create({ name: 'Alpha', path: shared, createdBy: alice.id }).name).toBe('Alpha')
  })

  it('rethrows non-unique sqlite constraints unchanged', async () => {
    const { projects, docs } = await setup()
    try {
      projects.create({ name: 'Orphan', path: docs, createdBy: 999 })
      expect.unreachable('expected foreign-key failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
      expect((error as Error).message).not.toMatch(/duplicate/i)
    }
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

  it('creates user-owned projects below the managed root and protects the owner grant', async () => {
    const { projects, users, alice, cfg } = await setup()
    const project = projects.createManaged({ name: '用户项目', ownerUserId: alice.id })
    expect(project).toMatchObject({
      origin: 'user',
      owner: { id: alice.id, username: 'alice' },
      createdBy: { id: alice.id, username: 'alice' },
      memberCount: 1,
    })
    expect(project.path.startsWith(realpathSync(cfg.userProjectsRoot))).toBe(true)
    expect(projects.getById(project.id)?.members).toEqual([
      { userId: alice.id, username: 'alice', mode: 'rw' },
    ])
    expect(() => projects.setMember(project.id, alice.id, 'ro')).toThrow('owner-must-be-rw')
    expect(() => projects.removeMember(project.id, alice.id)).toThrow('owner-protected')
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    projects.setMember(project.id, bob.id, 'ro')
    expect(projects.getById(project.id)?.members).toContainEqual({ userId: bob.id, username: 'bob', mode: 'ro' })
  })

  it('creates, lists, rejects duplicate, and accepts project invitations', async () => {
    const { projects, users, alice } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const project = projects.createManaged({ name: '邀请项目', ownerUserId: alice.id })
    const invitation = projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'rw',
    })
    expect(invitation).toMatchObject({
      projectId: project.id, invitee: { id: bob.id, username: 'bob' },
      inviter: { id: alice.id, username: 'alice' }, mode: 'rw', status: 'pending',
    })
    expect(projects.listInvitations(bob.id)).toContainEqual(invitation)
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })).toThrow('invitation-already-pending')
    projects.acceptInvitation(invitation.id, bob.id)
    expect(projects.getById(project.id)?.members).toContainEqual({
      userId: bob.id, username: 'bob', mode: 'rw',
    })
    expect(projects.listInvitations(bob.id)[0]?.status).toBe('accepted')
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })).toThrow('invitation-already-member')
  })

  it('normalizes names, protects invitation authority, and commits expiry state', async () => {
    const { projects, users, alice, db } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const project = projects.createManaged({ name: '  Managed name  ', ownerUserId: alice.id })
    expect(project.name).toBe('Managed name')
    projects.rename(project.id, '  Renamed  ')
    expect(projects.getById(project.id)?.name).toBe('Renamed')
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: alice.id, inviterUserId: bob.id, mode: 'ro',
    })).toThrow('invitation-forbidden')

    const invitation = projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })
    db.prepare(`UPDATE project_invitations SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, Number(invitation.id))
    expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-expired')
    expect((db.prepare(`SELECT status FROM project_invitations WHERE id = ?`).get(Number(invitation.id)) as { status: string }).status)
      .toBe('expired')
    expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-not-pending')
    expect(() => projects.acceptInvitation('not-an-id', bob.id)).toThrow('invitation-not-found')
    expect(() => projects.rename(project.id, '   ')).toThrow('project-name-invalid')
  })
})
