import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { ProjectRuntime } from './instances.ts'
import type { ModelUsageSubject } from './model-governance.ts'
import type { GatewayModelGovernanceService } from './services.ts'
import type { UserRow } from './auth.ts'
import type { GatewayDeps } from './server.ts'

interface PreviousPolicy { intakeToken?: unknown }

function sameSubject(left: ModelUsageSubject | null, right: ModelUsageSubject): boolean {
  return left?.kind === right.kind && left.id === right.id
}

async function writeProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelUsageSubject,
  policy: Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>,
): Promise<string> {
  const path = join(dshHome, 'model-governance.json')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  let token: string | undefined
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8')) as PreviousPolicy
      if (typeof previous.intakeToken === 'string'
        && sameSubject(await governance.subjectForIntakeToken(previous.intakeToken), subject)) {
        token = previous.intakeToken
      }
    } catch { /* replace malformed old projection */ }
  }
  token ??= await governance.issueIntakeToken(subject)
  const body = {
    ...policy,
    intakeUrl: `http://127.0.0.1:${cfg.intakePort}/usage`,
    intakeToken: token,
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
  return path
}

/** Atomically project one user's effective model policy and stable intake credential. */
export async function writeModelGovernanceFile(
  cfg: GatewayConfig, governance: GatewayModelGovernanceService, user: UserRow,
): Promise<string> {
  return writeProjection(
    cfg,
    governance,
    join(cfg.usersRoot, user.username, 'dsh'),
    { kind: 'user', id: user.id },
    await governance.policyFor(user),
  )
}

/** Atomically project the shared member policy and project-owned intake credential. */
export async function writeProjectModelGovernanceFile(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
): Promise<string> {
  return writeProjection(
    cfg,
    governance,
    join(cfg.projectRuntimesRoot, String(project.id), 'dsh'),
    { kind: 'project', id: project.id },
    await governance.policyForProject(project.id),
  )
}

/** Rewrite policy; a running instance applies it through the plugin's file watcher. */
export async function applyModelGovernanceToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'users'>,
  userId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const user = await deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  await writeModelGovernanceFile(deps.cfg, deps.governance, user)
}

/** Rewrite one project's shared policy; a running runtime applies it through the file watcher. */
export async function applyModelGovernanceToProject(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'projects'>,
  projectId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const project = await deps.projects.getById(projectId)
  if (project === null) throw new Error(`no project ${projectId}`)
  await writeProjectModelGovernanceFile(deps.cfg, deps.governance, {
    kind: 'project',
    id: project.id,
    name: project.name,
    path: project.path,
  })
}
