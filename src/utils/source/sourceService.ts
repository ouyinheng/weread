/**
 * 书源业务层：导入、启停、多源搜索、加入书架、按需抓正文、体检、换源。
 *
 * 在线书完全复用本地书的结构：`books` 一条 + `chapters` N 条。区别只有两点：
 *  - `book.sourceId` 标记来源；`chapter.remoteUrl` 记住正文该去哪儿抓；
 *  - 章节正文首次打开时抓取并回写，之后就是纯本地路径。
 */
import type { Book } from '@/types'
import type { BookSource, SearchHit } from '@/types/source'
import { SourceError } from '@/types/source'
import {
  dbDelete,
  dbDeleteByIndex,
  dbGet,
  dbGetAll,
  dbPut,
  dbPutMany,
} from '@/utils/db'
import { useBookStore } from '@/stores'
import { absUrl, extract, query } from './selector'
import {
  loadBook,
  loadChapter,
  makeCtx,
  search,
  textToHtml,
  type SourceCtx,
} from './pipeline'
import { httpGet, httpGetBinary, shrinkToDataUrl, withTimeout } from './net'

interface SourceSettings {
  key: string
  enabled?: boolean
}

interface StoredChapterRow {
  bookId: string
  index: number
  title: string
  html: string
  text: string
  charOffset: number
  wordCount: number
  remoteUrl?: string
}

const SETTINGS_KEY = 'source'

/* ---------- 总开关 ---------- */

export async function loadNetworkEnabled(): Promise<boolean> {
  const rec = await dbGet<SourceSettings>('settings', SETTINGS_KEY)
  return rec?.enabled === true
}

export async function saveNetworkEnabled(enabled: boolean): Promise<void> {
  await dbPut('settings', { key: SETTINGS_KEY, enabled })
}

/* ---------- 书源读写 ---------- */

function baseUrlOf(rawUrl: string): string {
  return rawUrl.split('#')[0].trim().replace(/\/+$/, '')
}

function normalizeOne(obj: any): BookSource | null {
  if (!obj || typeof obj !== 'object') return null
  const rawUrl = String(obj.bookSourceUrl || '').trim()
  if (!rawUrl) return null
  const url = baseUrlOf(rawUrl)
  if (!url || !/^https?:/i.test(url)) return null
  const type = Number(obj.bookSourceType ?? 0)
  // 只处理文本书源；音频 / 图片 / 文件类没有播放器，也没有对应阅读路径。
  if (type !== 0) return null
  return {
    id: url,
    name: String(obj.bookSourceName || url).trim(),
    url,
    group: String(obj.bookSourceGroup || '').trim(),
    type,
    enabled: obj.enabled !== false,
    raw: { ...obj, bookSourceUrl: rawUrl },
    health: 0,
    lastCheckAt: 0,
    lastError: '',
    createdAt: Date.now(),
  }
}

/** 合集 JSON 可能是裸数组，也可能包一层 sources / data / list。 */
function payloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    for (const key of ['sources', 'bookSources', 'data', 'list', 'items']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    return [payload]
  }
  return []
}

function normalizePayload(payload: unknown): BookSource[] {
  const out: BookSource[] = []
  for (const item of payloadItems(payload)) {
    const s = normalizeOne(item)
    if (s) out.push(s)
  }
  return out
}

