/** Package-owned invariant companion for `@deepseek-ai/dsh-userdoc-local`. @module @deepseek-ai/dsh-userdoc-local/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-userdoc-local'
/** Cordis companion plugin name. */
export const name = 'userdoc-local-invariant'
/** Services required before package ownership can be reserved. */
export const inject = ['invariants', 'userDocs']
/**
 * No runtime invariant: upload-root containment is enforced inside each
 * filesystem operation, where a bypassing caller cannot reach around it.
 */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
