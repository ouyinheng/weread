import JSZip from 'jszip'

export interface ParsedBook {
  title: string
  author: string
  cover: string | null
  chapters: ChapterRaw[]
  totalWords: number
}

/**
 * Bump whenever parsing output changes shape. Books imported by an older
 * parser are rebuilt from their stored source bytes instead of silently
 * keeping broken markup (e.g. XHTML <head> leaking into the reader).
 */
export const PARSER_VERSION = 4

export interface ChapterRaw {
  title: string
  html: string
  text: string
}

const CHAPTER_PATTERNS = [
  /^第[0-9一二三四五六七八九十百千零两]+[章回节卷集部篇幕场话本折出步字录帖令则例条款则]{1,2}[\s:：、，,。．.\-—－-]*.*$/,
  /^(?:序章|序言|序|前言|楔子|引子|序曲|序幕|终章|尾声|终曲|大结局|结局|番外|后记|跋|附录)[\s:：、，,。．.\-—－-]*.*$/,
  /^Chapter\s+\d+.*$/im,
  /^第\d+章.*$/,
  /^\d+[.、．]\s*\S+.*$/,
]

const TITLE_PATTERNS = [
  /^《(.+?)》\s*(?:作者[:：]\s*(.+?))?$/,
  /^(.+?)\s*[-—－]\s*(.+?)$/,
  /^\[(.+?)\]/,
]

export function detectEncoding(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be'

  // Decode a large sample, then trim back to a codepoint boundary so a
  // multi-byte character split by the sample window cannot fake an error.
  const SAMPLE = Math.min(bytes.length, 256 * 1024)
  const sample = bytes.subarray(0, SAMPLE)

  if (isValidUtf8(sample)) return 'utf-8'

  // Not UTF-8: prefer GBK when the byte stream looks like GBK double-byte pairs.
  let gbkPairs = 0
  let highBytes = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]
    if (b >= 0x81 && b <= 0xFE) {
      highBytes++
      const n = sample[i + 1]
      if (n >= 0x40 && n <= 0xFE && n !== 0x7F) { gbkPairs++; i++ }
    } else if (b >= 0x80) {
      highBytes++
    }
  }
  if (gbkPairs > 0 && gbkPairs * 2 >= highBytes * 0.6) return 'gbk'
  return 'utf-8'
}

/**
 * Strict UTF-8 validation that tolerates a truncated trailing codepoint
 * (the sample window may cut a 2-4 byte sequence in half).
 */
function isValidUtf8(b: Uint8Array): boolean {
  let i = 0
  const n = b.length
  while (i < n) {
    const c = b[i]
    if (c < 0x80) { i++; continue }

    let need = 0
    if (c >= 0xC2 && c <= 0xDF) need = 1
    else if (c >= 0xE0 && c <= 0xEF) need = 2
    else if (c >= 0xF0 && c <= 0xF4) need = 3
    else return false

    if (i + need >= n) return true // truncated tail — treat as valid
    for (let k = 1; k <= need; k++) {
      const cc = b[i + k]
      if (cc < 0x80 || cc > 0xBF) return false
    }
    // Reject overlong / surrogate / out-of-range forms.
    if (need === 2) {
      const c1 = b[i + 1]
      if (c === 0xE0 && c1 < 0xA0) return false
      if (c === 0xED && c1 > 0x9F) return false
    } else if (need === 3) {
      const c1 = b[i + 1]
      if (c === 0xF0 && c1 < 0x90) return false
      if (c === 0xF4 && c1 > 0x8F) return false
    }
    i += need + 1
  }
  return true
}

export function parseTitleFromFilename(filename: string): { title: string; author: string } {
  const name = filename.replace(/\.(txt|epub|pdf|mobi|azw3|md|doc|docx)$/i, '')
  for (const pat of TITLE_PATTERNS) {
    const m = name.match(pat)
    if (m) {
      return { title: m[1].trim(), author: (m[2] || '').trim() }
    }
  }
  return { title: name.trim(), author: '' }
}

function isChapterTitle(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 80) return false
  // Must contain 章/回/节/卷 etc., and be short enough to be a heading
  if (trimmed.length > 50) {
    // Only allow if it's a short prefix match (heading + maybe a few chars)
    const m = trimmed.match(/^(第[0-9一二三四五六七八九十百千零两]+[章回节卷集部篇幕场]|(?:序章|序言|序|前言|楔子|引子|序曲|序幕|终章|尾声|终曲|大结局|结局|番外|后记|跋|附录))\s*[:：、，,。．.\-—－-]?\s*(.{0,40})$/)
    return !!m
  }
  return CHAPTER_PATTERNS.some(p => p.test(trimmed))
}

