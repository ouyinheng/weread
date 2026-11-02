/**
 * 苹果 CMS V10（provide/vod）客户端。
 *
 * 影视模块不依赖 LibreTV 的后端：搜索、详情、测活全部直接打源站接口。
 * 网络层复用书源那一套 `httpGet`——原生壳走 CapacitorHttp 绕开 CORS，
 * 浏览器开发态才回退 fetch，所以这里不需要任何代理服务。
 *
 * 接口契约（苹果 CMS V10）：
 *   列表/搜索  ?ac=videolist&wd=<关键词>&pg=1
 *   详情       ?ac=videolist&ids=<vod_id>
 *   返回       { code: 1, list: [ { vod_id, vod_name, vod_play_url, ... } ] }
 */
import { httpGet } from '@/utils/source/net'
import { parsePlayGroups } from './parse'
import type { TvDetail, TvItem, TvSource } from './types'

interface RawVod {
  vod_id?: number | string
  vod_name?: string
  vod_pic?: string
  vod_year?: string
  vod_area?: string
  vod_remarks?: string
  type_name?: string
  vod_content?: string
  vod_play_url?: string
  vod_play_from?: string
}

interface RawList {
  code?: number
  msg?: string
  list?: RawVod[]
  total?: number
  /** 苹果 CMS 的分类表，`ac=list` 时才有。 */
  class?: RawClass[]
}

interface RawClass {
  type_id?: number | string
  type_name?: string
  type_pid?: number | string
}

const TIMEOUT = 12000

/**
 * 采集站普遍会挡默认 UA / 要求 JSON Accept：不带这两样，一部分源直接回 403，
 * 或者返回首页 HTML 让我们误判成「不是苹果 CMS 源」。（同 LibreTV 的做法。）
 */
const CMS_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

function apiBase(source: TvSource): string {
  const api = source.api.trim()
  return api.endsWith('/') ? api : `${api}/`
}

function stripTags(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function request(source: TvSource, params: Record<string, string>): Promise<RawVod[]> {
  const url = `${apiBase(source)}?${new URLSearchParams(params).toString()}`
  const res = await httpGet(url, { timeout: TIMEOUT, headers: CMS_HEADERS })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`)

  let data: RawList
  try {
    data = JSON.parse(res.text) as RawList
  } catch {
    throw new Error('接口返回的不是 JSON，可能不是苹果 CMS 源')
  }
  if (!Array.isArray(data.list)) throw new Error(data.msg || '接口没有返回影片列表')
  return data.list
}

function toItem(raw: RawVod, source: TvSource): TvItem | null {
  const id = String(raw.vod_id ?? '').trim()
  const name = String(raw.vod_name ?? '').trim()
  if (!id || !name) return null
  return {
    id,
    name,
    pic: raw.vod_pic || undefined,
    year: raw.vod_year || undefined,
    area: raw.vod_area || undefined,
    remarks: raw.vod_remarks || undefined,
    typeName: raw.type_name || undefined,
    sourceId: source.id,
    sourceName: source.name,
  }
}

/* ---------- 搜索 ---------- */

export interface TvSearchOutcome {
  sourceId: string
  sourceName: string
  items: TvItem[]
  error?: string
}

/** 单源搜索。第一页足够：用户要的是「有没有」，翻页交给详情页。 */
export async function searchSource(source: TvSource, keyword: string): Promise<TvSearchOutcome> {
  try {
    const list = await request(source, { ac: 'videolist', wd: keyword.trim(), pg: '1' })
    const items = refineSearch(
      list.map(raw => toItem(raw, source)).filter((v): v is TvItem => !!v),
      keyword,
    )
    return { sourceId: source.id, sourceName: source.name, items }
  } catch (e) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      items: [],
      error: (e as Error)?.message || '请求失败',
    }
  }
}

/** 并发受限的聚合搜索：每完成一个源就回调一次，UI 可以逐源回填。 */
export async function searchSources(
  sources: TvSource[],
  keyword: string,
  onSource: (outcome: TvSearchOutcome) => void,
  concurrency = 4,
): Promise<void> {
  let cursor = 0
  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor++]
      const outcome = await searchSource(source, keyword)
      onSource(outcome)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker))
}

/* ---------- 搜索质量 ---------- */

/**
 * 归一化标题/关键词：去掉空白、标点、符号再转小写。
 * 用来跨标点匹配（源站写「摔跤吧!爸爸」，用户搜「摔跤吧！爸爸」）。
 */
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 敏感分类关键词（照 LibreTV 那一份）。
 *
 * 采集站的 `wd=` 经常把整个目录都吐回来，里面有大量这类频道；它们和搜索意图
 * 无关，留在结果里只会把真正想看的片子挤下去。
 */
const ADULT_KEYWORDS = [
  '伦理片', '倫理片', '福利', '福利片', '日本伦理', '日本福利', '擦边', '韩国伦理',
  '里番动漫', '门事件', '制服诱惑', '国产传媒', '黑丝诱惑', '无码', '有码',
  '网红主播', '色情片', '自拍偷拍', '福利视频',
]

function isAdult(typeName?: string): boolean {
  if (!typeName) return false
  return ADULT_KEYWORDS.some(k => typeName.includes(k))
}

/**
 * 搜索结果收口：只留标题里真的含关键词的条目，并剔掉敏感频道。
 *
 * 不做这一步的话，搜「庆余年」会拿到源站整个「国产剧」目录——用户看到的
 * 不是搜索结果，是别人的片库。
 */
function refineSearch(items: TvItem[], keyword: string): TvItem[] {
  const q = normalizeTitle(keyword)
  return items.filter(it => {
    if (isAdult(it.typeName)) return false
    if (!q) return true
    return normalizeTitle(it.name).includes(q)
  })
}

/* ---------- 分类 ---------- */

/** 源站的分类：`type_id` 是接口参数，`type_name` 是给人看的。 */
export interface TvCategory {
  id: string
  name: string
}

/**
 * 拉源站的分类表（TVBox 里那一长条就是这么来的）。
 *
 * 苹果 CMS 的 `?ac=list` 会带回完整的 `class` 数组；有的源只认 `ac=videolist`，
 * 那种情况从它的响应里顺手捞一次。只取一级分类（`type_pid` 为空或 0）——
 * 二级分类在片单里也只是同一个 `t` 参数，铺出来只会更长。
 */
export async function listCategories(source: TvSource): Promise<TvCategory[]> {
  const url = `${apiBase(source)}?ac=list`
  const res = await httpGet(url, { timeout: TIMEOUT, headers: CMS_HEADERS })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`)

  let data: RawList
  try {
    data = JSON.parse(res.text) as RawList
  } catch {
    throw new Error('分类接口返回的不是 JSON')
  }
  const raw = data.class
  if (!Array.isArray(raw)) return []
  return raw
    .filter(c => {
      const pid = Number(c.type_pid ?? 0)
      return !pid && String(c.type_id ?? '').trim() && String(c.type_name ?? '').trim()
    })
    .map(c => ({ id: String(c.type_id).trim(), name: String(c.type_name).trim() }))
}

