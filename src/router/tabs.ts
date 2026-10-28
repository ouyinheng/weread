/**
 * Tab registry, shared by the router and the tab bar so the two can never
 * disagree about order, labels, or which routes are "lateral" moves.
 */
export type TabName = 'shelf' | 'tv' | 'me'

export interface TabDef {
  name: TabName
  path: string
  label: string
}

/** Order matters: it defines the slide direction when switching. */
/**
 * WeRead's bar is: 阅读 / 书架 / 有声书 / 我. This build has no online catalogue,
 * so 阅读 and 有声书 would be empty shells; the honest mapping keeps 书架 / 我.
 * 搜索是书架顶部的入口，不再单独占一个 tab。
 */
export const TABS: TabDef[] = [
  { name: 'shelf', path: '/shelf', label: '书架' },
  { name: 'tv', path: '/tv', label: '影视' },
  { name: 'me', path: '/me', label: '我' },
]

/* 故意放宽成 Set<string>：调用方传进来的是路由名（string），不是 TabName。 */
export const TAB_NAMES = new Set<string>(TABS.map(t => t.name))

/**
 * Tabs actually shown in the bottom bar.
 *
 * 影视 is opt-in: most readers only read, and a permanent third slot for a
 * module they never opened is noise. Turning it on in 系统设置 adds the tab;
 * turning it off only hides the entrance — sources and watch history stay.
 */
export function visibleTabs(showTvTab: boolean): TabDef[] {
  return TABS.filter(tab => tab.name !== 'tv' || showTvTab)
}

export function isTabRoute(name: unknown): boolean {
  return typeof name === 'string' && TAB_NAMES.has(name)
}

export function tabIndex(name: unknown): number {
  if (typeof name !== 'string') return -1
  return TABS.findIndex(t => t.name === name)
}