export function segmentTxt(text: string): ChapterRaw[] {
  const lines = text.split(/\r?\n/)
  const chapters: ChapterRaw[] = []
  let current: ChapterRaw | null = null

  for (const line of lines) {
    if (isChapterTitle(line)) {
      if (current) chapters.push(current)
      current = { title: line.trim(), html: '', text: '' }
    } else {
      if (!current) {
        current = { title: '', html: '', text: '' }
      }
      current.text += line + '\n'
    }
  }
  if (current) chapters.push(current)

  // If line-based detection found few chapters but text is long, try inline chapter markers
  if (chapters.length <= 5 && text.length > 10000) {
    const inline = segmentByInlineMarkers(text)
    if (inline.length > chapters.length) return finalizeChapters(inline)
  }

  // Filter empty leading chapter
  const filtered = chapters.filter(c => c.title || c.text.trim())
  if (filtered.length === 0) {
    filtered.push({ title: '', html: '', text })
  }
  return finalizeChapters(filtered)
}

// Inline chapter markers like "1.第1章序章" or "2.第2章青云" embedded in paragraphs
const INLINE_CHAPTER_RE = /(\d{1,4}\s*[.、．]\s*第[0-9一二三四五六七八九十百千零两]+[章回节卷集部篇幕场][^\n]{0,40})/g

function segmentByInlineMarkers(text: string): ChapterRaw[] {
  const matches: { index: number; title: string }[] = []
  let m: RegExpExecArray | null
  INLINE_CHAPTER_RE.lastIndex = 0
  while ((m = INLINE_CHAPTER_RE.exec(text))) {
    matches.push({ index: m.index, title: m[1].trim() })
  }
  if (matches.length < 2) return []

  const chapters: ChapterRaw[] = []
  // Content before first chapter marker
  const preText = text.slice(0, matches[0].index)
  if (preText.trim()) {
    chapters.push({ title: '', html: '', text: preText })
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    // Extract just the title part (strip leading number)
    const title = matches[i].title.replace(/^\d{1,4}\s*[.、．]\s*/, '').trim()
    chapters.push({
      title,
      html: '',
      text: text.slice(start + matches[i].title.length, end)
    })
  }
  return chapters
}

function finalizeChapters(list: ChapterRaw[]): ChapterRaw[] {
  return list.map(c => ({
    ...c,
    html: c.text.split(/\r?\n/)
      .filter(l => l.trim())
      .map(l => `<p>${escapeHtml(l.trim())}</p>`)
      .join('')
  }))
}

export async function parseTxt(buffer: ArrayBuffer, filename: string): Promise<ParsedBook> {
  const encoding = detectEncoding(buffer)
  const text = decodeWithFallback(buffer, encoding)
  const { title, author } = parseTitleFromFilename(filename)
  const chapters = segmentTxt(text)
  const totalWords = text.replace(/\s/g, '').length
  return { title, author, cover: null, chapters, totalWords }
}

