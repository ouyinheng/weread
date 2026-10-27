<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBookStore, useChapterStore, useSettingsStore, useBookmarkStore } from '@/stores'
import { dbGetAll } from '@/utils/db'
import {
  addHighlight,
  applyHighlights,
  loadHighlights,
  removeHighlight,
} from '@/utils/highlights'
import type { Book, Chapter, Highlight, HighlightColor } from '@/types'
import { ensureChapterText, restorePosition } from '@/utils/source/sourceService'
import ReaderTopBar from '@/components/reader/ReaderTopBar.vue'
import ReaderBottomBar from '@/components/reader/ReaderBottomBar.vue'
import CatalogDrawer from '@/components/reader/CatalogDrawer.vue'
import FontPanel from '@/components/reader/FontPanel.vue'
import ThemePanel from '@/components/reader/ThemePanel.vue'
import ProgressPanel from '@/components/reader/ProgressPanel.vue'
import NotesPanel from '@/components/reader/NotesPanel.vue'
import SelectionToolbar from '@/components/reader/SelectionToolbar.vue'
import BookSearchPanel from '@/components/reader/BookSearchPanel.vue'
import ListenView from '@/components/reader/ListenView.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import type { ReaderPanel } from '@/components/reader/ReaderBottomBar.vue'
import { listenSession } from '@/audio/session'
import { reasonText } from '@/audio/tts'
import { fontStackOf, backgroundOf } from '@/utils/fonts'
import { addReadingTime, getReadingTime, formatDuration } from '@/utils/reading-time'
import { needsRebuild, rebuildBook } from '@/utils/library'
import type { BookSearchHit } from '@/utils/book-search'
import { useBookSearch } from '@/composables/useBookSearch'
import { isNativeShell, EDGE_GESTURE_INSET, applyReaderNativeMode, resetReaderNativeMode } from '@/utils/native'
import { openOverlay, closeOverlay } from '@/utils/ui-state'
import {
  countChars,
  totalChars,
  progressPercent,
  remainingMinutes,
  remainText as remainTextOf,
  pageToChar as pageToCharAt,
  charToPage as charToPageAt,
} from '@/utils/progress'

const route = useRoute()
const router = useRouter()
const bookStore = useBookStore()
const chapterStore = useChapterStore()
const settingsStore = useSettingsStore()
const bookmarkStore = useBookmarkStore()

const bookId = route.params.id as string
const book = computed(() => bookStore.getBook(bookId))
const settings = computed(() => settingsStore.settings)

const viewportEl = ref<HTMLElement>()
const contentEl = ref<HTMLElement>()

const showMenu = ref(false)
const showBookMenu = ref(false)
const showCatalog = ref(false)
const showSearch = ref(false)
const activePanel = ref<ReaderPanel>('none')
const loading = ref(true)

const chapterList = ref<Chapter[]>([])
const chapterHtml = ref<Map<number, string>>(new Map())
/** 在线章节的源站 URL，进度恢复时按它对回章节。 */
const chapterUrls = ref<Map<number, string>>(new Map())
const currentChapter = ref(0)
const currentPage = ref(0)
const totalPages = ref(1)

/* 在线章节按需抓取时的状态（本地书始终为空） */
const fetchingChapter = ref(false)
const chapterError = ref('')
/** 超大章节重新分页时先让 loading 画出来，再进入同步排版。 */
const paginating = ref(false)

/* ---------- character bookkeeping ----------
 * Progress is stored as (chapterIndex, charOffset) — the same model WeRead uses
 * (ARG_BOOK_START_CHAR_POS), not page numbers, so it survives font/size changes.
 */
const chapterChars = computed(() => {
  const list: number[] = []
  for (let i = 0; i < chapterList.value.length; i++) {
    const html = chapterHtml.value.get(i) || ''
    list.push(html ? countChars(html) : chapterList.value[i].wordCount || 0)
  }
  return list
})

const bookChars = computed(() => totalChars(chapterChars.value))

/** Page index → character offset inside the current chapter. */
function pageToChar(page: number): number {
  return pageToCharAt(page, totalPages.value, chapterChars.value[currentChapter.value] || 0)
}

/** Character offset → page index, inverse of pageToChar for the current layout. */
function charToPage(offset: number): number {
  return charToPageAt(offset, totalPages.value, chapterChars.value[currentChapter.value] || 0)
}

const currentCharOffset = computed(() => pageToChar(currentPage.value))

/**
 * Approximate printed page for a chapter, derived from cumulative characters so
 * the catalogue can show 「3 / 13682」-style positions like WeRead does.
 */
function chapterPage(index: number): number {
  const list = chapterChars.value
  if (!list.length) return index + 1
  const charsPerPage = Math.max(1, Math.round(
    (chapterChars.value[currentChapter.value] || 1) / Math.max(1, totalPages.value)
  ))
  return 1 + Math.round(charsBeforeChars(list, index) / charsPerPage)
}

function charsBeforeChars(list: number[], index: number): number {
  let sum = 0
  for (let i = 0; i < index && i < list.length; i++) sum += list[i]
  return sum
}

/**
 * Front matter (intro/colophon) has no heading. Showing a synthetic "第1章"
 * there reads like the book starts at chapter 1 and hides the book title,
 * so fall back to the book itself.
 */
const currentChapterTitle = computed(() => {
  const title = chapterList.value[currentChapter.value]?.title || ''
  if (title) return title
  if (currentChapter.value === 0) return book.value?.title || ''
  return `第${currentChapter.value + 1}章`
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ---------- 划线 / 想法 ----------
 *
 * The reader draws its own text selection end to end. `user-select: none` on
 * the page means the platform never starts its own selection — no system bar
 * (复制 / 分享 / 全选 / 网页搜索) and no green drag handles — so the reader is
 * the only thing on screen over a selection. WeRead works the same way, and
 * it is the only way to offer 划线 and 想法, which the platform knows nothing
 * about.
 *
 * Ranges are stored as body-character offsets (see utils/highlights) and
 * re-wrapped into the markup on every render, so nothing depends on surviving
 * DOM nodes across a pagination pass.
 */
const highlights = ref<Highlight[]>([])

/** A live selection: character range, its text, and the boxes to paint. */
const sel = ref<{
  start: number
  end: number
  text: string
  /** Viewport-space rects covering the selected text (one per rendered line). */
  rects: { x: number; y: number; w: number; h: number }[]
  /** Centres of the two drag handles. */
  handles: { x: number; y: number }[]
} | null>(null)
const selPos = ref({ x: 0, y: 0 })

function clearSelection() {
  sel.value = null
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

/** Character offset of (node, offset) inside the chapter body element. */
function bodyOffset(node: Node, offset: number): number {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body) return -1
  const r = document.createRange()
  r.selectNodeContents(body)
  try {
    r.setEnd(node, offset)
  } catch {
    return -1
  }
  return r.toString().length
}

/** Build a Range spanning exactly `[start, end)` characters of the body. */
function rangeForOffsets(body: Element, start: number, end: number): Range | null {
  const doc = body.ownerDocument
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let pos = 0
  let startNode: Text | null = null
  let startAt = 0
  let endNode: Text | null = null
  let endAt = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    const len = t.data.length
    if (!startNode && pos + len >= start) {
      startNode = t
      startAt = start - pos
    }
    if (pos + len >= end) {
      endNode = t
      endAt = Math.min(len, end - pos)
      break
    }
    pos += len
  }
  if (!startNode || !endNode) return null
  const r = doc.createRange()
  try {
    r.setStart(startNode, startAt)
    r.setEnd(endNode, endAt)
  } catch {
    return null
  }
  return r
}

/** Character under a viewport point, or -1. */
function offsetAtPoint(x: number, y: number): number {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body) return -1
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    if (!r) return -1
    node = r.startContainer
    offset = r.startOffset
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    if (!p) return -1
    node = p.offsetNode
    offset = p.offset
  } else {
    return -1
  }
  if (!body.contains(node)) return -1
  return bodyOffset(node, offset)
}

/**
 * Long-press selects a chunk of text around the finger: out to the nearest
 * punctuation or gap on each side, capped so a press deep in a long paragraph
 * does not swallow the whole chapter. WeRead does the same word-granularity
 * pick; Chinese has no spaces, so punctuation is the honest boundary.
 */
const CHUNK_BREAK = /[，。！？；：、…—\s"'“”‘’（）()《》【】\[\]{}·,.!?;:]/
const CHUNK_MAX = 40

function expandChunk(text: string, pos: number): [number, number] {
  let start = pos
  let end = pos
  while (start > 0 && pos - start < CHUNK_MAX && !CHUNK_BREAK.test(text[start - 1])) start--
  while (end < text.length && end - pos < CHUNK_MAX && !CHUNK_BREAK.test(text[end])) end++
  if (end < text.length && CHUNK_BREAK.test(text[end])) end++
  return [start, end]
}

/** Repaint the selection boxes + handles for `[start, end)`. */
function applySelectionRange(start: number, end: number) {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body || !(end > start)) {
    sel.value = null
    return
  }
  const full = body.textContent || ''
  const range = rangeForOffsets(body, start, end)
  if (!range) {
    sel.value = null
    return
  }
  const rects = [...range.getClientRects()]
    .map(r => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
    .filter(r => r.w > 0.5 && r.h > 0.5)

  const first = rects[0]
  const last = rects[rects.length - 1] || first
  const handles = first && last
    ? [
        { x: first.x, y: first.y + first.h / 2 },
        { x: last.x + last.w, y: last.y + last.h / 2 },
      ]
    : []

  sel.value = { start, end, text: full.slice(start, end), rects, handles }

  const x = first ? first.x + first.w / 2 : window.innerWidth / 2
  const y = first ? first.y - 8 : 120
  // The bar now carries a colour row too, so it is taller than the old two-row
  // menu; keep enough headroom that it never slides under the status bar.
  selPos.value = {
    x: Math.min(Math.max(x, 130), window.innerWidth - 130),
    y: Math.max(y, 152),
  }
}

function startSelectionAt(x: number, y: number) {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body) return
  const pos = offsetAtPoint(x, y)
  if (pos < 0) return
  const [start, end] = expandChunk(body.textContent || '', pos)
  applySelectionRange(start, end)
  if (sel.value) selectionStartedThisTouch = true
}

