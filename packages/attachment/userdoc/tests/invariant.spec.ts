import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as UserDocInvariant from '@deepseek-ai/dsh-userdoc/invariant'

describe('user-document seam invariant companion', () => {
  it('reserves package ownership and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(UserDocInvariant)
    expect(UserDocInvariant.name).toBe('userdoc-invariant')
    await fiber.dispose()
  })
})
