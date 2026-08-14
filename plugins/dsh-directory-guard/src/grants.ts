import { readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'

export type GrantMode = 'ro' | 'rw'

export interface Grant {
  path: string
  mode: GrantMode
}

/**
 * Load the per-instance directory grants written by the gateway. Each entry's
 * path is realpath-normalized (so symlinked grant roots compare canonically);
 * entries whose directory no longer exists are dropped. Extra fields such as
 * `label` are ignored. Results are sorted by path length descending so
 * {@link classify} can take the first (most specific) containing match. A
 * missing or unreadable file yields no grants.
 */
export function loadGrants(file: string): Grant[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const grants: Grant[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { path?: unknown; mode?: unknown }
    if (typeof record.path !== 'string' || (record.mode !== 'ro' && record.mode !== 'rw')) continue
    try {
      grants.push({ path: realpathSync(record.path), mode: record.mode })
    } catch {
      // Granted directory no longer exists on disk; skip it.
    }
  }
  return grants.sort((a, b) => b.path.length - a.path.length)
}

/** True when `target` is `root` itself or a descendant of it (segment-aware). */
function contains(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/**
 * Classify an absolute `target` path against the grants: the mode of the most
 * specific containing grant, or `none` when no grant contains it. Grants must be
 * pre-sorted longest-first (as {@link loadGrants} returns them).
 */
export function classify(grants: readonly Grant[], target: string): GrantMode | 'none' {
  for (const grant of grants) {
    if (contains(grant.path, target)) return grant.mode
  }
  return 'none'
}