/** Select every character of the chapter body — WeRead's 全选. */
function selectWholeBody() {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body) return
  applySelectionRange(0, (body.textContent || '').length)
}

/** Look the selection up in a search engine — the offline stand-in for 查询. */
function webSearchSelection() {
  const text = (sel.value?.text || '').trim().slice(0, 120)
  clearSelection()
  if (!text) return
  window.open(`https://www.baidu.com/s?wd=${encodeURIComponent(text)}`, '_blank', 'noopener')
}

const allSelected = computed(() => {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body || !sel.value) return false
  return sel.value.start === 0 && sel.value.end >= (body.textContent || '').length
})

async function saveHighlight(note: string, color: HighlightColor = 'blue') {
  const r = sel.value
  if (!r) return
  const row = await addHighlight({
    bookId,
    chapterIndex: currentChapter.value,
    start: r.start,
    end: r.end,
    text: r.text,
    note,
    color,
  })
  highlights.value = [...highlights.value, row]
  clearSelection()
}

/** Adapters for the two selection-bar buttons (事件带颜色参数). */
function onHighlight(color: HighlightColor): void {
  void saveHighlight('', color)
}

function onNote(text: string, color: HighlightColor): void {
  void saveHighlight(text, color)
}

async function deleteHighlight(id: string) {
  await removeHighlight(id)
  highlights.value = highlights.value.filter(h => h.id !== id)
}

async function copySelection() {
  const text = sel.value?.text || ''
  clearSelection()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard blocked — the text is still in the user's own selection history */
  }
}

async function shareSelection() {
  const text = sel.value?.text || ''
  clearSelection()
  if (!text) return
  const payload = { text, title: book.value?.title || '' }
  if (navigator.share) {
    try {
      await navigator.share(payload)
      return
    } catch {
      /* user dismissed the sheet */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* nothing more we can do offline */
  }
}

/* ---- long-press + handle drag ----
 * A press becomes a selection only if the finger stays still; anything earlier
 * is a swipe, which the swipe handler still owns.
 */
const LONG_PRESS_MS = 380
let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressX = 0
let pressY = 0
let dragEnd: 'start' | 'end' | null = null
let suppressNextClick = false
let suppressTimer: ReturnType<typeof setTimeout> | null = null
/** True when this touch created a selection; its trailing click must not clear it. */
let selectionStartedThisTouch = false

/** Swallow exactly one click, so a tap that dismisses a selection does not also turn the page. */
function suppressClickOnce() {
  suppressNextClick = true
  if (suppressTimer) clearTimeout(suppressTimer)
  suppressTimer = setTimeout(() => { suppressNextClick = false }, 400)
}

function handleHit(x: number, y: number): 'start' | 'end' | null {
  const hs = sel.value?.handles
  if (!hs || hs.length < 2) return null
  for (const side of ['start', 'end'] as const) {
    const h = side === 'start' ? hs[0] : hs[1]
    if (Math.abs(x - h.x) < 30 && Math.abs(y - h.y) < 30) return side
  }
  return null
}

function onPressStart(x: number, y: number) {
  // Dragging an existing handle wins over starting a new selection.
  if (sel.value) {
    dragEnd = handleHit(x, y)
    if (dragEnd) return
    clearSelection()
    // This press only dismisses the bar; the click that follows must not turn a page.
    suppressClickOnce()
    return
  }
  pressX = x
  pressY = y
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    startSelectionAt(pressX, pressY)
  }, LONG_PRESS_MS)
}

/** Timestamp of the last real touch, used to reject synthesized mouse events. */
let lastTouchAt = 0

/**
 * Chromium fires a compatibility mouse sequence after a tap (mousedown →
 * mouseup → click). Treating that mousedown as a new press clears the selection
 * the long-press just made, so the selection bar only survives until finger-up.
 * `sourceCapabilities` marks those events; the timestamp covers WebViews that
 * do not expose it.
 */
function isSyntheticMouse(e: MouseEvent): boolean {
  const caps = (e as MouseEvent & {
    sourceCapabilities?: { firesTouchEvents?: boolean }
  }).sourceCapabilities
  return Boolean(caps?.firesTouchEvents) || Date.now() - lastTouchAt < 500
}

/**
 * Desktop / preview mirror of the touch path. A long-press still ends in a
 * `click`, which would otherwise dismiss the menu it just opened, so the click
 * right after a selection is swallowed.
 */
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 || isSyntheticMouse(e)) return
  onPressStart(e.clientX, e.clientY)
}
function onMouseMove(e: MouseEvent) {
  if (isSyntheticMouse(e)) return
  if (!pressTimer && !dragEnd) return
  onPressMove(e.clientX, e.clientY)
}
function onMouseUp(e: MouseEvent) {
  if (isSyntheticMouse(e)) return
  onPressEnd()
  if (sel.value) suppressClickOnce()
}

function onPressMove(x: number, y: number) {
  if (dragEnd && sel.value) {
    const pos = offsetAtPoint(x, y)
    if (pos < 0) return
    const s = dragEnd === 'start' ? Math.min(pos, sel.value.end - 1) : sel.value.start
    const e = dragEnd === 'end' ? Math.max(pos, sel.value.start + 1) : sel.value.end
    applySelectionRange(s, e)
    return
  }
  if (pressTimer && (Math.abs(x - pressX) > 10 || Math.abs(y - pressY) > 10)) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function onPressEnd() {
  dragEnd = null
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

/**
 * Chapter opener, prepended to the body HTML.
 *
 * WeRead opens a chapter with two flush-left lines: the chapter number at body
 * size, then the chapter name one step up in size and weight, and a long blank
 * before the text begins. Titles that carry both parts ("第1章 1.听天监") are
 * split at the first space; anything else ("楔子") becomes a single line.
 *
 * The body is wrapped in `.reader__body` so a text selection can be mapped to
 * body-character offsets without the heading counting towards them. The heading
 * is also not part of `chapterChars` — the progress model counts body characters
 * only, which keeps the saved position stable across this cosmetic block.
 */
const renderedHtml = computed(() => {
  const body = chapterHtml.value.get(currentChapter.value) || ''
  const marked = applyHighlights(body, highlightRanges.value)
  const wrapped = `<div class="reader__body">${marked}</div>`
  const title = (chapterList.value[currentChapter.value]?.title || '').trim()
  if (!title) return wrapped
  const m = /^(第[0-9一二三四五六七八九十百千零两]+[章回节卷集部篇幕场])\s+(.+)$/.exec(title)
  const head = m
    ? `<div class="reader__ch"><p class="reader__ch-num">${escapeHtml(m[1])}</p>` +
      `<p class="reader__ch-name">${escapeHtml(m[2])}</p></div>`
    : `<div class="reader__ch"><p class="reader__ch-name">${escapeHtml(title)}</p></div>`
  return head + wrapped
})

/**
 * A transient range painted after jumping from 书内搜索, so the user sees where
 * the match landed instead of guessing a page. It lives outside `highlights`
 * because it is not a saved note and must not reach the database.
 */
const searchHit = ref<{ chapterIndex: number; start: number; end: number } | null>(null)
let searchHitTimer: ReturnType<typeof setTimeout> | null = null

/** Highlights belonging to the chapter currently on screen. */
const highlightRanges = computed(() => {
  const list: { start: number; end: number; color?: HighlightColor }[] = highlights.value
    .filter(h => h.chapterIndex === currentChapter.value)
    .map(h => ({ start: h.start, end: h.end, color: h.color }))
  const hit = searchHit.value
  if (hit && hit.chapterIndex === currentChapter.value && hit.end > hit.start) {
    list.push({ start: hit.start, end: hit.end })
  }
  return list
})

/**
 * CJK text justifies cleanly (fixed em widths); Latin text looks better ragged
 * right, so pick the alignment strategy from the chapter's own script mix.
 */
const isCjkChapter = computed(() => {
  const html = chapterHtml.value.get(currentChapter.value) || ''
  const sample = html.replace(/<[^>]+>/g, '').slice(0, 2000)
  if (!sample) return true
  let cjk = 0
  let latin = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0) || 0
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
    else if (code >= 0x3000 && code <= 0x303f) cjk++
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++
  }
  return cjk >= latin
})

/* ---------- progress ---------- */
/*
 * Page → character maps a page to its *start*, so the last page of the last
 * chapter would report 90–99% (and the book would never be marked 已读完).
 * Reaching that page is the end of the book, so report it as 100%.
 */
const atBookEnd = computed(() =>
  !loading.value &&
  chapterList.value.length > 0 &&
  currentChapter.value === chapterList.value.length - 1 &&
  currentPage.value >= totalPages.value - 1
)

const percentValue = computed(() =>
  atBookEnd.value
    ? 100
    : progressPercent(chapterChars.value, currentChapter.value, currentCharOffset.value)
)

