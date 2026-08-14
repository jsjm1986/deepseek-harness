/** Extension-derived media types, for presentation only. */

/**
 * Extension-to-media-type map. It is deliberately partial: nothing in this
 * package admits, parses, or dispatches on a media type, so an unlisted
 * extension is not a lesser document — it is stored identically and simply
 * reaches the viewer as a generic download rather than a labelled preview.
 *
 * The listed entries are the ones a viewer can act on: the text family it can
 * show inline, the image family it can render, PDF which browsers display
 * natively, and the Office family which it can only label and offer for
 * download.
 */
const MEDIA_TYPES = new Map<string, string>([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.doc', 'application/msword'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
])

/** Media type recorded when the extension is unknown. */
export const DEFAULT_MEDIA_TYPE = 'application/octet-stream'

/**
 * Derive one document's media type from its name.
 *
 * Derived rather than taken from the upload request so that a stored file and a
 * listed file always report the same type: the store keeps no sidecar metadata,
 * so a client-declared value would survive only until the next listing.
 * @param name - stored leaf name.
 * @returns the media type, or `application/octet-stream` when unknown.
 */
export function mediaTypeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return DEFAULT_MEDIA_TYPE
  return MEDIA_TYPES.get(name.slice(dot).toLowerCase()) ?? DEFAULT_MEDIA_TYPE
}
