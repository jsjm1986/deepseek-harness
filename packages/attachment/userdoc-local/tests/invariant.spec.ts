import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as UserDocLocalInvariant from '@deepseek-ai/dsh-userdoc-local/invariant'
import LocalUserDocStore from '../src/index.ts'

describe('local user-document invariant companion', () => {
  it('reserves package ownership once its provider is present', async () => {
    const uploadRoot = await mkdtemp(join(tmpdir(), 'dsh-userdoc-invariant-'))
    try {
      const ctx = new Context()
      await ctx.plugin(InvariantRegistry)
      await ctx.plugin(LocalUserDocStore, { uploadRoot })
      const fiber = await ctx.plugin(UserDocLocalInvariant)
      expect(UserDocLocalInvariant.name).toBe('userdoc-local-invariant')
      expect(UserDocLocalInvariant.inject).toContain('userDocs')
      await fiber.dispose()
    } finally {
      await rm(uploadRoot, { recursive: true, force: true })
    }
  })
})