/** Decode with the detected encoding, degrading gracefully if unsupported. */
function decodeWithFallback(buffer: ArrayBuffer, encoding: string): string {
  const order = encoding === 'utf-8'
    ? ['utf-8', 'gbk']
    : [encoding, 'utf-8', 'gbk']
  for (const enc of order) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(buffer)
    } catch {
      // Encoding label not supported by this runtime — try the next one.
    }
  }
  // Last resort: strip invalid sequences instead of throwing.
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function parseEpub(buffer: ArrayBuffer, filename: string): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buffer)
  const { title, author } = parseTitleFromFilename(filename)

  // 1. Find OPF path
  let opfPath = 'OEBPS/content.opf'
  const containerFile = zip.file('META-INF/container.xml')
  if (containerFile) {
    const xml = await containerFile.async('string')
    const m = xml.match(/full-path="([^"]+)"/)
    if (m) opfPath = m[1]
  }

  const opfXml = await zip.file(opfPath)?.async('string') || ''

  // 2. Parse manifest & spine
  const manifest: Record<string, string> = {}
  const manifestRe = /<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*\/?>/g
  const manifestRe2 = /<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/?>/g
  let m: RegExpExecArray | null
  while ((m = manifestRe.exec(opfXml))) manifest[m[2]] = m[1]
  while ((m = manifestRe2.exec(opfXml))) manifest[m[1]] = m[2]

  const spine: string[] = []
  const spineRe = /<itemref\s[^>]*idref="([^"]+)"[^>]*\/?>/g
  while ((m = spineRe.exec(opfXml))) {
    const href = manifest[m[1]]
    if (href) spine.push(href)
  }

  // 3. Parse metadata
  const titleM = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)
  const authorM = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)
  const coverM = opfXml.match(/<meta\s[^>]*name="cover"[^>]*content="([^"]+)"/)
  let cover: string | null = null
  // `blob:` URLs die on reload, so a persisted cover must be self-contained.
  // Look for the manifest-declared cover first, then fall back to common names.
  const coverCandidates: string[] = []
  if (coverM && manifest[coverM[1]]) coverCandidates.push(resolvePath(opfPath, manifest[coverM[1]]))
  for (const [id, href] of Object.entries(manifest)) {
    if (/cover/i.test(id) || /cover/i.test(href)) {
      const p = resolvePath(opfPath, href)
      if (!coverCandidates.includes(p)) coverCandidates.push(p)
    }
  }
  for (const coverPath of coverCandidates) {
    const coverFile = zip.file(coverPath)
    if (!coverFile) continue
    const ext = (coverPath.split('.').pop() || '').toLowerCase()
    const mime = ext === 'png' ? 'image/png'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg'
    const base64 = await coverFile.async('base64')
    cover = `data:${mime};base64,${base64}`
    break
  }

  // 4. Parse NCX for chapter titles
  const ncxTitles: string[] = []
  const ncxFile = zip.file(/\.ncx$/)
  if (ncxFile.length > 0) {
    const ncxXml = await ncxFile[0].async('string')
    const labelRe = /<text>([^<]+)<\/text>/g
    while ((m = labelRe.exec(ncxXml))) ncxTitles.push(m[1].trim())
  }

  // 5. Parse chapters
  const imageCache = new Map<string, string | null>()
  const mimeOf = (p: string): string => {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'svg') return 'image/svg+xml'
    if (ext === 'webp') return 'image/webp'
    return 'image/jpeg'
  }

  /** Resolve an in-chapter <img src> against the zip, as a data URL. */
  const makeResolver = (chapterPath: string) => (src: string): string | null => {
    if (/^(data:|https?:|blob:)/i.test(src)) return src
    const target = src.startsWith('/')
      ? src.slice(1)
      : resolvePath(chapterPath.replace(/[^/]+$/, 'x'), src)
    if (imageCache.has(target)) return imageCache.get(target)!
    const f = zip.file(target) || zip.file(decodeURIComponent(target))
    if (!f) { imageCache.set(target, null); return null }
    return target // filled in async below
  }

  const chapters: ChapterRaw[] = []
  let totalWords = 0
  for (let i = 0; i < spine.length; i++) {
    const href = spine[i]
    const path = resolvePath(opfPath, href)
    const file = zip.file(path)
    if (!file) continue
    const raw = await file.async('string')

    // Pre-collect image paths referenced by this chapter and inline them.
    const srcRe = /<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi
    const found: string[] = []
    let sm: RegExpExecArray | null
    while ((sm = srcRe.exec(raw))) found.push(decodeEntities(sm[1]))

    const resolve = makeResolver(path)
    for (const src of found) {
      const target = resolve(src)
      if (!target || imageCache.has(target)) continue
      const imgFile = zip.file(target) || zip.file(decodeURIComponent(target))
      if (!imgFile) { imageCache.set(target, null); continue }
      const b64 = await imgFile.async('base64')
      imageCache.set(target, `data:${mimeOf(target)};base64,${b64}`)
    }

    const html = extractBodyHtml(raw, (src) => {
      if (/^(data:|https?:|blob:)/i.test(src)) return src
      const target = src.startsWith('/')
        ? src.slice(1)
        : resolvePath(path.replace(/[^/]+$/, 'x'), src)
      return imageCache.get(target) ?? null
    })
    // Text is derived from the cleaned body so head/title never leaks into it.
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    totalWords += text.replace(/\s/g, '').length
    // Cover/colophon pages carry no prose; an empty chapter renders as a
    // blank page, so skip it rather than making the reader look broken.
    if (!text) continue
    const title = ncxTitles[ncxTitles.length > chapters.length ? chapters.length : i] || `Chapter ${chapters.length + 1}`
    chapters.push({ title, html, text })
  }

  return {
    title: titleM ? titleM[1].trim() : title,
    author: authorM ? authorM[1].trim() : author,
    cover,
    chapters,
    totalWords
  }
}

function resolvePath(base: string, relative: string): string {
  const dir = base.substring(0, base.lastIndexOf('/'))
  if (relative.startsWith('/')) return relative.substring(1)
  return dir ? `${dir}/${relative}` : relative
}

/**
 * Reduce a full XHTML document to renderable body markup.
 *
 * EPUB chapter files are complete documents: `<head>`, `<title>`, `<link>`,
 * `<meta>`, inline `<svg>` covers, XML declarations. Injecting them wholesale
 * via v-html renders literal "<title>…" text and can break the reader layout —
 * so keep only the body and only the tags that make sense in a reflowed novel.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'em', 'i', 'b', 'strong', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'cite', 'q',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'pre', 'code', 'ruby', 'rt', 'rp', 'small', 'big', 'abbr', 'time', 'mark',
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'col', 'input', 'meta', 'link', 'source', 'area', 'base', 'embed', 'param', 'track'])

/**
 * @param raw        the chapter's XHTML source
 * @param resolveSrc optional hook that maps an in-book image path to a
 *                   renderable URL (EPUB images live inside the zip, so a bare
 *                   relative `src` can never load in the WebView).
 */
