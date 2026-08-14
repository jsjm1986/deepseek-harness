/**
 * Keyless snapshot of the guard's model-visible output: the deny reason is what
 * the model reads back as the tool result, so its wording is pinned here —
 * a reworded denial must be a conscious diff, not an accident. Scratch roots
 * are randomized by mkdtemp, so paths are normalized to {{root}} before
 * snapshotting.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Grant } from '../src/grants.ts'
import { decideDeny } from '../src/guard.ts'

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dg-snap-')))
}

function normalized(reason: string | null, root: string): string | null {
  return reason === null ? null : reason.split(root).join('{{root}}')
}

describe('deny wording (model-visible tool result)', () => {
  it('write outside every grant', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    const reason = decideDeny({ name: 'write', arguments: { file_path: join(root, 'escape.ts'), content: 'x' } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Write to {{root}}/escape.ts is not permitted: outside your read-write directories."`,
    )
  })

  it('write into a read-only grant', () => {
    const root = scratch()
    const docs = join(root, 'docs'); mkdirSync(docs)
    const grants: Grant[] = [{ path: docs, mode: 'ro' }]
    const reason = decideDeny({ name: 'write', arguments: { file_path: join(docs, 'note.md'), content: 'x' } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Write to {{root}}/docs/note.md is not permitted: outside your read-write directories."`,
    )
  })

  it('read outside every grant', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    const reason = decideDeny({ name: 'read', arguments: { file_path: join(root, 'secret.txt') } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Access to {{root}}/secret.txt is not permitted: outside your allowed directories."`,
    )
  })

  it('malformed path argument on a path tool (fails closed)', () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: {} }, grants, '/x')).toMatchInlineSnapshot(
      `"write: missing or invalid path argument"`,
    )
  })

  it('in-grant write stays allowed (no denial text at all)', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: { file_path: join(proj, 'ok.ts'), content: 'x' } }, grants, root)).toBeNull()
  })
})
