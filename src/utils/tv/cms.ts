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
}

const TIMEOUT = 12000

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
  const res = await httpGet(url, { timeout: TIMEOUT })
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
    const items = list.map(raw => toItem(raw, source)).filter((v): v is TvItem => !!v)
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

/* ---------- 最近更新 ---------- */

/** 首页「最近更新」：取源站第一页，按入库时间倒序，通常就是最新上架的片子。 */
export async function latestFrom(source: TvSource, limit = 12): Promise<TvItem[]> {
  const list = await request(source, { ac: 'videolist', pg: '1' })
  return list
    .map(raw => toItem(raw, source))
    .filter((v): v is TvItem => !!v)
    .slice(0, limit)
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
