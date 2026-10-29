/**
 * The app-wide 听书 session.
 *
 * 听书 used to live inside the reader page, which made "返回书架" a full stop:
 * unmounting the view tore down the player, the sentence list and the timer.
 * The requirement is the opposite of that — listening is a background activity
 * like any music app: it survives navigation, keeps a floating mini control on
 * every page, and only stops when the user pauses / closes it or swipes the app
 * out of recents.
 *
 * So the session is a module singleton: one book, one chapter, one sentence
 * list, one player. Views become *subscribers*:
 *  - `ReaderView` paints the follow-along highlight by mapping the session's
 *    character offsets into its own DOM (see `focusOffset`);
 *  - `App.vue` renders the floating mini control on every route.
 *
 * Two design notes that matter:
 *
 *  - **The session never reads the DOM.** Chapter text comes from the database
 *    (`ensureChapterText` fetches online chapters the same way the reader does)
 *    and is segmented with `segmentText`, so auto-advance keeps working while
 *    no reader is mounted.
 *  - **Position is a character offset, not a sentence index.** Sentences are
 *    derived per render; the offset is what survives a chapter reload, a font
 *    change or a gap in the sentence boundaries.
 */
import { computed, ref, watch } from 'vue'
import { useListenPlayer } from './player'
import { segmentText, toCharOffset, type Sentence } from './segmenter'
import { chapterPlainText } from '@/utils/chapter-text'
import { nowPlayingStart, nowPlayingStop, nowPlayingUpdate, onNowPlayingAction } from './now-playing'
import { dbGetAllByIndex } from '@/utils/db'
import { ensureChapterText } from '@/utils/source/sourceService'
import { useBookStore, useSettingsStore } from '@/stores'
import { countChars, progressPercent } from '@/utils/progress'
import type { Book } from '@/types'

interface ChapterMeta {
  index: number
  title: string
  chars: number
  html?: string
}

export interface BeginOptions {
  book: Book
  chapterIndex: number
  /** Where in the chapter to start (non-whitespace character offset). */
  charOffset: number
}

/** Persist no more than twice a second while the voice walks a chapter. */
const PERSIST_DELAY = 500