const percentText = computed(() => `${Math.round(percentValue.value)}%`)

const remainText = computed(() => {
  if (!bookChars.value) return ''
  return remainTextOf(remainingMinutes(chapterChars.value, currentChapter.value, currentCharOffset.value))
})

/**
 * Reader brightness.
 *
 * There is no page-level brightness API in a WebView (and the native window
 * brightness needs a plugin), so the reader dims itself: a black veil whose
 * opacity grows as the slider goes down. `-1` still means "follow the system"
 * and paints nothing, so an untouched install looks exactly as before.
 */
const dimOpacity = computed(() => {
  const v = settings.value.brightness
  if (v < 0) return 0
  return Math.min(0.6, Math.max(0, (100 - v) / 100 * 0.6))
})

/* ---------- pagination ---------- */
let resizeObserver: ResizeObserver | null = null

// Available page box = viewport box minus page margins, in CSS px.
// `gap` is the inter-column gutter and must be included in the page stride.
const pageBox = ref({ w: 320, h: 600, gap: 44 })

function measureViewport() {
  const vp = viewportEl.value
  if (!vp) return
  const r = vp.getBoundingClientRect()
  const cs = getComputedStyle(vp)
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  const gap = settings.value.pageMargin * 2
  const w = Math.max(160, Math.round(r.width - padX))
  pageBox.value = {
    w,
    // Whole lines only — a fractional box slices the last line in half.
    h: snapPageHeight(Math.max(200, r.height - padY)),
    gap,
  }
}

const isScrollMode = computed(() => settings.value.turnPageType === 'vertical')

/**
 * Reading surface: the theme colour underneath, an optional paper texture on
 * top.
 *
 * Only the *opaque light* textures (纸张/沙丘/天空) repaint the page, and only
 * those force the dark body pair — laying light ink on them is unreadable. The
 * 网格 texture is a translucent line overlay that keeps the theme colour
 * showing through, so a dark theme must keep its light ink. (Getting this wrong
 * is what made night mode with the grid texture look like blank dark grey.)
 */
const readerSurface = computed(() => {
  const style: Record<string, string> = {}
  const bg = backgroundOf(settings.value.background)
  if (bg.css) style.backgroundImage = bg.css
  if (bg.light) {
    style['--text-body'] = '#2F2F2F'
    style['--text-secondary'] = '#8A8A8A'
  }
  return style
})

/**
 * Snap the page box height to a whole number of lines.
 *
 * CSS multicol clips at the box edge, so a box that is not an exact multiple of
 * the line height slices the last line in half. We also need the *painted*
 * height (a whole number of lines) for page-stride math.
 */
const lineHeightPx = computed(() => {
  const fs = settings.value.fontSize
  return fs * settings.value.lineHeight
})

function snapPageHeight(raw: number): number {
  const lh = lineHeightPx.value
  if (!lh || !isFinite(lh) || lh <= 0) return Math.max(200, Math.round(raw))
  const lines = Math.max(1, Math.floor(raw / lh))
  return Math.round(lines * lh)
}

/** Horizontal distance between two columns. */
const columnStride = computed(() => pageBox.value.w + pageBox.value.gap)

/** 抓一章在线正文并写回内存；并发请求由 sourceService 的 inflight 去重。 */
async function loadRemoteChapter(index: number): Promise<void> {
  const b = book.value
  if (!b) return
  fetchingChapter.value = true
  chapterError.value = ''
  try {
    const res = await ensureChapterText(b, index)
    if (res.html) chapterHtml.value.set(index, res.html)
  } catch (e) {
    if (index === currentChapter.value) {
      chapterError.value = (e as Error)?.message || '章节加载失败'
    }
  } finally {
    fetchingChapter.value = false
  }
}

async function retryChapter(): Promise<void> {
  chapterError.value = ''
  await renderChapter(currentCharOffset.value)
}

/**
 * Prefetch the next online chapter in the background.
 *
 * The biggest source-reading stall is the round trip when a page turn crosses
 * into an uncached chapter. Fetching one chapter ahead while the reader is
 * still on the current one makes that turn local; failures stay silent because
 * the normal on-demand fetch remains the fallback.
 */
const prefetching = new Set<number>()

function prefetchNextChapter(index: number): void {
  const b = book.value
  if (!b?.sourceId) return
  const next = index + 1
  if (next >= chapterList.value.length) return
  if (chapterHtml.value.has(next) || prefetching.has(next)) return
  prefetching.add(next)
  setTimeout(() => {
    void ensureChapterText(b, next)
      .then(res => {
        if (res.html && !chapterHtml.value.has(next)) chapterHtml.value.set(next, res.html)
      })
      .catch(() => undefined)
      .finally(() => prefetching.delete(next))
  }, 600)
}

/**
 * Re-layout the current chapter and land on the page holding `charOffset`.
 * Callers pass a character offset (font-size independent) rather than a page.
 */
async function renderChapter(charOffset = 0) {
  const index = currentChapter.value
  const ch = chapterList.value[index]
  if (!ch) return

  // 在线书：本章正文还没落库时先抓一次。抓完就是纯本地路径，零网络开销。
  if (book.value?.sourceId && !chapterHtml.value.get(index)) {
    await loadRemoteChapter(index)
  }
  // 抓取期间用户可能已经翻到别的章，旧的那次不要再排版。
  if (index !== currentChapter.value) return

  /*
   * A chapter with tens of thousands of characters makes CSS multicol block the
   * main thread. Paint the notice first (two frames), then let the layout run;
   * the flag clears on the next tick after it.
   */
  const heavy = (chapterChars.value[index] || 0) > 30000
  if (heavy) {
    paginating.value = true
    await nextTick()
    await new Promise(r => setTimeout(r, 16))
    setTimeout(() => { paginating.value = false }, 0)
  }

  await nextTick()
  measureViewport()
  await nextTick()
  const el = contentEl.value
  if (!el) return

  if (isScrollMode.value) {
    // Continuous flow: one screenful == one "page" for progress purposes.
    const h = pageBox.value.h
    const contentH = el.scrollHeight
    if (!h || !isFinite(h) || h <= 0 || !contentH || !isFinite(contentH)) {
      totalPages.value = 1
      goPage(0, false)
      return
    }
    totalPages.value = Math.max(1, Math.ceil(contentH / h))
    goPage(Math.min(charToPage(charOffset), totalPages.value - 1), false)
    prefetchNextChapter(index)
    return
  }

  // CSS multi-column flow: total pages = scrollWidth / column stride.
  // Guard against a zero/NaN box before the first layout pass completes.
  const stride = columnStride.value
  const scrollW = el.scrollWidth
  if (!stride || !isFinite(stride) || stride <= 0 || !scrollW || !isFinite(scrollW)) {
    totalPages.value = 1
    goPage(0, false)
    return
  }
  totalPages.value = Math.max(1, Math.round((scrollW + pageBox.value.gap) / stride))
  goPage(Math.min(charToPage(charOffset), totalPages.value - 1), false)
  prefetchNextChapter(index)
}

function goPage(page: number, animate = true) {
  const el = contentEl.value
  if (!el) return
  const max = totalPages.value - 1
  currentPage.value = Math.max(0, Math.min(max, page))
  if (isScrollMode.value) {
    // Continuous scroll: move the viewport instead of the text layer.
    el.style.transform = 'none'
    if (viewportEl.value) {
      viewportEl.value.scrollTo({
        top: currentPage.value * pageBox.value.h,
        behavior: animate ? 'smooth' : 'auto',
      })
    }
    return
  }
  // Columns are separated by the gutter, so page N starts N*stride, not N*width.
  el.style.transition = animate ? 'transform .22s cubic-bezier(.25,.1,.25,1)' : 'none'
  el.style.transform = `translateX(${-currentPage.value * columnStride.value}px)`
}

/* ---------- navigation ---------- */
function nextPage() {
  if (currentPage.value < totalPages.value - 1) {
    goPage(currentPage.value + 1)
  } else if (currentChapter.value < chapterList.value.length - 1) {
    currentChapter.value++
    renderChapter(0)
  }
}

function prevPage() {
  if (currentPage.value > 0) {
    goPage(currentPage.value - 1)
  } else if (currentChapter.value > 0) {
    currentChapter.value--
    renderChapter(Number.MAX_SAFE_INTEGER) // last page of the previous chapter
  }
}

function jumpToChapter(index: number) {
  currentChapter.value = Math.max(0, Math.min(chapterList.value.length - 1, index))
  showCatalog.value = false
  activePanel.value = 'none'
  renderChapter(0)
  saveProgress()
}

/* ---------- 书内搜索 ----------
 * State machine lives in `useBookSearch`; the view only decides when to open,
 * close and where the result jumps to.
 */
const {
  query: searchQuery,
  results: searchResults,
  running: searchRunning,
  searchable: searchableChapters,
  reset: resetBookSearch,
  dispose: disposeBookSearch,
} = useBookSearch(chapterList, chapterHtml)

function openBookSearch(): void {
  clearSelection()
  showSearch.value = true
  activePanel.value = 'none'
  showCatalog.value = false
}

function closeBookSearch(): void {
  showSearch.value = false
  resetBookSearch()
}

