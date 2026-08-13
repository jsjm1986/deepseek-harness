import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { classify, type Grant } from './grants.ts'

/** Minimal structural view of a tool execution the guard needs (no dsh import). */
export interface GuardExecution {
  readonly name: string
  readonly arguments: unknown
}

interface PathTarget {
  path: string
  isWrite: boolean
}

/**
 * Extract the filesystem target of a tool call, or `undefined` when the tool
 * has no path argument this guard understands (delegated to the next listener;
 * bash and other opaque tools are bounded by the sandbox/kernel layer instead).
 * Returns `null` when the tool DOES take a path but the argument is missing or
 * malformed, so the guard fails closed rather than passing an unresolved call.
 */
function targetOf(exec: GuardExecution): PathTarget | undefined | null {
  const args = (typeof exec.arguments === 'object' && exec.arguments !== null)
    ? exec.arguments as Record<string, unknown>
    : {}
  const filePathTools: Record<string, boolean> = { read: false, write: true, edit: true }
  if (exec.name in filePathTools) {
    const p = args.file_path
    if (typeof p !== 'string' || p.trim() === '') return null
    return { path: p, isWrite: filePathTools[exec.name] === true }
  }
  if (exec.name === 'str_replace_editor') {
    const p = args.path
    if (typeof p !== 'string' || p.trim() === '') return null
    return { path: p, isWrite: args.command !== 'view' }
  }
  return undefined
}

/**
 * Canonicalize a (possibly relative) path against `cwd`: resolve it, then
 * realpath the nearest existing ancestor and re-append the non-existing tail.
 * This defeats symlinked-directory escapes while still classifying a not-yet
 * created file by the real identity of the directory it would land in.
 */
export function canonicalize(target: string, cwd: string): string {
  let resolved = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
  const tail: string[] = []
  while (!existsSync(resolved)) {
    const parent = dirname(resolved)
    if (parent === resolved) return resolved
    tail.unshift(resolved.slice(parent.length + 1))
    resolved = parent
  }
  const realBase = realpathSync(resolved)
  return tail.length === 0 ? realBase : resolve(realBase, ...tail)
}

/**
 * Decide whether one tool execution must be denied by the directory grants.
 * @returns a human-readable deny reason, or `null` to allow/delegate.
 *   - Tools without a known path argument delegate (`null`).
 *   - A write to a non-`rw` target is denied.
 *   - A read of a target outside every grant is denied.
 *   - A missing/malformed path argument on a path tool is denied (fail closed).
 */
export function decideDeny(exec: GuardExecution, grants: readonly Grant[], cwd: string): string | null {
  const target = targetOf(exec)
  if (target === undefined) return null
  if (target === null) return `${exec.name}: missing or invalid path argument`

  const absolute = canonicalize(target.path, cwd)
  const mode = classify(grants, absolute)

  if (target.isWrite && mode !== 'rw') {
    return `Write to ${absolute} is not permitted: outside your read-write directories.`
  }
  if (!target.isWrite && mode === 'none') {
    return `Access to ${absolute} is not permitted: outside your allowed directories.`
  }
  return null
}
