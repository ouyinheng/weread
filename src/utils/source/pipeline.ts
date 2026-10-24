/**
 * 书源四段管线：搜索 → 详情 / 目录 → 正文。
 *
 * 只依赖注入进来的 `doc(url)`，不直接碰网络，方便单测用 fixture 替换。
 * 产出的章节形状与本地书一致（title / html / text），落库后阅读器零改动。
 */
import type { BookInfo, BookSource, RemoteChapter, SearchHit } from '@/types/source'
import { SourceError } from '@/types/source'
import type { ChapterRaw } from '@/utils/parser'
import { absUrl, extract, extractAll, query } from './selector'
import { globalGate, httpRequest, parseHtml, Semaphore, sleep, sourceHeaders, splitUrlRule, type HttpOptions } from './net'

export interface SourceCtx {
  source: BookSource
  vars: Record<string, any>
  doc(url: string, referer?: string, options?: HttpOptions): Promise<Document>
}

export function makeCtx(source: BookSource): SourceCtx {
  const vars: Record<string, any> = {}
  const extra = sourceHeaders(source.raw)
  // 同一站点并发 ≤ 3：打太狠会触发风控。
  const gate = new Semaphore(3)
  return {
    source,
    vars,
    async doc(url, referer, options) {
      const opts: HttpOptions = { headers: { ...extra, ...(options?.headers || {}) }, referer, ...options }
      const r = await globalGate.run(() => gate.run(() => httpRequest(url, opts)))
      if (r.status !== 200) throw new SourceError('NET_HTTP', `源站返回 HTTP ${r.status}`)
      return parseHtml(r.text)
    },
  }
}

function rules(source: BookSource, key: 'ruleSearch' | 'ruleBookInfo' | 'ruleToc' | 'ruleContent'): Record<string, any> {
  const raw = source.raw || {}
  const v = raw[key]
  return v && typeof v === 'object' ? v : {}
}

/** 模板填充：只换变量，不做 URL 补全（表单 body 用）。 */
export function fillVars(tpl: string, vars: Record<string, string>): string {
  let out = tpl.replace(/\{\{key\}\}/g, encodeURIComponent(vars.key ?? ''))
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'key') continue
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
  }
  return out
}

/** 模板填充：`{{key}}` 要 URL 编码，`{{page}}` 不编码，相对路径补成绝对地址。 */
export function fillTemplate(tpl: string, vars: Record<string, string>, base: string): string {
  const out = fillVars(tpl, vars)
  if (/^https?:/i.test(out)) return out
  try {
    return new URL(out.replace(/^\/+/, ''), base.replace(/\/+$/, '') + '/').toString()
  } catch {
    return out
  }
}

export async function search(ctx: SourceCtx, key: string, page = 1): Promise<SearchHit[]> {
  const raw = ctx.source.raw || {}
  const rs = rules(ctx.source, 'ruleSearch')
  if (!raw.searchUrl || !rs.bookList) return []

  /*
   * `searchUrl` 可能是 `url,{"method":"POST","body":"searchkey={{key}}"}`。
   * 拆错的话整串 JSON 会被当成路径拼到 URL 后面、还会按 GET 发出去，搜索接口
   * 直接 404 —— 这是绝大多数「导入后搜不到」的来源。
   */
  const rule = splitUrlRule(String(raw.searchUrl))
  const vars = { key, page: String(page) }
  const url = fillTemplate(rule.url, vars, ctx.source.url)
  const options: HttpOptions = { ...rule.options }
  if (options.body) options.body = fillVars(options.body, vars)

  const doc = await ctx.doc(url, undefined, options)

  return extractAll(doc, rs.bookList)
    .map(el => ({
      sourceId: ctx.source.id,
      sourceName: ctx.source.name,
      title: extract(el, rs.name, url),
      author: extract(el, rs.author, url),
      intro: extract(el, rs.intro, url),
      kind: extract(el, rs.kind, url),
      coverUrl: extract(el, rs.coverUrl, url) || null,
      bookUrl: extract(el, rs.bookUrl, url),
      lastChapter: extract(el, rs.lastChapter, url),
      wordCount: extract(el, rs.wordCount, url),
    }))
    .filter(h => h.bookUrl)
}

export interface LoadedBook {
  info: BookInfo
  chapters: RemoteChapter[]
}