async function jumpToSearchHit(hit: BookSearchHit): Promise<void> {
  const word = searchQuery.value.trim()
  closeBookSearch()
  showMenu.value = false
  activePanel.value = 'none'
  currentChapter.value = hit.chapterIndex
  // Paint the match for a few seconds; the page itself is an approximation.
  searchHit.value = {
    chapterIndex: hit.chapterIndex,
    start: hit.domOffset,
    end: hit.domOffset + Math.max(1, word.length),
  }
  if (searchHitTimer) clearTimeout(searchHitTimer)
  searchHitTimer = setTimeout(() => { searchHit.value = null }, 6000)
  await nextTick()
  await renderChapter(hit.charOffset)
  saveProgress()
}

/* ---------- 听书 ----------
 * The session is app-wide (`src/audio/session.ts`): leaving the reader no
 * longer stops the voice — going back to 书架 keeps it talking and the floating
 * control in `App.vue` stays on screen until it is closed by hand.
 *
 * This view is therefore a *subscriber*, not the owner. It does two things:
 *  - paint the sentence being spoken, mapping the session's character offsets
 *    back into this chapter's DOM (see `rectsOfChars`);
 *  - follow the session's chapter, so auto-advance turns the page underneath.
 *
 * Offsets: the session counts **non-whitespace** characters (`toCharOffset`),
 * the same coordinate space as saved progress, so the paint and the saved
 * position always agree — and a chapter re-render cannot shift them.
 */
const listen = listenSession
const {
  status: listenStatus,
  index: listenIndex,
  reason: listenReason,
  bufferProgress: listenBuffer,
  sentences: listenSentences,
  charOffsets: listenCharOffsets,
  chapterIndex: listenChapterIndex,
  chapterTitle: listenChapterTitle,
  expanded: listenExpanded,
  timerLeft: listenTimerLeft,
  remainText: listenRemainText,
} = listen

/** True only when *this* book is the one being listened to. */
const listenActive = computed(() => listen.active.value && listen.bookId.value === bookId)

/** Rects to paint for the sentence being spoken. */
const sentenceRects = ref<{ x: number; y: number; w: number; h: number }[]>([])
/** Set while the session moves the chapter, so the reverse watcher stands down. */
let followingSession = false

/**
 * 锁屏 / 蓝牙耳机控制由 session 统一接管（`src/audio/session.ts`）：听书不再属于
 * 这个页面，元数据和按钮动作自然也不能随页面销毁。
 */
/** 把正在朗读的这句存成黄线「金句」，与手动画线共用一套存储。 */
async function favoriteSentence(): Promise<void> {
  const i = listenIndex.value
  const s = listenSentences.value[i]
  if (!s || !s.text.trim()) return
  const chapterIndex = listenChapterIndex.value
  // The reader must be showing the chapter the voice is in, otherwise there is
  // no DOM range to store.
  if (chapterIndex !== currentChapter.value) return
  const body = contentEl.value?.querySelector('.reader__body')
  const from = listenCharOffsets.value[i] ?? 0
  const raw = body ? rawRangeOfChars(body, from, from + spokenLength(s.text)) : null
  if (!raw) return
  const exists = highlights.value.some(h =>
    h.chapterIndex === chapterIndex && h.start === raw.start && h.end === raw.end
  )
  if (exists) return
  const row = await addHighlight({
    bookId,
    chapterIndex,
    start: raw.start,
    end: raw.end,
    text: s.text,
    note: '',
    color: 'yellow',
  })
  highlights.value = [...highlights.value, row]
}

/** How many non-whitespace characters a sentence covers when spoken. */
function spokenLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

/**
 * Map the non-whitespace character range `[from, to)` onto raw offsets in
 * `body.textContent`.
 *
 * The session's offsets are built from the chapter's stored text, which may not
 * have this DOM; only the *ordinal* of each non-whitespace character is shared.
 * Walking the body once is what makes the two coordinate systems meet, and it
 * keeps the mapping correct across `<mark>` nodes the highlight pass injects.
 */
function rawRangeOfChars(
  body: Element,
  from: number,
  to: number
): { start: number; end: number } | null {
  if (to <= from) return null
  const text = body.textContent || ''
  let seen = 0
  let start = -1
  let end = -1
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    if (start < 0 && seen === from) start = i
    seen++
    if (seen >= to) {
      end = i + 1
      break
    }
  }
  if (start < 0) return null
  // A chapter tail shorter than the sentence still deserves a highlight.
  if (end < 0) end = text.length
  return { start, end }
}

/** Rectangles covering the characters `[from, to)`; `clip` drops off-page ones. */
function rectsOfChars(
  from: number,
  to: number,
  clip = true
): { x: number; y: number; w: number; h: number }[] {
  const body = contentEl.value?.querySelector('.reader__body')
  if (!body) return []
  const raw = rawRangeOfChars(body, from, to)
  if (!raw) return []
  const range = rangeForOffsets(body, raw.start, raw.end)
  if (!range) return []
  const vp = viewportEl.value?.getBoundingClientRect()
  return [...range.getClientRects()]
    .map(r => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
    .filter(r => {
      if (r.w <= 0.5 || r.h <= 0.5) return false
      if (!clip || !vp) return true
      // Columns other than the visible one sit outside the viewport; painting
      // them would draw over the chrome.
      return r.x + r.w > vp.left && r.x < vp.right && r.y + r.h > vp.top && r.y < vp.bottom
    })
}

/**
 * Bring the sentence on screen.
 *
 * The start page comes from a character ratio, which is an estimate: it can be
 * a column off, and — after collapsing a listen page that has run for a while —
 * it can be a whole chapter's worth of columns off. So measure the unpainted
 * geometry, convert the distance into columns, and step once. Using the *unclipped*
 * rects is what makes this work: clipping first would report "nothing found"
 * exactly when the correction is needed.
 */
async function settlePage(from: number, to: number) {
  for (let step = 0; step < 3; step++) {
    const rects = rectsOfChars(from, to, false)
    if (!rects.length) return
    const vp = viewportEl.value?.getBoundingClientRect()
    if (!vp) return
    const visible = rects.some(r =>
      r.x + r.w > vp.left && r.x < vp.right && r.y + r.h > vp.top && r.y < vp.bottom
    )
    if (visible) return

    if (isScrollMode.value) {
      const h = pageBox.value.h || vp.height
      if (!h) return
      goPage(currentPage.value + Math.round((rects[0].y - vp.top) / h), false)
    } else {
      const stride = columnStride.value || vp.width
      if (!stride) return
      const delta = Math.floor((rects[0].x - vp.left) / stride)
      if (!delta) return
      goPage(currentPage.value + delta, false)
    }
    await nextTick()
  }
}

/** Turn the page to the sentence starting at `from` and paint it. */
async function focusOffset(from: number, to: number) {
  const targetPage = charToPage(from)
  if (targetPage !== currentPage.value) {
    goPage(targetPage, false)
  } else {
    // Same page still has to refresh the saved position.
    saveProgress()
  }

  if (!settings.value.listenFollow) {
    sentenceRects.value = []
    return
  }
  await nextTick()
  await settlePage(from, to)
  sentenceRects.value = rectsOfChars(from, to)
}

/** Paint whatever the session is speaking right now, if it is our book. */
async function paintSpoken() {
  if (!listenActive.value || !settings.value.listenFollow || listenExpanded.value) {
    sentenceRects.value = []
    return
  }
  const i = listenIndex.value
  const sentence = listenSentences.value[i]
  const from = listenCharOffsets.value[i]
  if (!sentence || from === undefined) {
    sentenceRects.value = []
    return
  }
  // The chapter on screen may still be the previous one while the session
  // advances; the chapter watcher re-paints once it has rendered.
  if (listenChapterIndex.value !== currentChapter.value) return
  await focusOffset(from, from + spokenLength(sentence.text))
}

/** 定时关闭归 session 管：离开阅读页它也得继续倒数。 */
function setListenTimer(minutes: number) {
  listen.setTimer(minutes)
}

async function startListening() {
  showMenu.value = false
  activePanel.value = 'none'
  clearSelection()
  if (!book.value) return
  // The session segments the chapter from storage, so the reader no longer has
  // to be the place where the sentence list is built.
  const ok = await listen.begin({
    book: book.value,
    chapterIndex: currentChapter.value,
    charOffset: currentCharOffset.value,
  })
  if (!ok) {
    // Nothing to speak: leave the toolbar as it was, or it stays hidden behind
    // a listen screen that never appears.
    showMenu.value = true
    window.alert('本章没有可朗读的文字')
    return
  }
  await nextTick()
  void paintSpoken()
}

async function closeListening() {
  sentenceRects.value = []
  // 退出听书后回到正文：收起听书页，并像 collapseListening 一样还原菜单，
  // 否则底部工具栏会一直缺席。
  showMenu.value = true
  await listen.stop()
}

async function setListenVoice(name: string) {
  await listen.setVoice(name)
}

async function toggleListenAutoNext() {
  await listen.toggleAutoNext()
}

function collapseListening() {
  listen.collapse()
  // 听书是从工具栏进入的，收起后把菜单还原，否则底部工具栏会一直缺席。
  showMenu.value = true
}

function openListenCatalog() {
  collapseListening()
  showCatalog.value = true
}

async function setListenRate(rate: number) {
  // Re-speak the current sentence so the new speed is audible immediately.
  await listen.setRate(rate)
}

async function toggleListenFollow() {
  await listen.toggleFollow()
  if (settings.value.listenFollow) void paintSpoken()
  else sentenceRects.value = []
}

/*
 * Chapter and voice move together while this book is being listened to:
 *  - the session advancing (auto-next) turns this page;
 *  - picking a chapter in the catalogue moves the voice instead of ending it.
 * `followingSession` tells the two directions apart.
 */
watch(listenChapterIndex, async idx => {
  if (!listenActive.value || idx === currentChapter.value) return
  followingSession = true
  currentChapter.value = idx
  await nextTick()
  await renderChapter(0)
  followingSession = false
  await paintSpoken()
})

watch(currentChapter, idx => {
  if (followingSession || !listenActive.value) return
  if (idx === listenChapterIndex.value) return
  void listen.jumpToChapter(idx, 0)
})

watch([listenIndex, listenStatus, listenExpanded, () => settings.value.listenFollow], () => {
  if (listenStatus.value === 'idle' || listenStatus.value === 'unavailable') {
    sentenceRects.value = []
    return
  }
  void paintSpoken()
})

/* ---------- gestures ----------
 * Web vs. native differ in a way that must not be papered over:
 *
 *  - **Web**: horizontal swipes are ours; the browser only reacts to
 *    `history`-level gestures (browser back button, trackpad swipe), which we
 *    deliberately do not intercept.
 *  - **Android**: the system back gesture owns the screen edge. A swipe that
 *    starts inside `EDGE_GESTURE_INSET` belongs to the OS, so the reader must
 *    ignore it — otherwise a page turn and a back gesture fire together.
 *
 * Both start on the *touch*, so a gesture that begins at the edge is dropped
 * before any page turn is committed.
 */
let touchStartX = 0
let touchStartY = 0
let touchMoved = false
/** Set when the touch began in the OS gesture zone and must be left alone. */
let touchRejected = false

/* ---- 跟手翻页 ----
 * The page follows the finger while dragging, and the release decides by
 * distance *or* speed (a short fast flick counts). Without this, page turns
 * were a click that teleported the text — the single biggest gap against every
 * mainstream reader.
 */
let dragging = false
let dragDx = 0
let dragStartedAt = 0

const EDGE = EDGE_GESTURE_INSET

function canGoNext(): boolean {
  return currentPage.value < totalPages.value - 1 ||
    currentChapter.value < chapterList.value.length - 1
}

function canGoPrev(): boolean {
  return currentPage.value > 0 || currentChapter.value > 0
}

/** Move the text layer with the finger; edges get resistance instead of a wall. */
function followDrag(dx: number) {
  const el = contentEl.value
  if (!el || isScrollMode.value) return
  let limited = dx
  if ((dx < 0 && !canGoNext()) || (dx > 0 && !canGoPrev())) limited = dx * 0.25
  el.style.transition = 'none'
  el.style.transform = `translateX(${-currentPage.value * columnStride.value + limited}px)`
  dragDx = limited
}

/**
 * Settle the drag. Returns true when a drag actually happened, so the trailing
 * click is swallowed instead of turning the page a second time.
 */
function finishDrag(): boolean {
  if (!dragging) return false
  dragging = false
  const dx = dragDx
  dragDx = 0
  const elapsed = Math.max(16, Date.now() - dragStartedAt)
  const speed = Math.abs(dx) / elapsed
  const threshold = Math.max(36, Math.min(120, window.innerWidth * 0.14))
  const turned = Math.abs(dx) > threshold || speed > 0.45
  if (turned && dx < 0 && canGoNext()) nextPage()
  else if (turned && dx > 0 && canGoPrev()) prevPage()
  else goPage(currentPage.value)
  return true
}

function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  touchStartX = t.clientX
  touchStartY = t.clientY
  touchMoved = false
  dragging = false
  dragDx = 0
  dragStartedAt = Date.now()
  lastTouchAt = Date.now()
  selectionStartedThisTouch = false
  // Only reject edge-origin touches where the OS actually claims the edge.
  touchRejected = isNativeShell() && t.clientX <= EDGE
  if (!touchRejected) onPressStart(t.clientX, t.clientY)
}

