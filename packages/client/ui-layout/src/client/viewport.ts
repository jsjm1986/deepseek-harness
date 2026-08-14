/**
 * Viewport size classes: the shared width vocabulary between the frame's
 * layout decisions and feature CSS. AppFrame stamps the active class on the
 * frame root as `data-viewport`, so component CSS inside the frame selects on
 * `[data-viewport='compact'] &` without measuring anything itself. Floating
 * surfaces rendered outside the frame (portals) match the same thresholds
 * with media queries against these constants instead. Documented in
 * docs/web-styling.md#responsive-layout.
 */

/** Frame width classes, ordered narrow to wide. */
export type ViewportClass = 'compact' | 'medium' | 'expanded' | 'wide'

/** compact/medium boundary: phone-class layouts end below this width. */
export const VIEWPORT_MEDIUM_MIN = 768
/** medium/expanded boundary: the three-column desktop layout starts here (deepsuite LG). */
export const VIEWPORT_EXPANDED_MIN = 1024
/** expanded/wide boundary: wide-desktop layouts start here. */
export const VIEWPORT_WIDE_MIN = 1440

/**
 * Classify a frame width into its viewport class.
 * @param width - frame width in px.
 * @returns the class whose range contains the width.
 */
export function viewportClassOf(width: number): ViewportClass {
  if (width < VIEWPORT_MEDIUM_MIN) return 'compact'
  if (width < VIEWPORT_EXPANDED_MIN) return 'medium'
  if (width < VIEWPORT_WIDE_MIN) return 'expanded'
  return 'wide'
}
