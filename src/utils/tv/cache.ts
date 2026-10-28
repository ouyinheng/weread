/**
 * 影视模块的页面级缓存。
 *
 * 首页列表和搜索结果都是「马上还要看」的数据：从详情页返回、在 tab 之间
 * 来回切，都不该重新打一遍接口（移动网络上一次聚合搜索就是十几秒）。
 * 这里放两个进程内缓存，页面重建直接复用，过期才重新拉。
 */
import type { TvSearchOutcome } from './cms'
import type { TvItem } from './types'

/**
 * 首页列表缓存 24 小时。
 *
 * 影视首页的数据来自第三方接口，聚合一轮要打三四个站；一天之内不换新
 * 完全够用，用户想立刻看新的就下拉刷新。搜索仍旧只认 10 分钟——搜的是
 * 「某部片子有没有」，过期的结果没有意义。
 */
const LATEST_TTL = 24 * 60 * 60 * 1000
const SEARCH_TTL = 10 * 60 * 1000

/** 首页列表要跨启动保留，内存缓存 + localStorage 双写。 */
const LATEST_KEY = 'weread.tv.latest.v1'
/** 超过这个体积就不进 localStorage：宁可不缓存，也别把存储写爆或拖慢启动。 */
const LATEST_MAX_BYTES = 512 * 1024

interface Entry<T> {
  at: number
  data: T
}

const latestEntry: { current: Entry<TvItem[]> | null } = { current: null }
const searchEntries = new Map<string, Entry<TvSearchOutcome[]>>()

/**
 * 首页列表：过期也返回，页面可以先把旧数据画出来再静默换新；
 * `fresh` 为真表示 24 小时内拉过，不用再打接口。
 */
export function peekLatest(): { items: TvItem[]; at: number; fresh: boolean } | null {
  if (!latestEntry.current) {
    const saved = readPersisted()
    if (saved) latestEntry.current = saved
  }
  const entry = latestEntry.current
  if (!entry) return null
  return { items: entry.data, at: entry.at, fresh: Date.now() - entry.at < LATEST_TTL }
}

export function saveLatest(items: TvItem[]): void {
  const entry = { at: Date.now(), data: items }
  latestEntry.current = entry
  writePersisted(entry)
}

function readPersisted(): Entry<TvItem[]> | null {
  try {
    const raw = localStorage.getItem(LATEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Entry<TvItem[]>
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.at !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writePersisted(entry: Entry<TvItem[]>): void {
  try {
    const raw = JSON.stringify(entry)
    if (raw.length > LATEST_MAX_BYTES) {
      // 太大就不落盘，内存里照样有，本次运行不受影响。
      localStorage.removeItem(LATEST_KEY)
      return
    }
    localStorage.setItem(LATEST_KEY, raw)
  } catch {
    /* 配额满或隐私模式：缓存是优化，失败不该影响页面 */
  }
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
