import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Grant } from '../src/grants.ts'
import { decideDeny } from '../src/guard.ts'

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dg-')))
}

describe('decideDeny', () => {
  it('allows writes inside an rw grant and denies outside', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: { file_path: join(proj, 'a.ts'), content: 'x' } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'edit', arguments: { file_path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    const denied = decideDeny({ name: 'write', arguments: { file_path: join(root, 'outside.ts'), content: 'x' } }, grants, root)
    expect(denied).toContain('outside.ts')
  })

  it('denies writes to a read-only grant but allows reads there', () => {
    const root = scratch()
    const docs = join(root, 'docs'); mkdirSync(docs)
    const grants: Grant[] = [{ path: docs, mode: 'ro' }]
    expect(decideDeny({ name: 'read', arguments: { file_path: join(docs, 'r.md') } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'write', arguments: { file_path: join(docs, 'r.md'), content: 'x' } }, grants, root)).not.toBeNull()
  })

  it('handles str_replace_editor commands (view read vs create/str_replace/insert write)', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'view', path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'create', path: join(proj, 'a.ts'), file_text: 'x' } }, grants, root)).not.toBeNull()
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: join(proj, 'a.ts') } }, grants, root)).not.toBeNull()
  })

  it('denies reads entirely outside any grant', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(decideDeny({ name: 'read', arguments: { file_path: '/etc/hosts' } }, grants, root)).not.toBeNull()
  })

  it('resolves relative paths against cwd and blocks .. escapes', () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: { file_path: 'note.txt', content: 'x' } }, grants, home)).toBeNull()
    expect(decideDeny({ name: 'write', arguments: { file_path: '../escape.txt', content: 'x' } }, grants, home)).not.toBeNull()
  })

  it('delegates (null) for tools without a known path argument', () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(decideDeny({ name: 'bash', arguments: { command: 'ls /etc' } }, grants, '/x')).toBeNull()
    expect(decideDeny({ name: 'web_search', arguments: { query: 'hi' } }, grants, '/x')).toBeNull()
  })

  it('denies when a path argument is missing or not a string', () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: {} }, grants, '/x')).not.toBeNull()
    expect(decideDeny({ name: 'read', arguments: { file_path: 123 } }, grants, '/x')).not.toBeNull()
  })
})
