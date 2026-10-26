/**
 * 影视模块的页面级缓存。
 *
 * 首页列表和搜索结果都是「马上还要看」的数据：从详情页返回、在 tab 之间
 * 来回切，都不该重新打一遍接口（移动网络上一次聚合搜索就是十几秒）。
 * 这里放两个进程内缓存，页面重建直接复用，过期才重新拉。
 */
import type { TvSearchOutcome } from './cms'
import type { TvItem } from './types'

const LATEST_TTL = 10 * 60 * 1000
const SEARCH_TTL = 10 * 60 * 1000

interface Entry<T> {
  at: number
  data: T
}

const latestEntry: { current: Entry<TvItem[]> | null } = { current: null }
const searchEntries = new Map<string, Entry<TvSearchOutcome[]>>()

/**
 * 首页列表：过期也返回，页面可以先把旧数据画出来再静默换新；
 * `fresh` 为真表示不用再拉。
 */
export function peekLatest(): { items: TvItem[]; fresh: boolean } | null {
  const entry = latestEntry.current
  if (!entry) return null
  return { items: entry.data, fresh: Date.now() - entry.at < LATEST_TTL }
}

export function saveLatest(items: TvItem[]): void {
  latestEntry.current = { at: Date.now(), data: items }
}

/** 搜索结果只认新鲜的：过期就该重新搜。 */
export function peekSearch(keyword: string): TvSearchOutcome[] | null {
  const entry = searchEntries.get(keyword)
  if (!entry || Date.now() - entry.at > SEARCH_TTL) return null
  return entry.data
}

export function saveSearch(keyword: string, outcomes: TvSearchOutcome[]): void {
  // 关键词是用户输入，条目数封顶避免长期使用后无界增长。
  if (searchEntries.size > 40) searchEntries.delete(searchEntries.keys().next().value as string)
  searchEntries.set(keyword, { at: Date.now(), data: outcomes })
}