function onTouchMove(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  if (!touchRejected && !sel.value && !dragEnd && !isScrollMode.value) {
    const dx = t.clientX - touchStartX
    const dy = t.clientY - touchStartY
    if (!dragging && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      // A horizontal drag is a page turn, never a long-press selection.
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
      dragging = true
      touchMoved = true
    }
    if (dragging) {
      followDrag(dx)
      return
    }
  }
  onPressMove(t.clientX, t.clientY)
}

function onTouchEnd(e: TouchEvent) {
  lastTouchAt = Date.now()
  onPressEnd()
  if (touchRejected) {
    touchRejected = false
    return
  }
  /*
   * A long-press ends with a synthetic click on some WebViews. Without this,
   * `onTap` sees the fresh selection and immediately clears it, so the selection
   * bar flashes for one frame. Swallow exactly that click; the next deliberate
   * tap still dismisses the bar normally.
   */
  if (selectionStartedThisTouch) {
    selectionStartedThisTouch = false
    suppressClickOnce()
  }
  if (finishDrag()) {
    suppressClickOnce()
    return
  }
  const dx = e.changedTouches[0].clientX - touchStartX
  const dy = e.changedTouches[0].clientY - touchStartY
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
    touchMoved = true
    if (dx < 0) nextPage()
    else prevPage()
  }
}

/** A cancelled touch (incoming call, OS gesture) snaps the page back. */
function onTouchCancel() {
  touchRejected = false
  onPressEnd()
  if (dragging) {
    dragging = false
    dragDx = 0
    goPage(currentPage.value)
  }
}

function onTap(e: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  if (touchMoved) { touchMoved = false; return }
  // A tap while a selection is up should dismiss the bar, not turn the page.
  if (sel.value) {
    clearSelection()
    return
  }
  if (showMenu.value) {
    showMenu.value = false
    activePanel.value = 'none'
    return
  }
  const x = e.clientX
  const w = window.innerWidth
  if (x < w * 0.3) {
    prevPage()
  } else if (x > w * 0.7) {
    nextPage()
  } else {
    showMenu.value = true
  }
}

/* ---------- persistence ---------- */
let saveTimer: any = null
function saveProgress() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    if (!book.value) return
    const pct = Math.round(percentValue.value)
    const patch: Partial<Book> = {
      lastChapterIndex: currentChapter.value,
      lastCharOffset: currentCharOffset.value,
      lastReadAt: Date.now(),
      // Progress must never go backwards for the same read-through, but
      // "从头开始" resets it explicitly through the shelf menu.
      progress: Math.max(book.value.progress, pct),
      finished: pct >= 99
    }
    // 在线书：记住源站章节地址，目录变动后还能对回这一章。
    const remote = chapterUrls.value.get(currentChapter.value)
    if (remote) patch.lastRemoteUrl = remote
    await bookStore.updateBook(bookId, patch)
  }, 400)
}

watch([currentPage, currentChapter], saveProgress)

/* ---------- bookmarks ---------- */
/** A bookmark belongs to the page it was made on, not to the whole chapter. */
function isBookmarkOnCurrentPage(b: { chapterIndex: number; charOffset: number }): boolean {
  return b.chapterIndex === currentChapter.value &&
    charToPage(b.charOffset) === currentPage.value
}

const isBookmarked = computed(() => bookmarkStore.bookmarks.some(isBookmarkOnCurrentPage))

/*
 * The badge on 想法 counts written thoughts; 笔记 counts everything the notes
 * sheet lists (bookmarks + 划线/想法). They used to share the bookmark count,
 * which made a 想法 badge disappear the moment a bookmark was added.
 */
const ideaCount = computed(() => highlights.value.filter(h => (h.note || '').trim()).length)
const noteCount = computed(() => bookmarkStore.bookmarks.length + highlights.value.length)

function leaveReader() {
  showBookMenu.value = false
  showMenu.value = false
  router.replace({ name: 'shelf' })
}

/** Share the visible page as text via the Web Share API, falling back to copy. */
async function shareExcerpt() {
  const html = chapterHtml.value.get(currentChapter.value) || ''
  const plain = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  const excerpt = plain.slice(currentCharOffset.value, currentCharOffset.value + 200)
  const text = `${book.value?.title || ''} · ${currentChapterTitle.value}\n\n${excerpt}`
  try {
    if (navigator.share) {
      await navigator.share({ title: book.value?.title || '', text })
      return
    }
    await navigator.clipboard.writeText(text)
  } catch {
    /* user cancelled or clipboard blocked — nothing to do */
  }
}

/** Jump to an exact saved position (chapter + offset), not just the chapter head. */
async function jumpToBookmark(chapterIndex: number, charOffset: number) {
  currentChapter.value = Math.max(0, Math.min(chapterList.value.length - 1, chapterIndex))
  showCatalog.value = false
  activePanel.value = 'none'
  await nextTick()
  await renderChapter(charOffset || 0)
  saveProgress()
}

async function removeBookmark(id: string) {
  await bookmarkStore.removeBookmark(id)
}

async function toggleBookmark() {
  const existing = bookmarkStore.bookmarks.find(
    b => b.bookId === bookId && isBookmarkOnCurrentPage(b)
  )
  if (existing) {
    await bookmarkStore.removeBookmark(existing.id)
  } else {
    const html = chapterHtml.value.get(currentChapter.value) || ''
    // Excerpt starts at the visible page, not at the chapter head.
    const plain = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    const excerpt = plain.slice(currentCharOffset.value, currentCharOffset.value + 60).trim()
    await bookmarkStore.addBookmark({
      id: `${bookId}-${currentChapter.value}-${Date.now()}`,
      bookId,
      chapterIndex: currentChapter.value,
      charOffset: currentCharOffset.value,
      excerpt: excerpt || plain.slice(0, 60),
      createdAt: Date.now()
    })
  }
}

