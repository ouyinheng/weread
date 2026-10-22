/**
 * Tab registry, shared by the router and the tab bar so the two can never
 * disagree about order, labels, or which routes are "lateral" moves.
 */
export interface TabDef {
  name: string
  path: string
  label: string
}

/** Order matters: it defines the slide direction when switching. */
/**
 * WeRead's bar is: 阅读 / 书架 / 有声书 / 我. This build has no online catalogue,
 * so 阅读 and 有声书 would be empty shells; the honest mapping keeps 书架 / 发现 / 我
 * and does not ship dead entries that look like tabs but go nowhere.
 */
export const TABS: TabDef[] = [
  { name: 'discover', path: '/discover', label: '发现' },
  { name: 'shelf', path: '/shelf', label: '书架' },
  { name: 'me', path: '/me', label: '我' },
]

export const TAB_NAMES = new Set(TABS.map(t => t.name))

export function isTabRoute(name: unknown): boolean {
  return typeof name === 'string' && TAB_NAMES.has(name)
}

export function tabIndex(name: unknown): number {
  if (typeof name !== 'string') return -1
  return TABS.findIndex(t => t.name === name)
}
