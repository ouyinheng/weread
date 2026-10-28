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

/** Which tabs the user still wants in the bottom bar (系统设置 → 功能入口). */
export interface TabVisibility {
  showShelfTab: boolean
  showTvTab: boolean
}

/**
 * Tabs actually shown in the bottom bar.
 *
 * 书架 is on by default and 影视 is opt-in, but both are hideable: a reader who
 * lives in the video module should not be stuck with a shelf tab, and vice
 * versa. Hiding only removes the entrance — books, sources and watch history
 * all stay, and the switch brings the tab (and the page) right back.
 */
export function visibleTabs({ showShelfTab, showTvTab }: TabVisibility): TabDef[] {
  return TABS.filter(tab => {
    if (tab.name === 'shelf') return showShelfTab
    if (tab.name === 'tv') return showTvTab
    return true
  })
}

/**
 * Where to land when the current tab got hidden. 我 is never hideable, so this
 * always resolves; falling back to `me` also keeps the router out of a redirect
 * loop if the tab list ever ends up empty.
 */
export function homeTab(visibility: TabVisibility): TabName {
  return visibleTabs(visibility)[0]?.name ?? 'me'
}

export function isTabRoute(name: unknown): boolean {
  return typeof name === 'string' && TAB_NAMES.has(name)
}

export function tabIndex(name: unknown): number {
  if (typeof name !== 'string') return -1
  return TABS.findIndex(t => t.name === name)
}