function createListenSession() {
  /* ---------- what is being listened to ---------- */
  const bookId = ref('')
  const bookTitle = ref('')
  const bookAuthor = ref('')
  const cover = ref<string | null>(null)
  const chapterIndex = ref(0)
  const chapterTitle = ref('')
  const sentences = ref<Sentence[]>([])
  /** Non-whitespace offset of each sentence inside the chapter text. */
  const charOffsets = ref<number[]>([])
  /** Full-screen listen UI open (owned here so every route agrees). */
  const expanded = ref(false)
  /** 定时关闭剩余秒数；0 表示没开。 */
  const timerLeft = ref(0)

  let currentBook: Book | undefined
  let metas: ChapterMeta[] = []
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let timerId: ReturnType<typeof setInterval> | null = null
  let disposeActions: (() => void) | null = null

  const settingsStore = () => useSettingsStore()
  const settings = () => settingsStore().settings

  const player = useListenPlayer({
    sentences: () => sentences.value,
    settings: () => ({
      rate: settings().listenRate,
      voice: settings().listenVoice,
      autoNextChapter: settings().listenAutoNext,
    }),
    onSentence: () => {
      schedulePersist()
    },
    onChapterEnd: () => advanceChapter(),
  })

  const {
    status,
    index,
    reason,
    bufferProgress,
    active,
  } = player

  /* ---------- derived view state ---------- */
  /** Character offset of the sentence being spoken (0 when idle). */
  const currentOffset = computed(() => charOffsets.value[index.value] ?? 0)
  const currentSentence = computed(() => sentences.value[index.value]?.text || '')
  const listening = computed(() => !!bookId.value && active.value)

  /** Same estimate the full-screen page shows: ~4.2 汉字/秒 at 1x. */
  const remainText = computed(() => {
    const list = sentences.value
    if (!list.length) return ''
    let chars = 0
    for (let i = index.value; i < list.length; i++) chars += list[i].text.length
    const seconds = chars / (4.2 * Math.max(0.5, settings().listenRate || 1))
    if (seconds < 60) return '约 1 分钟内'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `约 ${minutes} 分钟`
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `约 ${h} 小时 ${m} 分钟` : `约 ${h} 小时`
  })

  /* ---------- chapter text ---------- */
  async function loadMetas(book: Book): Promise<void> {
    let rows: any[] = []
    try {
      /*
       * Per-book index, not the whole store: reading every chapter of every
       * book on the shelf is megabytes of HTML through the storage bridge, and
       * that alone delayed the first spoken word on a big library.
       */
      rows = await dbGetAllByIndex<any>('chapters', 'bookId', book.id)
    } catch {
      rows = []
    }
    metas = rows
      .filter(r => r.bookId === book.id)
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map(r => ({
        index: Number(r.index),
        title: String(r.title || ''),
        // `text` counts too: local imports can store plain text instead of HTML.
        chars: r.html ? countChars(r.html) : r.text ? countChars(r.text) : Number(r.wordCount) || 0,
        html: r.html || undefined,
      }))
  }

  /**
   * Speakable text of one chapter, fetching it for online books when the cache
   * is cold. Returns null when the chapter genuinely is not available — the
   * player then stops rather than speaking an empty chapter.
   */
  async function chapterText(at: number): Promise<{ title: string; text: string } | null> {
    const meta = metas.find(m => m.index === at)
    if (!meta) return null

    let html = meta.html
    let title = meta.title
    if (!html && currentBook) {
      try {
        const res = await ensureChapterText(currentBook, at)
        html = res.html
        title = res.title || title
        meta.html = res.html
        meta.chars = countChars(res.html)
      } catch {
        return null
      }
    }
    const text = chapterPlainText(html || '')
    return { title, text }
  }

  /** Replace the sentence list with one chapter's. Returns false when empty. */
  async function loadSentences(at: number): Promise<boolean> {
    const loaded = await chapterText(at)
    if (!loaded) return false
    chapterIndex.value = at
    chapterTitle.value = loaded.title
    sentences.value = segmentText(loaded.text)
    charOffsets.value = sentences.value.map(s => toCharOffset(loaded.text, s.start))
    return sentences.value.length > 0
  }

  /** Sentence index holding `offset` — the one *containing* it, not the next. */
  function indexAt(offset: number): number {
    const list = charOffsets.value
    let at = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i] <= offset) at = i
      else break
    }
    return at
  }

  /* ---------- persistence ---------- */
  /**
   * Write the listened position as reading progress. Same fields the reader
   * writes, so 书架 / 继续阅读 picks up wherever the voice got to.
   */
  async function persistNow(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    const id = bookId.value
    if (!id || !currentBook) return
    const chars = metas.map(m => m.chars)
    const offset = currentOffset.value
    const pct = Math.round(progressPercent(chars, chapterIndex.value, offset))
    try {
      await useBookStore().updateBook(id, {
        lastChapterIndex: chapterIndex.value,
        lastCharOffset: offset,
        lastReadAt: Date.now(),
        progress: Math.max(currentBook.progress, pct),
        finished: pct >= 99,
      })
    } catch {
      // A failed write must not interrupt playback.
    }
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => { void persistNow() }, PERSIST_DELAY)
  }

  /* ---------- OS "now playing" ---------- */
  function nowPlaying() {
    return {
      title: bookTitle.value || '听书',
      text: chapterTitle.value || '',
      playing: status.value === 'playing' || status.value === 'buffering',
    }
  }

  function syncNowPlaying(): void {
    if (!bookId.value) return
    void nowPlayingUpdate(nowPlaying())
  }

  function ensureActions(): void {
    if (disposeActions) return
    void (async () => {
      const offToggle = await onNowPlayingAction('onToggle', () => { void toggle() })
      const offStop = await onNowPlayingAction('onStop', () => { void stop() })
      disposeActions = () => { offToggle(); offStop() }
    })()
  }

  /** Lock-screen / headset metadata. Best-effort: WebView may not expose it. */
  function syncMediaSession(): void {
    if (typeof navigator === 'undefined') return
    const nav = navigator as Navigator & { mediaSession?: any }
    const ms = nav.mediaSession
    if (!ms) return
    try {
      if (!listening.value) {
        ms.metadata = null
        ms.playbackState = 'none'
        for (const name of ['play', 'pause', 'previoustrack', 'nexttrack']) {
          try { ms.setActionHandler(name, null) } catch { /* unsupported */ }
        }
        return
      }
      const Meta = (window as unknown as { MediaMetadata?: any }).MediaMetadata
      if (Meta) {
        ms.metadata = new Meta({
          title: chapterTitle.value || bookTitle.value,
          artist: bookAuthor.value,
          album: bookTitle.value,
          artwork: cover.value ? [{ src: cover.value, sizes: '512x512' }] : [],
        })
      }
      ms.playbackState =
        status.value === 'playing' ? 'playing'
          : status.value === 'paused' ? 'paused'
            : 'none'
    } catch {
      // MediaSession is optional.
    }
  }

  /* ---------- lifecycle ---------- */
  async function begin(opts: BeginOptions): Promise<boolean> {
    const book = opts.book
    // Switching books is a new session: stop the old one first so its progress
    // is flushed against its own book record.
    if (bookId.value && bookId.value !== book.id) await stop()

    /*
     * Boot the speech engine now, not when the first sentence is due: its cold
     * start (voice data, audio pipeline) then overlaps with reading the chapter
     * out of the database instead of being heard as a second of dead air.
     */
    player.prewarm()

    currentBook = book
    bookId.value = book.id
    bookTitle.value = book.title
    bookAuthor.value = book.author || ''
    cover.value = book.cover || null
    await loadMetas(book)

    const loaded = await chapterText(opts.chapterIndex)
    if (!loaded || !loaded.text.trim()) return false
    chapterIndex.value = opts.chapterIndex
    chapterTitle.value = loaded.title
    sentences.value = segmentText(loaded.text)
    charOffsets.value = sentences.value.map(s => toCharOffset(loaded.text, s.start))
    if (!sentences.value.length) return false

    expanded.value = true
    ensureActions()
    void nowPlayingStart(nowPlaying())
    // Not awaited: `play` settles when the chapter ends.
    void player.playFromOffset(opts.charOffset, charOffsets.value)
    return true
  }

  /** Move to another chapter of the same book, keeping the play state. */
  async function jumpToChapter(at: number, charOffset = 0): Promise<void> {
    if (!bookId.value) return
    const wasActive = status.value === 'playing' || status.value === 'buffering'
    const ok = await loadSentences(at)
    if (!ok) return
    if (wasActive) {
      void player.playFromOffset(charOffset, charOffsets.value)
    } else {
      index.value = indexAt(charOffset)
    }
    syncNowPlaying()
  }

  /** Auto-advance hook for the player; false ends the session's chapter run. */
  async function advanceChapter(): Promise<boolean> {
    if (!bookId.value) return false
    const next = chapterIndex.value + 1
    if (!metas.some(m => m.index === next)) return false
    const ok = await loadSentences(next)
    if (!ok) return false
    syncNowPlaying()
    schedulePersist()
    return true
  }

  async function pause(): Promise<void> {
    await player.pause()
    syncNowPlaying()
    syncMediaSession()
  }

  async function toggle(): Promise<void> {
    if (!bookId.value) return
    // A second tap after `unavailable` retries — the player clears its engine.
    await player.toggle()
    if (status.value !== 'idle') ensureActions()
    syncNowPlaying()
    syncMediaSession()
  }

  async function play(): Promise<void> {
    if (!bookId.value) return
    await player.play()
    syncNowPlaying()
  }

  async function next(): Promise<void> {
    await player.next()
    syncNowPlaying()
  }

  async function prev(): Promise<void> {
    await player.prev()
    syncNowPlaying()
  }

  async function seek(at: number): Promise<void> {
    await player.seek(at)
    syncNowPlaying()
  }

  async function restartCurrent(): Promise<void> {
    await player.restartCurrent()
  }

  async function voices() {
    return player.voices()
  }

  /** Close the session: engine silent, notification gone, mini bar gone. */
  async function stop(): Promise<void> {
    await persistNow()
    await player.stop()
    clearTimer()
    disposeActions?.()
    disposeActions = null
    void nowPlayingStop()
    expanded.value = false
    bookId.value = ''
    bookTitle.value = ''
    bookAuthor.value = ''
    cover.value = null
    chapterIndex.value = 0
    chapterTitle.value = ''
    sentences.value = []
    charOffsets.value = []
    metas = []
    currentBook = undefined
    syncMediaSession()
  }

  function expand(): void {
    if (bookId.value) expanded.value = true
  }

  function collapse(): void {
    expanded.value = false
  }

  /* ---------- settings the full-screen page edits ---------- */
  async function setRate(rate: number): Promise<void> {
    await settingsStore().update({ listenRate: rate })
    // Heard now, not from the next sentence.
    void player.restartCurrent()
  }

  async function setVoice(name: string): Promise<void> {
    await settingsStore().update({ listenVoice: name })
    void player.restartCurrent()
  }

  async function toggleAutoNext(): Promise<void> {
    await settingsStore().update({ listenAutoNext: !settings().listenAutoNext })
  }

  async function toggleFollow(): Promise<void> {
    await settingsStore().update({ listenFollow: !settings().listenFollow })
  }

  /* ---------- 定时关闭 ---------- */
  function clearTimer(): void {
    if (timerId) {
      clearInterval(timerId)
      timerId = null
    }
    timerLeft.value = 0
  }

  function setTimer(minutes: number): void {
    clearTimer()
    if (!minutes) return
    const end = Date.now() + minutes * 60000
    timerLeft.value = minutes * 60
    timerId = setInterval(() => {
      timerLeft.value = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      if (timerLeft.value <= 0) {
        clearTimer()
        void pause()
      }
    }, 1000)
  }

  watch([status, index], () => {
    /*
     * A session that cannot speak has no business holding a foreground service
     * or a 听书中 notification: the full-screen page explains why instead.
     */
    if (status.value === 'unavailable') {
      void nowPlayingStop()
    } else {
      syncNowPlaying()
    }
    syncMediaSession()
  })

  return {
    /* state */
    bookId,
    bookTitle,
    bookAuthor,
    cover,
    chapterIndex,
    chapterTitle,
    sentences,
    charOffsets,
    expanded,
    timerLeft,
    status,
    index,
    reason,
    bufferProgress,
    active,
    listening,
    currentOffset,
    currentSentence,
    remainText,
    /* actions */
    begin,
    jumpToChapter,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    restartCurrent,
    voices,
    stop,
    expand,
    collapse,
    setRate,
    setVoice,
    toggleAutoNext,
    toggleFollow,
    setTimer,
    clearTimer,
  }
}

/** One session for the whole app; views import this, never `create…`. */
export const listenSession = createListenSession()
export type ListenSession = ReturnType<typeof createListenSession>
