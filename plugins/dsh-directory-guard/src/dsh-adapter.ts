/**
 * The ONLY module that imports dsh-internal types. Concentrating the coupling
 * here means an upstream rename of the tool pipeline touches one file (see the
 * design doc's upstream-sync strategy). Everything else in this plugin is pure
 * Node logic.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { decideDeny } from './guard.ts'
import type { Grant } from './grants.ts'

/** Best-effort session cwd from an execution, for resolving relative tool paths. */
function sessionCwd(exec: ToolExecution): string | undefined {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } }).agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : undefined
}

/**
 * Register the directory guard on `tools/pre-execute`. Denies fs tool calls that
 * resolve outside the caller's grants; delegates every tool without a known path
 * argument (bash and other opaque tools stay bounded by the sandbox/kernel layer).
 * @returns the listener disposer (also unwound automatically on plugin unload).
 */
export function registerGuard(ctx: Context, getGrants: () => readonly Grant[]): () => void {
  return ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const reason = decideDeny(
        { name: exec.name, arguments: exec.arguments },
        getGrants(),
        sessionCwd(exec) ?? process.cwd(),
      )
      return reason === null ? next() : { kind: 'deny', reason }
    },
  )
}