/* ---------- reading time ---------- */
const readingMs = ref(0)
let sessionStart = 0
let sessionTimer: any = null

function startSession() {
  sessionStart = Date.now()
  clearInterval(sessionTimer)
  // Flush every 30s so a hard kill loses at most half a minute.
  sessionTimer = setInterval(() => { flushSession() }, 30000)
}

async function flushSession() {
  if (!sessionStart) return
  const delta = Date.now() - sessionStart
  sessionStart = Date.now()
  if (delta < 1000) return
  readingMs.value = await addReadingTime(bookId, delta)
}

const readingTimeText = computed(() => formatDuration(readingMs.value))

/* ---------- auto page turn ----------
 * WeRead's 开启自动翻页 advances the page on a timer while the reader is in
 * the foreground. It only turns while the menu is closed (a panel open means
 * the reader is being configured, not read) and stops at the last page.
 */
const autoPaging = ref(false)
let autoTimer: ReturnType<typeof setInterval> | null = null
/** 自动翻页间隔可调；旧设置没有这个字段时按 20 秒。 */
const autoPageMs = computed(() => Math.max(3, Math.round(settings.value.autoPageSeconds || 20)) * 1000)

function toggleAutoPaging() {
  autoPaging.value = !autoPaging.value
  syncAutoTimer()
  // Turning it on should resume reading, not sit behind the panel.
  if (autoPaging.value) {
    activePanel.value = 'none'
    showMenu.value = false
  }
}

function syncAutoTimer() {
  if (autoTimer) {
    clearInterval(autoTimer)
    autoTimer = null
  }
  if (!autoPaging.value) return
  autoTimer = setInterval(() => {
    if (showMenu.value || showBookMenu.value || showCatalog.value) return
    if (activePanel.value !== 'none') return
    nextPage()
  }, autoPageMs.value)
}

// 改速度时如果正在自动翻页，立刻按新间隔重排定时器。
watch(autoPageMs, () => {
  if (autoPaging.value) syncAutoTimer()
})

/**
 * Register whatever overlay is open with the global back handler, so an Android
 * back press closes it instead of leaving the reader. Highest z-order wins:
 * book menu → catalogue → panel → menu.
 */
const activeOverlayId = ref('')
watch(
  () => {
    if (showBookMenu.value) return 'reader:book-menu'
    if (showSearch.value) return 'reader:search'
    if (showCatalog.value) return 'reader:catalog'
    if (activePanel.value !== 'none') return `reader:panel:${activePanel.value}`
    if (showMenu.value) return 'reader:menu'
    return ''
  },
  (id) => {
    if (activeOverlayId.value) closeOverlay(activeOverlayId.value)
    activeOverlayId.value = id
    if (!id) return
    openOverlay(id, () => {
      if (id === 'reader:book-menu') showBookMenu.value = false
      else if (id === 'reader:search') closeBookSearch()
      else if (id === 'reader:catalog') showCatalog.value = false
      else if (id.startsWith('reader:panel:')) activePanel.value = 'none'
      else showMenu.value = false
    })
  },
  { immediate: true }
)

/* ---------- lifecycle ---------- */
/**
 * The three reading switches are window-level behaviours, not page styling:
 * keep-awake, orientation and volume keys all belong to the native Activity.
 * Applied on entering the reader and restored on leaving, so they never leak
 * into the rest of the app.
 */
function syncNativeReaderMode() {
  applyReaderNativeMode({
    keepAwake: settings.value.noAutoLock,
    allowLandscape: settings.value.landscape,
    volumeKeys: settings.value.volumeKeyTurn,
  })
}

watch(
  () => [settings.value.noAutoLock, settings.value.landscape, settings.value.volumeKeyTurn].join('|'),
  syncNativeReaderMode,
)

onMounted(async () => {
  // The reader must be self-sufficient: a cold start (or a direct deep link)
  // has an empty book store, and relying on ShelfView to have populated it
  // silently loses the saved position.
  if (!bookStore.books.length) await bookStore.loadBooks()
  if (!book.value) {
    // Book was removed or the id is bogus — bounce back instead of showing blank.
    loading.value = false
    router.replace({ name: 'shelf' })
    return
  }

  // Books imported by an older parser carry markup the reader can't render
  // (leaked <head>/<title> from EPUB XHTML). Rebuild them from source bytes.
  // 在线书没有原始字节，也不经过本地解析器，跳过这次无用的尝试。
  if (!book.value.sourceId && needsRebuild(book.value)) {
    try {
      if (await rebuildBook(book.value)) await bookStore.loadBooks()
    } catch { /* no stored source: keep reading what we have */ }
  }

  await chapterStore.loadChapters(bookId)
  chapterList.value = chapterStore.chapters

  const all = await dbGetAll<any>('chapters')
  const map = new Map<number, string>()
  const urls = new Map<number, string>()
  for (const c of all) {
    if (c.bookId !== bookId) continue
    if (c.html) map.set(c.index, c.html)
    if (c.remoteUrl) urls.set(c.index, c.remoteUrl)
  }
  chapterHtml.value = map
  chapterUrls.value = urls

  /*
   * Opened from the floating 听书 control (`?listen=1`): land on the chapter the
   * voice is in, at the sentence it is speaking, and show the full-screen page.
   * The saved progress may already be a chapter behind during auto-advance.
   */
  const resumeListen = String(route.query.listen || '') === '1' && listen.bookId.value === bookId

  // Restore position: ?chapter= (from the catalog page) wins over saved progress.
  const queryChapter = Number(route.query.chapter)
  let restoreChar = 0
  if (resumeListen) {
    currentChapter.value = Math.min(
      listen.chapterIndex.value,
      Math.max(0, chapterList.value.length - 1)
    )
    restoreChar = listen.currentOffset.value
  } else if (Number.isInteger(queryChapter) && queryChapter >= 0 && queryChapter < chapterList.value.length) {
    currentChapter.value = queryChapter
  } else if (book.value && book.value.lastChapterIndex < chapterList.value.length) {
    // 在线书目录可能增删章节：index 会漂，优先按章节 URL 对回。
    const refs = chapterList.value.map(c => ({ remoteUrl: urls.get(c.index) }))
    currentChapter.value = restorePosition(book.value, refs)
    restoreChar = book.value.lastCharOffset || 0
  }
  await bookmarkStore.loadBookmarks(bookId)
  highlights.value = await loadHighlights(bookId)

  /*
   * `?listen=1` with no live session: start one from here.
   *
   * This used to bail out silently so that a reload — or a link opened on
   * another device — landed on the plain page with no explanation of why the
   * listen view did not open.
   */
  if (String(route.query.listen || '') === '1' && !resumeListen) {
    await startListening()
  }
  // Selection is long-press driven; nothing to listen for — the platform is
  // kept out of the business entirely (`user-select: none`).

  loading.value = false
  await nextTick()
  await renderChapter(restoreChar)

  if (viewportEl.value) {
    resizeObserver = new ResizeObserver(() => {
      // Relayout keeps the reader on the same characters, not the same page.
      renderChapter(currentCharOffset.value)
    })
    resizeObserver.observe(viewportEl.value)
  }

  window.addEventListener('keydown', onKeydown)
  document.addEventListener('visibilitychange', onVisibility)

  // Native volume keys arrive here; the shell only forwards them while the
  // setting is on, so no extra guard is needed.
  window.__readerVolumeTurn = (dir) => {
    if (dir === 'prev') prevPage()
    else nextPage()
  }
  syncNativeReaderMode()

  readingMs.value = await getReadingTime(bookId)
  startSession()

  if (resumeListen) {
    listen.expand()
    await nextTick()
    await paintSpoken()
  }
})

/**
 * Font size / line height / margin / page-mode changes alter pagination, so the
 * text must be re-paginated while holding the reader on the same character.
 */
watch(
  () => [
    settings.value.fontSize,
    settings.value.lineHeight,
    settings.value.pageMargin,
    settings.value.turnPageType,
  ].join('|'),
  async () => {
    if (loading.value) return
    const charOffset = currentCharOffset.value
    await nextTick()
    await renderChapter(charOffset)
  }
)

function onVisibility() {
  if (document.hidden) {
    flushSession()
    sessionStart = 0
  } else {
    startSession()
  }
}

onBeforeUnmount(() => {
  /*
   * 听书 is deliberately *not* stopped here: the session belongs to the app, so
   * going back to 书架 keeps the voice going and the floating control keeps
   * working. Only an explicit 暂停 / 关闭 or swiping the app out of recents
   * stops it.
   *
   * The full-screen listen page is collapsed though: leaving it means the user
   * wants the text next time this book is opened, not a control panel they
   * cannot get out of.
   */
  if (listenActive.value) listen.collapse()
  delete window.__readerVolumeTurn
  resetReaderNativeMode()
  disposeBookSearch()
  if (searchHitTimer) clearTimeout(searchHitTimer)
  if (activeOverlayId.value) closeOverlay(activeOverlayId.value)
  if (autoTimer) clearInterval(autoTimer)
  clearInterval(sessionTimer)
  flushSession()
  document.removeEventListener('visibilitychange', onVisibility)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeydown)
  saveProgress()
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextPage()
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prevPage()
  else if (e.key === 'Escape') {
    // Escape unwinds one level at a time, matching a native back press.
    if (activePanel.value !== 'none' || showCatalog.value) {
      showCatalog.value = false
      activePanel.value = 'none'
    } else if (showMenu.value) {
      showMenu.value = false
    } else {
      router.replace({ name: 'shelf' })
    }
  }
}

