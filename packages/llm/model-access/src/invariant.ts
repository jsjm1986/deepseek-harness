/** Runtime invariant companion for model-access. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-access'
export const name = 'model-access-invariant'
export const inject = ['invariants']

// No runtime invariant: every decision is a pure read from the mounted provider.
const install: InvariantInstaller = () => {}

/** Register package ownership with the invariant registry. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