export function extractBodyHtml(raw: string, resolveSrc?: (src: string) => string | null): string {
  let html = raw

  // 1. Drop XML/doctype prologs and comments.
  html = html.replace(/<\?xml[\s\S]*?\?>/gi, '')
  html = html.replace(/<!DOCTYPE[\s\S]*?>/gi, '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')

  // 2. Keep only what's inside <body> when a body exists.
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (bodyMatch) html = bodyMatch[1]

  // 3. Remove elements that must never reach the reader.
  html = html.replace(/<head\b[\s\S]*?<\/head>/gi, '')
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style\b[\s\S]*?<\/style>/gi, '')
  html = html.replace(/<title\b[\s\S]*?<\/title>/gi, '')
  html = html.replace(/<link\b[^>]*>/gi, '')
  html = html.replace(/<meta\b[^>]*>/gi, '')
  html = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
  html = html.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
  html = html.replace(/<object\b[\s\S]*?<\/object>/gi, '')
  html = html.replace(/<canvas\b[\s\S]*?<\/canvas>/gi, '')
  html = html.replace(/<form\b[\s\S]*?<\/form>/gi, '')
  html = html.replace(/<audio\b[\s\S]*?<\/audio>/gi, '')
  html = html.replace(/<video\b[\s\S]*?<\/video>/gi, '')

  // 4. Unwrap disallowed tags but keep their text, dropping event handlers.
  html = html.replace(/<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g, (full, tag: string, attrs: string) => {
    const name = tag.toLowerCase()
    if (name === 'body' || name === 'html') return ''

    if (!ALLOWED_TAGS.has(name)) {
      // Keep the tag's text content by removing just the delimiters.
      return ''
    }

    if (VOID_TAGS.has(name)) {
      if (name === 'img') {
        const src = /src\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)
        const alt = /alt\s*=\s*["']([^"']*)/i.exec(attrs)
        if (!src) return ''
        const mapped = resolveSrc ? resolveSrc(decodeEntities(src[1])) : src[1]
        if (mapped === null) return ''
        return `<img src="${escapeAttr(mapped)}" alt="${escapeAttr(alt ? alt[1] : '')}" />`
      }
      return `<${name}${name === 'br' || name === 'hr' ? ' /' : ''}>`
    }

    const closing = full.startsWith('</')
    if (closing) return `</${name}>`

    // Only keep a whitelist of attributes: images and simple alignment.
    const keep: string[] = []
    if (name === 'img') {
      const src = /src\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)
      if (!src) return ''
      const mapped = resolveSrc ? resolveSrc(decodeEntities(src[1])) : src[1]
      if (mapped === null) return ''
      keep.push(`src="${escapeAttr(mapped)}"`)
      const alt = /alt\s*=\s*["']([^"']*)/i.exec(attrs)
      if (alt) keep.push(`alt="${escapeAttr(alt[1])}"`)
    }
    const cls = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (cls && name !== 'img') keep.push(`class="${escapeAttr(cls[1])}"`)
    // Filters out EPUB publisher styling (centering, fonts, colours, sizes):
    // the reader owns typography, so only structural hints survive.
    const style = /style\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (style) {
      const safe = style[1]
        .split(';')
        .map(decl => decl.trim())
        .filter(decl => {
          const lower = decl.toLowerCase()
          if (!lower) return false
          // Never let the book override alignment, font or colour.
          if (/^(text-align|font|color|background|line-height|letter-spacing|white-space|direction|display|position|width|height)\b/.test(lower)) return false
          return /^[\w-]+\s*:\s*[-\w\s:;#%.,()]+$/.test(lower)
        })
        .join('; ')
      if (safe) keep.push(`style="${escapeAttr(safe)}"`)
    }

    const attrStr = keep.length ? ' ' + keep.join(' ') : ''
    return `<${name}${attrStr}>`
  })

  return normalizeParagraphs(html)
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeParagraphs(html: string): string {
  // Collapse whitespace-only text between block tags.
  html = html.replace(/>\s*\n\s*</g, '><')
  const trimmed = html.trim()
  if (!trimmed) return ''

  // If there is no block-level markup at all, wrap each line in a paragraph so
  // plain-text XHTML still reflows with indentation and spacing.
  if (!/<(p|div|h[1-6]|blockquote|li|pre|figure|table)\b/i.test(trimmed)) {
    return trimmed
      .split(/\n{1,}/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => `<p>${line}</p>`)
      .join('')
  }
  return trimmed
}
