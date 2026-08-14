import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_NAME_EXHAUSTED_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import {
  assertInside,
  docIdFor,
  isInside,
  pathForDocId,
  resolveTargetIn,
  sanitizeName,
  suffixName,
} from '../src/name.ts'

const ROOT = join(sep, 'home', 'alice', 'uploads')

describe('sanitizeName', () => {
  it('keeps an ordinary name, including non-ASCII, unchanged', () => {
    expect(sanitizeName('年报.pdf')).toBe('年报.pdf')
  })

  it('reduces a POSIX path to its leaf', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd')
  })

  it('reduces a Windows path to its leaf, which basename alone would keep on POSIX', () => {
    expect(sanitizeName('C:\\Users\\bob\\secrets.txt')).toBe('secrets.txt')
  })

  it('rejects a trailing traversal that would otherwise reach the parent', () => {
    expect(() => sanitizeName('report/../..')).toThrow(UserDocError)
    expect(() => sanitizeName('..')).toThrow(UserDocError)
  })

  it('strips NUL and other control characters', () => {
    expect(sanitizeName('re\u0000port\u001f.txt')).toBe('report.txt')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeName('  notes.md  ')).toBe('notes.md')
  })

  it('truncates by bytes rather than code units, so a multi-byte name stays within the filesystem limit', () => {
    const name = sanitizeName(`${'年'.repeat(200)}.pdf`)
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(255)
    expect(name.endsWith('\uFFFD')).toBe(false)
  })

  it('rejects a name that is only dots', () => {
    expect(() => sanitizeName('...')).toThrow(UserDocError)
  })

  it('rejects a name that sanitizes away to nothing', () => {
    expect(() => sanitizeName('\u0000\u0001')).toThrow(UserDocError)
  })

  it('rejects an empty name', () => {
    expect(() => sanitizeName('')).toThrow(UserDocError)
  })

  it('rejects a bare directory reference', () => {
    expect(() => sanitizeName('.')).toThrow(UserDocError)
  })

  it('rejects a path with no leaf left after the separator', () => {
    expect(() => sanitizeName('some/directory/')).toThrow(UserDocError)
  })
})

describe('suffixName', () => {
  it('returns the first occurrence unchanged', () => {
    expect(suffixName('report.pdf', 1)).toBe('report.pdf')
  })

  it('suffixes before the extension so the file keeps its type', () => {
    expect(suffixName('report.pdf', 2)).toBe('report (2).pdf')
  })

  it('treats a leading dot as part of the stem', () => {
    expect(suffixName('.env', 3)).toBe('.env (3)')
  })

  it('suffixes an extensionless name at its end', () => {
    expect(suffixName('README', 2)).toBe('README (2)')
  })

  it('uses the last dot, so only the final extension is preserved', () => {
    expect(suffixName('archive.tar.gz', 2)).toBe('archive.tar (2).gz')
  })
})

describe('isInside', () => {
  it('accepts the root itself', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
  })

  it('accepts a nested descendant', () => {
    expect(isInside(ROOT, join(ROOT, '2026-08-14', 'a.pdf'))).toBe(true)
  })

  it('rejects the parent directory', () => {
    expect(isInside(ROOT, join(sep, 'home', 'alice'))).toBe(false)
  })

  it('rejects a sibling whose name merely starts with the root name, which a string prefix check would accept', () => {
    expect(isInside(ROOT, `${ROOT}-other`)).toBe(false)
  })

  it('rejects an escape through a traversal segment', () => {
    expect(isInside(ROOT, join(ROOT, '..', '..', 'etc', 'passwd'))).toBe(false)
  })
})

describe('assertInside', () => {
  it('passes a contained path', () => {
    expect(() => { assertInside(ROOT, join(ROOT, 'a.txt')) }).not.toThrow()
  })

  it('rejects an escaping path', () => {
    expect(() => { assertInside(ROOT, join(sep, 'etc', 'passwd')) })
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })
})

describe('docIdFor', () => {
  it('identifies a document by its root-relative path with forward slashes', () => {
    expect(docIdFor(ROOT, join(ROOT, '2026-08-14', 'a.pdf'))).toBe('2026-08-14/a.pdf')
  })
})

describe('pathForDocId', () => {
  it('resolves an ordinary identifier back to its absolute path', () => {
    expect(pathForDocId(ROOT, '2026-08-14/a.pdf')).toBe(join(ROOT, '2026-08-14', 'a.pdf'))
  })

  it('rejects a traversal segment', () => {
    expect(() => pathForDocId(ROOT, '../../etc/passwd'))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('rejects an absolute spelling', () => {
    expect(() => pathForDocId(ROOT, '/etc/passwd'))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('rejects a Windows separator, which POSIX would treat as an ordinary character', () => {
    expect(() => pathForDocId(ROOT, '..\\..\\etc\\passwd'))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('rejects a current-directory segment', () => {
    expect(() => pathForDocId(ROOT, './a.pdf'))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('rejects an empty identifier', () => {
    expect(() => pathForDocId(ROOT, ''))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('rejects an empty segment from a doubled separator', () => {
    expect(() => pathForDocId(ROOT, '2026-08-14//a.pdf'))
      .toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })
})

describe('resolveTargetIn', () => {
  const free = async (): Promise<boolean> => false

  it('resolves a free name to its first occurrence', async () => {
    const target = await resolveTargetIn(ROOT, join(ROOT, 'day'), '年报.pdf', free)
    expect(target).toEqual({
      path: join(ROOT, 'day', '年报.pdf'),
      name: '年报.pdf',
      docId: 'day/年报.pdf',
    })
  })

  it('sanitizes a path-bearing name to a leaf inside the target directory', async () => {
    const target = await resolveTargetIn(ROOT, join(ROOT, 'day'), '../../etc/passwd', free)
    expect(target.path).toBe(join(ROOT, 'day', 'passwd'))
  })

  it('suffixes past taken names instead of overwriting', async () => {
    const taken = new Set([join(ROOT, 'day', 'a.pdf'), join(ROOT, 'day', 'a (2).pdf')])
    const target = await resolveTargetIn(ROOT, join(ROOT, 'day'), 'a.pdf', async path => taken.has(path))
    expect(target.name).toBe('a (3).pdf')
  })

  it('rejects a directory outside the root before touching the name', async () => {
    await expect(resolveTargetIn(ROOT, join(sep, 'tmp'), 'a.pdf', free))
      .rejects.toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_REF_CODE }))
  })

  it('gives up rather than scanning without bound when every candidate is taken', async () => {
    await expect(resolveTargetIn(ROOT, join(ROOT, 'day'), 'a.pdf', async () => true))
      .rejects.toThrow(expect.objectContaining({ code: DOCUMENT_NAME_EXHAUSTED_CODE }))
  })

  it('propagates an unusable name', async () => {
    await expect(resolveTargetIn(ROOT, join(ROOT, 'day'), '..', free))
      .rejects.toThrow(expect.objectContaining({ code: INVALID_DOCUMENT_NAME_CODE }))
  })

  it('keeps a collision suffix within the filesystem byte limit', () => {
    const name = suffixName(`${'年'.repeat(85)}.pdf`, 1000)
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(255)
    expect(name).toMatch(/ \(1000\)\.pdf$/)
  })
})