/* ---------- 最近更新 ---------- */

/**
 * 首页「最近更新」：取源站第一页，按入库时间倒序，通常就是最新上架的片子。
 *
 * `typeId` 非空时只取该分类（`t=` 参数），分类 id 是**源站自己的**，不能跨源用。
 */
export async function latestFrom(
  source: TvSource,
  limit = 0,
  typeId?: string,
  page = 1,
): Promise<TvItem[]> {
  const params: Record<string, string> = { ac: 'videolist', pg: String(page) }
  if (typeId) params.t = typeId
  const items = (await request(source, params))
    .map(raw => toItem(raw, source))
    .filter((v): v is TvItem => !!v)
  // limit = 0 表示「整页都要」，翻页时不能截断，否则永远停在同一页。
  return limit > 0 ? items.slice(0, limit) : items
}

/* ---------- 详情 ---------- */

const detailCache = new Map<string, { at: number; data: TvDetail }>()
const DETAIL_TTL = 10 * 60 * 1000

export function peekDetail(sourceId: string, vodId: string): TvDetail | undefined {
  const hit = detailCache.get(`${sourceId}:${vodId}`)
  if (!hit || Date.now() - hit.at > DETAIL_TTL) return undefined
  return hit.data
}

export async function fetchDetail(source: TvSource, vodId: string): Promise<TvDetail> {
  const cached = peekDetail(source.id, vodId)
  if (cached) return cached

  const list = await request(source, { ac: 'videolist', ids: vodId })
  const raw = list[0]
  if (!raw) throw new Error('影片不存在或已下架')

  const data: TvDetail = {
    id: String(raw.vod_id ?? vodId),
    name: String(raw.vod_name ?? ''),
    pic: raw.vod_pic || undefined,
    desc: stripTags(raw.vod_content) || undefined,
    year: raw.vod_year || undefined,
    area: raw.vod_area || undefined,
    typeName: raw.type_name || undefined,
    remarks: raw.vod_remarks || undefined,
    groups: parsePlayGroups(raw.vod_play_url, raw.vod_play_from),
    source,
  }
  detailCache.set(`${source.id}:${vodId}`, { at: Date.now(), data })
  return data
}

/* ---------- 测活 ---------- */

export async function testSource(source: TvSource): Promise<{ ok: boolean; message: string }> {
  try {
    const list = await request(source, { ac: 'videolist', pg: '1' })
    return { ok: true, message: `可用，首屏 ${list.length} 条` }
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || '不可用' }
  }
}