function setPanel(p: Exclude<ReaderPanel, 'none'>) {
  activePanel.value = activePanel.value === p ? 'none' : p
}
</script>

<template>
  <div
    class="reader"
    :data-theme="settings.theme"
    :style="readerSurface"
  >
    <!-- Reading viewport -->
    <div
      ref="viewportEl"
      class="reader__viewport"
      :class="{ 'reader__viewport--scroll': isScrollMode }"
      :style="{
        paddingLeft: settings.pageMargin + 'px',
        paddingRight: settings.pageMargin + 'px',
      }"
      @click="onTap"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchCancel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
    >
      <div v-if="loading" class="reader__loading">
        <LoadingDots />
        <span class="reader__loading-text">正在打开书籍</span>
      </div>
      <div
        v-else
        ref="contentEl"
        class="reader__pages"
        :class="{
          'reader__pages--indent': settings.firstLineIndent,
          'reader__pages--spacing': settings.paragraphSpacing,
          'reader__pages--scroll': isScrollMode,
          'reader__pages--cjk': isCjkChapter,
          'reader__pages--latin': !isCjkChapter,
        }"
        :style="isScrollMode
          ? {
              fontSize: settings.fontSize + 'px',
              lineHeight: settings.lineHeight,
              fontFamily: fontStackOf(settings.fontFamily),
            }
          : {
              width: pageBox.w + 'px',
              height: pageBox.h + 'px',
              fontSize: settings.fontSize + 'px',
              lineHeight: settings.lineHeight,
              fontFamily: fontStackOf(settings.fontFamily),
              columnWidth: pageBox.w + 'px',
              columnGap: pageBox.gap + 'px',
            }"
        v-html="renderedHtml"
      />
    </div>

    <!-- 阅读亮度：黑色薄幕，只压正文与页面底色，不挡菜单/弹窗（z-index 低于 chrome）。 -->
    <div
      v-if="dimOpacity > 0"
      class="reader__dim"
      :style="{ opacity: dimOpacity }"
      aria-hidden="true"
    />

    <div v-if="paginating" class="reader__fetch">
      <LoadingDots />
      <span>正在排版本章…</span>
    </div>

    <!-- 在线章节按需抓取的状态：只覆盖一小块，不遮挡已排版的内容。 -->
    <div v-if="fetchingChapter" class="reader__fetch">
      <LoadingDots />
      <span>正在加载本章…</span>
    </div>
    <button v-else-if="chapterError" class="reader__fetch reader__fetch--error" @click="retryChapter">
      <span>{{ chapterError }}</span>
      <span class="reader__fetch-retry">点击重试</span>
    </button>

    <!--
      Follow-along paint for the sentence being spoken. Same overlay approach as
      the text selection: measured rects, no DOM mutation, so pagination is
      untouched while the voice moves through the page.
    -->
    <!-- 全屏听书页会盖住正文，这一层高亮没必要画；收起后立刻恢复。 -->
    <template v-if="!listenExpanded">
      <div
        v-for="(r, i) in sentenceRects"
        :key="'s' + i"
        class="reader__spoken"
        :style="{ left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }"
      />
    </template>

    <!-- Listen entry: 和工具栏同进同退，避免悬在正文上遮挡阅读。 -->
    <button
      v-if="!listenActive && showMenu && !loading && activePanel === 'none' && !showCatalog && !showBookMenu"
      class="reader__listen-fab"
      aria-label="听书"
      @click.stop="startListening"
    >听</button>

    <!--
      Footer: WeRead leaves the left end blank and puts the position on the
      right. The chapter name used to sit here, but it now heads the chapter
      text itself — keeping both would double it.
    -->
    <div
      class="reader__status"
      :class="{ 'reader__status--hidden': showMenu || listenActive, 'reader__status--scroll': isScrollMode }"
    >
      <span class="reader__status-left"></span>
      <span class="reader__status-right">{{ percentText }}</span>
    </div>

    <!-- Menu -->
    <template v-if="showMenu">
      <ReaderTopBar
        :note-count="ideaCount"
        @back="router.back()"
        @notes="activePanel = 'notes'"
        @search="openBookSearch"
        @share="shareExcerpt"
        @more="showBookMenu = true"
      />
      <ReaderBottomBar
        v-if="!listenExpanded"
        :active="activePanel"
        :note-count="noteCount"
        @catalog="showCatalog = true"
        @panel="setPanel"
      />
      <FontPanel
        v-if="activePanel === 'font'"
        :auto-paging="autoPaging"
        @auto="toggleAutoPaging"
        @close="activePanel = 'none'"
      />
      <ThemePanel v-if="activePanel === 'theme'" @close="activePanel = 'none'" />
      <ProgressPanel
        v-if="activePanel === 'progress'"
        :percent="percentText"
        :remain="remainText"
        :reading-time-ms="readingMs"
        :current-chapter="currentChapter"
        :total-chapters="chapterList.length"
        :note-count="noteCount"
        :auto-paging="autoPaging"
        @jump="jumpToChapter"
        @auto="toggleAutoPaging"
        @close="activePanel = 'none'"
      />
      <NotesPanel
        v-if="activePanel === 'notes'"
        :bookmarks="bookmarkStore.bookmarks"
        :highlights="highlights"
        :chapters="chapterList"
        :is-bookmarked="isBookmarked"
        :percent-text="percentText"
        :reading-time-text="readingTimeText"
        :cover="book?.cover || null"
        :book-title="book?.title || ''"
        @jump="jumpToBookmark"
        @toggle="toggleBookmark"
        @remove="removeBookmark"
        @remove-highlight="deleteHighlight"
        @stats="activePanel = 'progress'"
        @close="activePanel = 'none'"
      />
    </template>

    <!-- 更多 menu: book-level actions that have nowhere else to live. -->
    <div v-if="showBookMenu" class="reader-mask" @click.self="showBookMenu = false">
      <div class="reader-sheet">
        <div class="reader-sheet__head">
          <span class="reader-sheet__title">{{ book?.title || '' }}</span>
          <span class="reader-sheet__meta">{{ book?.author || '未知作者' }}</span>
        </div>
        <button class="reader-sheet__item" @click="jumpToChapter(0); showBookMenu = false">回到开头</button>
        <button class="reader-sheet__item" @click="showCatalog = true; showBookMenu = false">查看目录</button>
        <button class="reader-sheet__item reader-sheet__item--danger" @click="leaveReader">移出阅读</button>
        <div class="reader-sheet__gap" />
        <button class="reader-sheet__item reader-sheet__item--cancel" @click="showBookMenu = false">取消</button>
      </div>
    </div>

    <CatalogDrawer
      v-if="showCatalog"
      :chapters="chapterList"
      :current="currentChapter"
      :page-of="chapterPage"
      @close="showCatalog = false"
      @jump="jumpToChapter"
      @bookmark="toggleBookmark(); showCatalog = false"
    />

    <BookSearchPanel
      v-if="showSearch"
      :query="searchQuery"
      :results="searchResults"
      :searching="searchRunning"
      :cached="searchableChapters.length"
      :total="chapterList.length"
      @update:query="searchQuery = $event"
      @jump="jumpToSearchHit"
      @close="closeBookSearch"
    />

    <!--
      Live selection: painted from the range's client rects rather than a DOM
      selection, so the platform never draws its own bar or handles over it.
    -->
    <template v-if="sel">
      <div
        v-for="(r, i) in sel.rects"
        :key="i"
        class="sel-hl"
        :style="{ left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }"
      />
      <div
        v-for="(h, i) in sel.handles"
        :key="'h' + i"
        class="sel-handle"
        :class="{ 'sel-handle--end': i === 1 }"
        :style="{ left: h.x + 'px', top: h.y + 'px' }"
      />
    </template>

    <!-- Listen UI stays up regardless of the menu: reaching for a control
         should not require a tap that also opens the chrome. -->
    <ListenView
      v-if="listenActive && listenExpanded"
      :status="listenStatus"
      :rate="settings.listenRate"
      :sentence="listenSentences[listenIndex]?.text || ''"
      :index="listenIndex"
      :total="listenSentences.length"
      :chapter-title="listenChapterTitle"
      :book-title="listen.bookTitle.value || book?.title || ''"
      :cover="listen.cover.value || book?.cover || null"
      :follow="settings.listenFollow"
      :auto-next="settings.listenAutoNext"
      :voice="settings.listenVoice"
      :remain-text="listenRemainText"
      :timer-left="listenTimerLeft"
      :reason="listenReason ? reasonText(listenReason) : undefined"
      :buffer-done="listenBuffer.done"
      :buffer-total="listenBuffer.total"
      :load-voices="listen.voices"
      @toggle="listen.toggle()"
      @prev="listen.prev()"
      @next="listen.next()"
      @seek="(i) => listen.seek(i)"
      @rate="setListenRate"
      @voice="setListenVoice"
      @follow="toggleListenFollow"
      @auto-next="toggleListenAutoNext"
      @timer="setListenTimer"
      @catalog="openListenCatalog"
      @favorite="favoriteSentence"
      @collapse="collapseListening"
      @close="closeListening"
    />

    <!-- Text-selection menu: 复制 / 分享 / 全选 / 划线 / 想法 / 网页搜索 -->
    <SelectionToolbar
      v-if="sel"
      :x="selPos.x"
      :y="selPos.y"
      :all-selected="allSelected"
      @copy="copySelection"
      @share="shareSelection"
      @select-all="selectWholeBody"
      @web-search="webSearchSelection"
      @highlight="onHighlight"
      @note="onNote"
      @close="clearSelection"
    />
  </div>