/** 详情页 + 目录。`ruleBookInfo.tocUrl` 为空时，详情页本身就是目录页。 */
export async function loadBook(ctx: SourceCtx, bookUrl: string): Promise<LoadedBook> {
  const bi = rules(ctx.source, 'ruleBookInfo')
  const rt = rules(ctx.source, 'ruleToc')
  if (!rt.chapterList) throw new SourceError('RULE_EMPTY', '该源缺少目录规则')

  const infoDoc = await ctx.doc(bookUrl)
  const declaredToc = extract(infoDoc, bi.tocUrl, bookUrl)
  const tocUrl = declaredToc ? absUrl(declaredToc, bookUrl) : bookUrl
  const tocDoc = tocUrl === bookUrl ? infoDoc : await ctx.doc(tocUrl, bookUrl)

  const chapters: RemoteChapter[] = []
  const push = (el: Element, base: string) => {
    const href = extract(el, rt.chapterUrl || 'href', base)
    if (!href) return
    chapters.push({
      title: extract(el, rt.chapterName || 'text') || `第${chapters.length + 1}章`,
      url: href,
      index: chapters.length,
    })
  }

  query(tocDoc, rt.chapterList).forEach(el => push(el, tocUrl))

  // 目录翻页（分卷站）：最多追 5 页，并防环。
  const seenPages = new Set<string>([tocUrl])
  let next = extract(tocDoc, rt.nextTocUrl, tocUrl)
  for (let i = 0; i < 5 && next; i++) {
    const u = absUrl(next, tocUrl)
    if (!u || seenPages.has(u)) break
    seenPages.add(u)
    const d = await ctx.doc(u, tocUrl)
    query(d, rt.chapterList).forEach(el => push(el, u))
    next = extract(d, rt.nextTocUrl, u)
  }

  if (!chapters.length) throw new SourceError('TOC_EMPTY')

  return {
    info: {
      title: extract(infoDoc, bi.name, bookUrl),
      author: extract(infoDoc, bi.author, bookUrl),
      intro: extract(infoDoc, bi.intro, bookUrl),
      coverUrl: extract(infoDoc, bi.coverUrl, bookUrl) || null,
      tocUrl,
    },
    chapters,
  }
}

const STRIP_TAGS = 'script,style,iframe,object,embed,link,meta,form,noscript'

/**
 * 第三方正文是 untrusted HTML：`v-html` 不执行 <script>，但 `<img onerror>`
 * 会触发。这里去掉脚本、事件属性和 javascript: 链接，并把相对图片补成绝对地址。
 */
function sanitizeFragment(doc: Document, html: string, base: string): string {
  const tpl = doc.createElement('template')
  tpl.innerHTML = html
  const frag = tpl.content
  frag.querySelectorAll(STRIP_TAGS).forEach(n => n.remove())
  frag.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value || ''
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
      } else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(attr.name)
      } else if (name === 'src' && value && !/^(https?:|data:|\/\/)/i.test(value)) {
        try { el.setAttribute('src', new URL(value, base).toString()) } catch { /* 保留原值 */ }
      }
    }
  })
  return tpl.innerHTML
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 纯文本 → 段落 HTML。 */
export function textToHtml(text: string): string {
  return text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join('\n')
}

export interface RemoteChapterRef {
  title: string
  url: string
}

export async function loadChapter(
  ctx: SourceCtx,
  chapter: RemoteChapterRef,
  referer?: string,
): Promise<ChapterRaw> {
  const rc = rules(ctx.source, 'ruleContent')
  if (!rc.content) throw new SourceError('RULE_EMPTY', '该源缺少正文规则')

  const isHtml = /@html\b/i.test(rc.content) || /@all\b/i.test(rc.content)
  const parts: string[] = []
  const seen = new Set<string>([chapter.url])
  let curUrl = chapter.url
  let curDoc = await ctx.doc(curUrl, referer)

  // nextContentUrl：正文分页（"第(1/3)页" 这类），最多追 5 页。
  for (let i = 0; i < 5; i++) {
    const piece = extract(curDoc, rc.content, curUrl)
    if (piece) parts.push(isHtml ? sanitizeFragment(curDoc, piece, curUrl) : piece)

    const nextRaw = extract(curDoc, rc.nextContentUrl, curUrl)
    if (!nextRaw) break
    const next = absUrl(nextRaw, curUrl)
    if (!next || seen.has(next)) break
    seen.add(next)
    await sleep(150)
    curUrl = next
    curDoc = await ctx.doc(curUrl, chapter.url)
  }

  if (!parts.length) throw new SourceError('CONTENT_EMPTY')

  let body = parts.join('\n')
  if (typeof rc.replaceRegex === 'string' && rc.replaceRegex) {
    try { body = body.replace(new RegExp(rc.replaceRegex, 'gs'), '') } catch { /* 非法正则忽略 */ }
  }

  if (isHtml) {
    return { title: chapter.title, html: body, text: htmlToText(body) }
  }
  return { title: chapter.title, html: textToHtml(body), text: body }
}
