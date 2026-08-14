import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { EffectiveGrant } from './projects.ts'
import type { GatewayDeps } from './server.ts'

/**
 * Write pretty-printed grants to `$DSH_HOME/directory-grants.json`, creating the directory.
 * @param cfg - gateway config (`usersRoot`)
 * @param username - instance owner
 * @param grants - effective grants including home
 * @returns absolute path of the written file
 */
export function writeGrantsFile(cfg: GatewayConfig, username: string, grants: EffectiveGrant[]): string {
  const dir = join(cfg.usersRoot, username, 'dsh')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'directory-grants.json')
  writeFileSync(path, JSON.stringify(grants, null, 2))
  return path
}

/**
 * Recompute a user's grants file; restart the instance only when it is `ready` or `starting`.
 * Restart failure writes `admin.instances.restart-failed` (actor as `userId`) then rethrows.
 * @param deps - cfg, projects, users, instances, audit
 * @param userId - user whose grants changed
 * @param actorId - admin who triggered the change
 * @returns `'restarted'` after stop+start; `'written'` when the instance was already stopped
 */
export async function applyGrantsToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'projects' | 'users' | 'instances' | 'audit'>,
  userId: number,
  actorId: number,
): Promise<'restarted' | 'written'> {
  const user = deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  writeGrantsFile(deps.cfg, user.username, deps.projects.effectiveGrants(userId))
  const state = deps.instances.stateOf(userId)
  if (state !== 'ready' && state !== 'starting') return 'written'
  try {
    await deps.instances.stop(userId)
    await deps.instances.ensureRunning(user)
    return 'restarted'
  } catch (error) {
    deps.audit.write({
      userId: actorId,
      action: 'admin.instances.restart-failed',
      detail: JSON.stringify({ userId, error: String(error) }),
    })
    throw error
  }
}
