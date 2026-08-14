import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { ModelGovernanceService } from './model-governance.ts'
import type { UserRow } from './auth.ts'
import type { GatewayDeps } from './server.ts'

interface PreviousPolicy { intakeToken?: unknown }

/** Atomically project one user's effective model policy and stable intake credential. */
export function writeModelGovernanceFile(
  cfg: GatewayConfig, governance: ModelGovernanceService, user: UserRow,
): string {
  const dir = join(cfg.usersRoot, user.username, 'dsh')
  const path = join(dir, 'model-governance.json')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let token: string | undefined
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8')) as PreviousPolicy
      if (typeof previous.intakeToken === 'string' && governance.userForIntakeToken(previous.intakeToken) === user.id) token = previous.intakeToken
    } catch { /* replace malformed old projection */ }
  }
  token ??= governance.issueIntakeToken(user.id)
  const body = { ...governance.policyFor(user), intakeUrl: `http://127.0.0.1:${cfg.intakePort}/usage`, intakeToken: token }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
  return path
}

/** Rewrite policy and restart only an already-running instance. */
export async function applyModelGovernanceToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'users' | 'instances' | 'audit'>,
  userId: number,
  actorId: number,
): Promise<'restarted' | 'written'> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const user = deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  writeModelGovernanceFile(deps.cfg, deps.governance, user)
  const state = deps.instances.stateOf(userId)
  if (state !== 'ready' && state !== 'starting') return 'written'
  try {
    await deps.instances.stop(userId)
    await deps.instances.ensureRunning(user)
    return 'restarted'
  } catch (error) {
    deps.audit.write({ userId: actorId, action: 'admin.model-governance.restart-failed', detail: JSON.stringify({ userId, error: String(error) }) })
    throw error
  }
}
