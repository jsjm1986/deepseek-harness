/** User-document identifier brand. @module @deepseek-ai/dsh-userdoc/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identifier for one document a user uploaded.
 *
 * Structurally the POSIX-style path of the document relative to the upload
 * root (`2026-08-14/report.pdf`), which makes the filesystem itself the index
 * and keeps no sidecar database to fall out of step with the files on disk.
 * Consumers MUST treat it as opaque: it is not a usable filesystem path, and
 * every implementation re-derives and re-validates the absolute path from it,
 * so an id that escapes the upload root is refused rather than resolved.
 */
export type UserDocId = Branded<'UserDocId'>

/**
 * Brand a backend-produced document identifier.
 * @param value - relative POSIX-style identifier produced by the store.
 * @returns the branded identifier.
 */
export function UserDocId(value: string): UserDocId {
  return value as UserDocId
}
