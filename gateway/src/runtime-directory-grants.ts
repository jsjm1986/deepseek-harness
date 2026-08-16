/** Role-aware directory grants projected into personal runtimes. @module */

import { parse } from 'node:path'
import type { UserRow } from './auth.ts'
import type { EffectiveGrant } from './projects.ts'
import type { GatewayProjectService } from './services.ts'

/**
 * Resolve the complete directory grants for one personal runtime.
 * @param user - runtime owner whose current role selects the grant scope
 * @param projects - source of home and project grants for regular users
 * @returns a filesystem-root rw grant for administrators, otherwise the user's effective grants
 */
export async function runtimeDirectoryGrants(
  user: UserRow,
  projects: GatewayProjectService,
): Promise<EffectiveGrant[]> {
  if (user.role !== 'admin') return projects.effectiveGrants(user.id)
  const root = parse(user.homePath).root
  if (root === '') throw new Error(`admin home path has no filesystem root: ${user.homePath}`)
  return [{ path: root, mode: 'rw', label: root }]
}
