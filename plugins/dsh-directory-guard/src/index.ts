import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { registerGuard } from './dsh-adapter.ts'
import { loadGrants } from './grants.ts'

export const name = 'dsh-directory-guard'
export const inject = ['tools']

/**
 * Mount the directory guard. Grants are read once from
 * `$DSH_DIRECTORY_GRANTS` (or `$DSH_HOME/directory-grants.json`): the gateway
 * rewrites that file and restarts the instance on any change, so a live process
 * always reflects the current grants. Registration is a reversible `ctx.on`
 * effect, so unload/HMR unwinds it.
 */
export function apply(ctx: Context): void {
  const file = process.env.DSH_DIRECTORY_GRANTS
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'directory-grants.json')
  const grants = loadGrants(file)
  registerGuard(ctx, () => grants)
}
