/** `layout` namespace dictionaries: shell chrome copy (compact-mode drawer toggle and overlay dismissal). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'drawer.open': '打开侧边栏',
  'drawer.close': '关闭侧边栏',
  'details.dismiss': '关闭详情',
} satisfies Record<string, string>

/** The layout namespace key union. */
export type LayoutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'drawer.open': 'Open sidebar',
  'drawer.close': 'Close sidebar',
  'details.dismiss': 'Close details',
} satisfies Record<LayoutKey, string>
