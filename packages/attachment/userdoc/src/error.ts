/** User-document failure class. @module @deepseek-ai/dsh-userdoc/error */

/**
 * Stable failures suitable for host RPC error mapping.
 *
 * Re-implements the `HarnessError` shape rather than extending it, for the
 * same reason `AttachmentError` does: the base lives in `@deepseek-ai/dsh-llm`,
 * which depends on the attachment vocabulary this package sits beside, so
 * sharing the base would risk a dependency cycle as soon as a content block
 * references a document. Consumers route on `code`, never on the prototype
 * chain, so the shapes stay interchangeable at the wire boundary.
 */
export class UserDocError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: string

  /**
   * @param message - human-readable description carrying neither document bytes nor absolute host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserDocError'
    this.code = code
  }
}

/** One uploaded name could not be reduced to a safe leaf below the upload root. */
export const INVALID_DOCUMENT_NAME_CODE = 'INVALID_DOCUMENT_NAME'

/** An identifier did not resolve to a path inside the upload root. */
export const INVALID_DOCUMENT_REF_CODE = 'INVALID_DOCUMENT_REF'

/** One document exceeded the configured per-file byte limit. */
export const DOCUMENT_TOO_LARGE_CODE = 'DOCUMENT_TOO_LARGE'

/** The referenced document is absent from storage. */
export const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND'

/** Storage refused a write, or a partial write could not be completed. */
export const DOCUMENT_WRITE_FAILED_CODE = 'DOCUMENT_WRITE_FAILED'

/** Storage refused a read. */
export const DOCUMENT_READ_FAILED_CODE = 'DOCUMENT_READ_FAILED'