export async function listSources(): Promise<BookSource[]> {
  const all = await dbGetAll<BookSource>('sources')
  return all.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function getSource(id: string): Promise<BookSource | undefined> {
  return dbGet<BookSource>('sources', id)
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  const s = await getSource(id)
  if (!s) throw new SourceError('SRC_NOT_FOUND')
  await dbPut('sources', { ...s, enabled })
}

export async function deleteSource(id: string): Promise<void> {
  const s = await getSource(id)
  if (!s) return
  await dbDelete('sources', id)
}

export interface ImportResult {
  /** JSON 里的条目总数。 */
  total: number
  /** 去重后真正落库的文本书源数。 */
  imported: number
  /** 音频 / 图片 / 文件类或字段不全，被跳过的条目数。 */
  skipped: number
}

function base64Text(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

type ImportSource =
  | { kind: 'text'; value: string }
  | { kind: 'url'; value: string }

/**
 * 识别四种常见写法：粘贴的 JSON、JSON 直链、`legado://import/bookSource?src=`
 * 分享链接、以及 `data:application/json;base64,` 内嵌数据。
 */
function parseImportSource(text: string): ImportSource {
  const t = text.trim()

  if (/^[a-z][a-z0-9+.-]*:\/\/import\/bookSource/i.test(t)) {
    const m = /[?&]src=([^&#]+)/i.exec(t)
    if (m) {
      try {
        return parseImportSource(decodeURIComponent(m[1]))
      } catch {
        return { kind: 'text', value: m[1] }
      }
    }
  }

  const data = /^data:application\/json[^,]*;base64,/i.exec(t)
  if (data) return { kind: 'text', value: base64Text(t.slice(data[0].length)) }

  if (/^https?:\/\//i.test(t) && !/^[\[{]/.test(t)) return { kind: 'url', value: t }
  return { kind: 'text', value: t }
}

/**
 * 导入书源。链接导入是用户主动发起的一次联网请求，不受「网络书源」总开关
 * 限制（总开关约束的是搜索、阅读、体检这些后台请求）。
 *
 * 大合集（全量池约 3900 条 / 20MB）会分批落库，避免一次事务卡死页面。
 */
export async function importSourcesFromText(text: string): Promise<ImportResult> {
  const src = parseImportSource(text)
  let jsonText = src.value
  if (!jsonText.trim()) throw new SourceError('RULE_EMPTY', '没有可导入的内容')

  if (src.kind === 'url') {
    const r = await httpGet(src.value, {
      timeout: 60000,
      headers: { Accept: 'application/json,text/plain,*/*' },
    })
    if (r.status !== 200) throw new SourceError('NET_HTTP', `书源地址返回 HTTP ${r.status}`)
    jsonText = r.text
  }

  jsonText = jsonText.replace(/^\uFEFF/, '').trim()
  if (!jsonText) throw new SourceError('RULE_EMPTY', '书源内容为空')
  if (/^</.test(jsonText)) {
    throw new SourceError('RULE_EMPTY', '该地址返回的是网页，不是书源 JSON')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new SourceError('RULE_EMPTY', '书源 JSON 解析失败')
  }

  const items = payloadItems(parsed)
  if (!items.length) throw new SourceError('RULE_EMPTY', '文件里没有书源')

  const rows = normalizePayload(parsed)
  if (!rows.length) throw new SourceError('RULE_EMPTY', '没有可导入的文本书源')

  // 同一份合集里可能有重复 bookSourceUrl，先去重再落库。
  const byId = new Map<string, BookSource>()
  for (const row of rows) byId.set(row.id, row)

  const existing = new Map((await dbGetAll<BookSource>('sources')).map(s => [s.id, s]))
  const merged = Array.from(byId.values()).map(s => {
    const old = existing.get(s.id)
    // 重新导入同一地址时保留体检结果，只更新规则。
    return old
      ? { ...s, health: old.health, lastCheckAt: old.lastCheckAt, lastError: old.lastError }
      : s
  })

  for (let i = 0; i < merged.length; i += 200) {
    await dbPutMany('sources', merged.slice(i, i + 200))
  }

  return {
    total: items.length,
    imported: merged.length,
    skipped: Math.max(0, items.length - merged.length),
  }
}

/** 直接编辑原始 JSON。地址变了就换主键，避免旧记录残留。 */
export async function updateSourceRaw(id: string, jsonText: string): Promise<BookSource> {
  let obj: any
  try {
    obj = JSON.parse(jsonText)
  } catch {
    throw new SourceError('RULE_EMPTY', 'JSON 格式错误')
  }
  const next = normalizeOne(obj)
  if (!next) throw new SourceError('RULE_EMPTY', '缺少 bookSourceUrl，或不是文本书源')

  const prev = await getSource(id)
  if (!prev) throw new SourceError('SRC_NOT_FOUND')
  next.health = prev.health
  next.lastCheckAt = prev.lastCheckAt
  next.lastError = prev.lastError
  next.createdAt = prev.createdAt

  if (next.id !== id) await dbDelete('sources', id)
  await dbPut('sources', next)
  return next
}

export async function markHealth(id: string, health: number, lastError = ''): Promise<void> {
  const s = await getSource(id)
  if (!s) return
  await dbPut('sources', { ...s, health, lastError, lastCheckAt: Date.now() })
}

/* ---------- 多源搜索 ---------- */

export interface SearchFailure {
  sourceId: string
  sourceName: string
  message: string
}

export interface SearchOutcome {
  hits: SearchHit[]
  failures: SearchFailure[]
  /** 本次真正发过请求的书源数。 */
  searched: number
  /** 启用中的可搜索书源总数。 */
  total: number
}

/**
 * 一次搜索最多覆盖的书源数。
 *
 * 全量合集动辄三四千条，全部并发既会被源站封 IP，也会让用户等上几分钟。
 * 按「可用 → 未检测 → 降级」排序后取前 N 个，并在 UI 上说明范围。
 */
export const SEARCH_SOURCE_LIMIT = 20

function canSearch(s: BookSource): boolean {
  return s.type === 0 && !!s.raw?.searchUrl && !!s.raw?.ruleSearch?.bookList
}

function rankSources(list: BookSource[]): BookSource[] {
  const score = (s: BookSource): number => {
    if (s.health === 1) return 0
    if (s.health === 0) return 1
    return 2
  }
  return [...list].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, 'zh-CN'))
}

export async function searchAll(key: string): Promise<SearchOutcome> {
  const word = key.trim()
  if (!word) return { hits: [], failures: [], searched: 0, total: 0 }
  if (!(await loadNetworkEnabled())) return { hits: [], failures: [], searched: 0, total: 0 }

  const usable = (await listSources()).filter(s => s.enabled && canSearch(s))
  // 标红的源不再浪费一次等待；全部标红时才回退到全部。
  const alive = usable.filter(s => s.health !== 3)
  const picked = rankSources(alive.length ? alive : usable).slice(0, SEARCH_SOURCE_LIMIT)
  const results = await Promise.all(picked.map(async (s): Promise<{ s: BookSource; hits: SearchHit[]; error?: string }> => {
    try {
      const hits = await withTimeout(search(makeCtx(s), word), 12000)
      return { s, hits }
    } catch (e) {
      return { s, hits: [], error: (e as Error)?.message || '搜索失败' }
    }
  }))

  const hits: SearchHit[] = []
  const failures: SearchFailure[] = []
  for (const r of results) {
    if (r.error) {
      failures.push({ sourceId: r.s.id, sourceName: r.s.name, message: r.error })
      markHealth(r.s.id, 3, r.error).catch(() => undefined)
    } else if (!r.hits.length) {
      // 任意关键词都可能没有结果，这不算规则失效；体检时才判定健康度。
      failures.push({ sourceId: r.s.id, sourceName: r.s.name, message: '没有搜到结果' })
    } else {
      hits.push(...r.hits)
      if (r.s.health !== 1) markHealth(r.s.id, 1, '').catch(() => undefined)
    }
  }
  return { hits, failures, searched: picked.length, total: usable.length }
}

/* ---------- 加入书架 ---------- */

async function fetchCoverAsDataUrl(url: string | null, referer?: string): Promise<string | null> {
  if (!url) return null
  try {
    const bin = await httpGetBinary(url, 8000, referer ? { Referer: referer } : {})
    return (await shrinkToDataUrl(bin.bytes, bin.contentType, 480)) || null
  } catch {
    return null
  }
}

export async function addToShelf(hit: SearchHit): Promise<string> {
  if (!(await loadNetworkEnabled())) throw new SourceError('SRC_DISABLED')
  const src = await getSource(hit.sourceId)
  if (!src) throw new SourceError('SRC_NOT_FOUND')
  if (!src.enabled) throw new SourceError('SRC_DISABLED', '该书源已停用')

  const store = useBookStore()
  const dup = store.books.find(b => b.sourceId === hit.sourceId && b.remoteBookUrl === hit.bookUrl)
  if (dup) return dup.id

  const ctx = makeCtx(src)
  const { info, chapters } = await loadBook(ctx, hit.bookUrl)
  if (!chapters.length) throw new SourceError('TOC_EMPTY')

  const id = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cover = await fetchCoverAsDataUrl(info.coverUrl || hit.coverUrl, hit.bookUrl)

  const book: Book = {
    id,
    title: info.title || hit.title,
    author: info.author || hit.author,
    format: 'txt', // 复用 txt 阅读路径
    cover,
    wordCount: 0,
    fileSize: 0,
    importedAt: Date.now(),
    lastReadAt: Date.now(),
    progress: 0,
    lastChapterIndex: 0,
    lastCharOffset: 0,
    finished: false,
    sourceId: src.id,
    remoteBookUrl: hit.bookUrl,
    remoteTocUrl: info.tocUrl,
    cachedChapterCount: 0,
  }

  // 只落目录：text 留空，remoteUrl 用来后续按需抓。
  await dbPutMany('chapters', chapters.map(c => ({
    bookId: id,
    index: c.index,
    title: c.title,
    html: '',
    text: '',
    charOffset: 0,
    wordCount: 0,
    remoteUrl: c.url,
  })))

  await store.addBook(book)
  markHealth(src.id, 1, '').catch(() => undefined)
  return id
}

/* ---------- 按需抓正文 ---------- */

const inflight = new Map<string, Promise<{ title: string; html: string; text: string }>>()

export async function ensureChapterText(
  book: Book,
  index: number,
): Promise<{ title: string; html: string; text: string }> {
  const ch = await dbGet<StoredChapterRow>('chapters', [book.id, index])
  if (!ch) throw new SourceError('CONTENT_EMPTY', '章节不存在')

  // 本地书 / 已缓存：直接返回。
  if (ch.text || !ch.remoteUrl) {
    return { title: ch.title, html: ch.html || textToHtml(ch.text || ''), text: ch.text || '' }
  }

  const key = `${book.id}:${index}`
  const running = inflight.get(key)
  if (running) return running

  const task = (async () => {
    if (!book.sourceId) throw new SourceError('SRC_NOT_FOUND', '缺少书源')
    if (!(await loadNetworkEnabled())) throw new SourceError('SRC_DISABLED')
    const src = await getSource(book.sourceId)
    if (!src) throw new SourceError('SRC_NOT_FOUND')
    if (!src.enabled) throw new SourceError('SRC_DISABLED', '该书源已停用')

    const raw = await loadChapter(
      makeCtx(src),
      { title: ch.title, url: ch.remoteUrl! },
      // 部分源站校验 Referer 必须是上一跳；目录页 / 详情页是最自然的值。
      book.remoteTocUrl || book.remoteBookUrl,
    )
    const chars = raw.text.replace(/\s/g, '').length

    await dbPut('chapters', { ...ch, html: raw.html, text: raw.text, wordCount: chars })

    const store = useBookStore()
    const live = store.getBook(book.id) || book
    await store.updateBook(book.id, {
      wordCount: (live.wordCount || 0) + chars,
      cachedChapterCount: (live.cachedChapterCount || 0) + 1,
    })

    markHealth(src.id, 1, '').catch(() => undefined)
    return { title: ch.title, html: raw.html, text: raw.text }
  })()

  inflight.set(key, task)
  try {
    return await task
  } catch (e) {
    // 规则取空 / 网络失败：让书源在管理页变红，用户能看出该换源了。
    const code = (e as SourceError)?.code
    if (book.sourceId && (code === 'CONTENT_EMPTY' || code === 'RULE_EMPTY' || code === 'NET_HTTP')) {
      markHealth(book.sourceId, 3, (e as Error).message).catch(() => undefined)
    }
    throw e
  } finally {
    inflight.delete(key)
  }
}

/* ---------- 进度兜底 ---------- */

/** 源站增删章节会让 index 错位，恢复时优先按章节 URL 对回。 */
export function restorePosition(book: Book, chapters: Array<{ remoteUrl?: string }>): number {
  if (!book.lastRemoteUrl) return book.lastChapterIndex
  const hit = chapters.findIndex(c => c.remoteUrl === book.lastRemoteUrl)
  return hit >= 0 ? hit : Math.min(book.lastChapterIndex, Math.max(0, chapters.length - 1))
}

/* ---------- 换源 ---------- */

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

function cnToNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  let total = 0
  let section = 0
  let num = 0
  let seen = false
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch]
      seen = true
    } else if (ch in CN_UNITS) {
      section += (num || 1) * CN_UNITS[ch]
      num = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + section + num : null
}

function chapterNumber(title: string): number | null {
  const m = /第\s*([0-9零一两二三四五六七八九十百千]+)\s*[章回节卷集部篇幕场]/.exec(title || '')
  if (!m) return null
  return cnToNumber(m[1])
}

/** 「第12章 xxx」与「第十二章 xxx」视为同一章。 */
function similarTitle(a: string, b: string): boolean {
  const na = chapterNumber(a)
  const nb = chapterNumber(b)
  if (na !== null && nb !== null) return na === nb
  const norm = (s: string) => (s || '').replace(/[\s:：、,.。\-—－_]/g, '').trim()
  return !!norm(a) && norm(a) === norm(b)
}

export async function switchSource(bookId: string, hit: SearchHit): Promise<void> {
  const store = useBookStore()
  if (!store.books.length) await store.loadBooks()
  const book = store.getBook(bookId)
  if (!book) throw new SourceError('SRC_NOT_FOUND', '书籍不存在')

  const src = await getSource(hit.sourceId)
  if (!src) throw new SourceError('SRC_NOT_FOUND')
  if (!src.enabled) throw new SourceError('SRC_DISABLED', '该书源已停用')
  if (!(await loadNetworkEnabled())) throw new SourceError('SRC_DISABLED')

  const cur = await dbGet<StoredChapterRow>('chapters', [bookId, book.lastChapterIndex])
  const curTitle = cur?.title || ''
  const curOffset = book.lastCharOffset

  const { info, chapters } = await loadBook(makeCtx(src), hit.bookUrl)
  if (!chapters.length) throw new SourceError('TOC_EMPTY')

  await dbDeleteByIndex('chapters', 'bookId', bookId)
  await dbPutMany('chapters', chapters.map(c => ({
    bookId,
    index: c.index,
    title: c.title,
    html: '',
    text: '',
    charOffset: 0,
    wordCount: 0,
    remoteUrl: c.url,
  })))

  let idx = chapters.findIndex(c => similarTitle(c.title, curTitle))
  if (idx < 0) idx = Math.min(book.lastChapterIndex, chapters.length - 1)

  await store.updateBook(bookId, {
    sourceId: src.id,
    remoteBookUrl: hit.bookUrl,
    remoteTocUrl: info.tocUrl,
    lastChapterIndex: idx,
    lastCharOffset: idx === book.lastChapterIndex ? curOffset : 0,
    lastRemoteUrl: chapters[idx]?.url,
    cachedChapterCount: 0,
    wordCount: 0,
  })
}

/* ---------- 体检 ---------- */

export interface DiagnoseStep {
  key: string
  label: string
  ok: boolean
  detail: string
}

export interface DiagnoseResult {
  health: number
  steps: DiagnoseStep[]
}

function errorText(e: unknown): string {
  return (e as Error)?.message || '失败'
}

/**
 * 四段判定：搜索 → 详情 → 目录 → 正文。任一环节失败都返回已完成的部分，
 * 让用户在调试页直接看出断在哪一段。
 */
export async function diagnose(source: BookSource, key: string): Promise<DiagnoseResult> {
  const ctx: SourceCtx = makeCtx(source)
  const steps: DiagnoseStep[] = []
  const raw = source.raw || {}
  let health = 1

  let hit: SearchHit | undefined
  try {
    const hits = await withTimeout(search(ctx, key || '小说'), 12000)
    if (!hits.length) {
      steps.push({ key: 'search', label: '搜索', ok: false, detail: '命中 0 条' })
      return { health: 3, steps }
    }
    hit = hits.find(h => h.title.includes(key)) || hits[0]
    steps.push({
      key: 'search',
      label: '搜索',
      ok: true,
      detail: `命中 ${hits.length} 条；样本：${hit.title} / ${hit.author || '未知作者'}`,
    })
  } catch (e) {
    steps.push({ key: 'search', label: '搜索', ok: false, detail: errorText(e) })
    return { health: 3, steps }
  }

  const bi = raw.ruleBookInfo || {}
  const rt = raw.ruleToc || {}
  let infoDoc: Document
  try {
    infoDoc = await ctx.doc(hit.bookUrl)
  } catch (e) {
    steps.push({ key: 'info', label: '详情', ok: false, detail: errorText(e) })
    return { health: 2, steps }
  }

  const title = extract(infoDoc, bi.name, hit.bookUrl)
  const author = extract(infoDoc, bi.author, hit.bookUrl)
  const cover = extract(infoDoc, bi.coverUrl, hit.bookUrl)
  const declaredToc = extract(infoDoc, bi.tocUrl, hit.bookUrl)
  const infoOk = !!title || !!author
  steps.push({
    key: 'info',
    label: '详情',
    ok: infoOk,
    detail: `书名：${title || '（空）'}；作者：${author || '（空）'}；封面：${cover ? '有' : '无'}；tocUrl：${declaredToc || '（空，用详情页）'}`,
  })
  if (!infoOk) health = 2

  let tocDoc: Document | null = null
  let tocUrl = hit.bookUrl
  try {
    tocUrl = declaredToc ? absUrl(declaredToc, hit.bookUrl) : hit.bookUrl
    tocDoc = tocUrl === hit.bookUrl ? infoDoc : await ctx.doc(tocUrl, hit.bookUrl)
  } catch (e) {
    steps.push({ key: 'toc', label: '目录', ok: false, detail: errorText(e) })
    return { health: 2, steps }
  }

  const chapterEls = rt.chapterList ? query(tocDoc, rt.chapterList) : []
  if (!chapterEls.length) {
    steps.push({ key: 'toc', label: '目录', ok: false, detail: 'chapterList 命中 0 章' })
    return { health: 2, steps }
  }

  const nameOf = (el: Element) => extract(el, rt.chapterName || 'text')
  const firstUrl = extract(chapterEls[0], rt.chapterUrl || 'href', tocUrl)
  steps.push({
    key: 'toc',
    label: '目录',
    ok: true,
    detail: `${chapterEls.length} 章；首：${nameOf(chapterEls[0]) || '（无标题）'}；末：${nameOf(chapterEls[chapterEls.length - 1]) || '（无标题）'}`,
  })

  if (!firstUrl) {
    steps.push({ key: 'content', label: '正文', ok: false, detail: 'chapterUrl 全为空' })
    return { health: 2, steps }
  }

  try {
    const body = await loadChapter(ctx, { title: nameOf(chapterEls[0]) || '第1章', url: firstUrl }, tocUrl)
    const chars = body.text.replace(/\s/g, '').length
    const ok = chars > 200
    steps.push({
      key: 'content',
      label: '正文',
      ok,
      detail: `${chars} 字；预览：${body.text.slice(0, 40).replace(/\s+/g, '')}`,
    })
    if (!ok) health = 2
  } catch (e) {
    steps.push({ key: 'content', label: '正文', ok: false, detail: errorText(e) })
    health = 2
  }

  return { health, steps }
}

/* ---------- 缓存清理 ---------- */

/** 只清在线章节的正文，目录 / 进度 / 书签 / 划线都保留。 */
export async function clearOnlineChapterCache(): Promise<number> {
  const all = await dbGetAll<StoredChapterRow>('chapters')
  const rows = all.filter(c => !!c.remoteUrl && (!!c.text || !!c.html))
  if (!rows.length) return 0

  await dbPutMany('chapters', rows.map(r => ({ ...r, html: '', text: '', wordCount: 0 })))

  const touched = new Set(rows.map(r => r.bookId))
  const store = useBookStore()
  for (const id of touched) {
    const live = store.getBook(id)
    if (live) {
      await store.updateBook(id, { wordCount: 0, cachedChapterCount: 0 })
    } else {
      const b = await dbGet<Book>('books', id)
      if (b) await dbPut('books', { ...b, wordCount: 0, cachedChapterCount: 0 })
    }
  }
  return rows.length
}
