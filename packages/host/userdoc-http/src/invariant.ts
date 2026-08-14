/** Package-owned invariant companion for `@deepseek-ai/dsh-host-userdoc-http`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-userdoc-http'
export const name = 'host-userdoc-http-invariant'
export const inject = ['invariants']
/** No runtime invariant: Connection owns registration disposal; real-composition coverage probes removal. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