</template>

<style scoped>
.reader {
  position: relative;
  height: 100%;
  background: var(--bg);
  transition: background-color var(--page-duration) var(--page-easing),
              color var(--page-duration) var(--page-easing);
  overflow: hidden;
  /*
   * Text is selectable: long-press → 划线/想法 is core WeRead behaviour. The
   * chrome around it stays unselectable so a stray drag over the bars cannot
   * paint a selection over the UI.
   */
  user-select: none;
  -webkit-user-select: none;
}
.reader__pages {
  /*
   * Not selectable: the reader draws its own selection (boxes, handles, menu)
   * from the underlying character range. Letting the platform select instead
   * brings up its own bar — 复制 / 分享 / 全选 / 网页搜索 — which would sit
   * next to ours and offer none of 划线 / 想法.
   */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* Brightness veil: above the text, below every piece of chrome. */
.reader__dim {
  position: fixed;
  inset: 0;
  z-index: 3;
  background: #000;
  pointer-events: none;
  transition: opacity var(--dur-fast) linear;
}

/* Live selection paint + drag handles (viewport-space, so `position: fixed`). */
.sel-hl {
  position: fixed;
  z-index: 150;
  background: rgba(27, 136, 238, 0.28);
  pointer-events: none;
  border-radius: 2px;
}

/*
 * The sentence being read. A soft underline rather than a fill: it has to sit
 * under existing 划线 marks without hiding them, and it moves every few
 * seconds, so a heavy block would flash.
 */
.reader__spoken {
  position: fixed;
  /* 正文之上、所有 chrome 之下：不能盖住听书页、底部栏和弹窗。 */
  z-index: 4;
  pointer-events: none;
  border-radius: 2px;
  background: rgba(27, 136, 238, 0.16);
  box-shadow: inset 0 -2px 0 rgba(27, 136, 238, 0.6);
  transition: background-color 200ms ease-out;
}

/* Listen entry button, floating over the text like WeRead's. */
.reader__listen-fab {
  position: absolute;
  right: 14px;
  /* 只在工具栏显示时出现，所以要让开 52px 的底部栏。 */
  bottom: calc(80px + var(--safe-bottom));
  z-index: 40;
  width: 44px;
  height: 44px;
  border-radius: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(20px * var(--app-font-scale));
  font-weight: 500;
  color: #fff;
  background: rgba(28, 28, 32, 0.62);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
.reader__listen-fab:active {
  background: rgba(28, 28, 32, 0.78);
}
.sel-handle {
  position: fixed;
  z-index: 151;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: #34C759;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}
.sel-handle--end {
  margin-left: -6px;
}
.reader__viewport {
  height: 100%;
  /* Clears the status bar, and stays at least 44px so the first line never hugs
     the top edge when the bar is short or absent. */
  padding-top: max(44px, calc(var(--safe-top) + 22px));
  padding-bottom: 34px;
  overflow: hidden;
}
.reader__viewport--scroll {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.reader__pages--scroll {
  column-count: auto !important;
  column-width: auto !important;
  height: auto !important;
  transform: none !important;
}
.reader__pages {
  color: var(--text-body);
  column-fill: auto;
  column-count: 1;
  transition: transform .22s cubic-bezier(.25,.1,.25,1);
  will-change: transform;
  word-break: break-word;
  /* Justify is right for CJK (even glyph widths) but produces rivers of
     whitespace in English; the script class below switches per chapter. */
  text-align: start;
  hyphens: auto;
}
/* CJK: justify, and break anywhere (no inter-word spaces to rely on). */
.reader__pages--cjk {
  text-align: justify;
  word-break: break-all;
  hyphens: none;
}
/* Latin: ragged right reads far better than stretched word gaps. */
.reader__pages--latin {
  text-align: start;
  word-break: normal;
  hyphens: auto;
}
.reader__pages :deep(h1),
.reader__pages :deep(h2),
.reader__pages :deep(h3) {
  font-size: 1.35em;
  font-weight: 600;
  margin: 0 0 1.1em;
  line-height: 1.4;
}
.reader__pages :deep(p) {
  /*
   * No extra paragraph margin by default: WeRead separates paragraphs with the
   * 2em indent alone, so the line pitch runs continuously across the break.
   * Its 段间距 switch turns that margin back on; see `.reader__pages--spacing`.
   */
  margin: 0;
  text-indent: 0;
}
.reader__pages--spacing :deep(.reader__body p) {
  margin: 0 0 0.85em;
}
.reader__pages--indent :deep(p) {
  text-indent: 2em;
}
/* Chapter opener: never indented, never split across a column. */
.reader__pages :deep(.reader__ch) {
  break-inside: avoid;
  margin: 3em 0 5em;
}
.reader__pages :deep(.reader__ch p) {
  text-indent: 0;
}
.reader__pages :deep(.reader__ch-num) {
  font-size: 1em;
  font-weight: 400;
  line-height: 1.8;
  margin: 0 0 0.85em;
}
.reader__pages :deep(.reader__ch-name) {
  font-size: 1.22em;
  font-weight: 600;
  line-height: 1.45;
}
.reader__pages :deep(mark.reader__hl) {
  background: rgba(27, 136, 238, 0.22);
  color: inherit;
  border-radius: 2px;
}
/* 四色划线；blue 走上面的默认规则，其余各有自己的底色。 */
.reader__pages :deep(mark.reader__hl--yellow) { background: rgba(255, 193, 7, 0.38); }
.reader__pages :deep(mark.reader__hl--green) { background: rgba(52, 199, 89, 0.3); }
.reader__pages :deep(mark.reader__hl--pink) { background: rgba(255, 45, 85, 0.22); }
.reader__pages :deep(img) {
  max-width: 100%;
  /* A tall illustration taller than the page box can never fit a column and
     pushes everything after it onto the next column, leaving a half-empty page.
     Cap it against the viewport so a full-page figure always fits. */
  max-height: 62vh;
  height: auto;
  object-fit: contain;
  display: block;
  margin: 0.6em auto;
  break-inside: avoid;
}
/* Images are block-level; keep a caption glued to its figure. */
.reader__pages :deep(figure) {
  margin: 0.6em 0;
  break-inside: avoid;
}
.reader__pages :deep(figcaption) {
  font-size: 0.85em;
  color: var(--text-secondary);
  text-align: center;
  margin-top: 0.4em;
}
.reader__pages :deep(blockquote) {
  margin: 0.8em 1em;
  padding-left: 0.8em;
  border-left: 3px solid var(--divider);
  color: var(--text-secondary);
}
.reader__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  color: var(--text-secondary);
  font-size: calc(13px * var(--app-font-scale));
  animation: loadingIn 220ms var(--page-easing);
}

.reader__loading-text {
  letter-spacing: 0.2px;
}

/* 章节抓取提示：浮在正文上方，只有错误态可点（重试），不挡翻页。 */
.reader__fetch {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-radius: 12px;
  background: var(--bg-panel);
  box-shadow: 0 4px 18px var(--shadow);
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  pointer-events: none;
  z-index: 5;
}

.reader__fetch--error {
  pointer-events: auto;
  max-width: 78%;
  text-align: center;
  line-height: 1.6;
}

.reader__fetch-retry {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--accent);
}

@keyframes loadingIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
.reader__status {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  padding: 8px 22px calc(8px + var(--safe-bottom));
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  /*
   * No background of its own: the strip is part of the page, not chrome. It
   * used to paint `var(--bg)`, which matched a flat theme but not a textured
   * one — with 纸张/网格/沙丘 the last 34px of the page turned into a solid band
   * with a shadowed seam above it. Transparent means whatever the reader paints
   * (colour *and* texture) simply continues to the bottom edge.
   */
  background: transparent;
  pointer-events: none;
  opacity: 1;
  transition: opacity .2s;
}

/*
 * Scroll mode is the one case where text really does run under the strip, so a
 * fade is needed to keep the chapter name legible. It is masked from the top so
 * the page texture bleeds through instead of meeting a hard edge.
 */
.reader__status--scroll::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--surface-fade);
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 62%);
  mask-image: linear-gradient(to bottom, transparent, #000 62%);
}
.reader__status--hidden { opacity: 0; }
.reader-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.4);
  animation: maskIn 180ms ease-out;
}

@keyframes maskIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.reader-sheet {
  width: 100%;
  padding: 0 10px calc(10px + var(--safe-bottom));
  background: var(--bg-page);
  border-radius: 16px 16px 0 0;
  animation: sheetUp 240ms var(--page-easing);
}

@keyframes sheetUp {
  from { transform: translate3d(0, 100%, 0); }
  to { transform: translate3d(0, 0, 0); }
}

.reader-sheet__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 16px 16px;
  text-align: center;
}

.reader-sheet__title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-sheet__meta {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.reader-sheet__item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 52px;
  margin-bottom: 1px;
  font-size: calc(16px * var(--app-font-scale));
  color: var(--text);
  background: var(--bg-panel);
}

.reader-sheet__item:first-of-type { border-radius: 12px 12px 0 0; }
.reader-sheet__item:last-of-type { border-radius: 0 0 12px 12px; }
.reader-sheet__item--danger { color: #e64340; }
.reader-sheet__item--cancel { border-radius: 12px; font-weight: 500; margin-top: 8px; }
.reader-sheet__gap { height: 8px; }

.reader__status-left {
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  position: relative;
}

.reader__status-right {
  position: relative;
}
</style>
