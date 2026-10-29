import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Book, ReaderSettings, Chapter, Bookmark, AppSettings } from '@/types'
import { fontStackOf } from '@/utils/fonts'
import { systemFontScale } from '@/utils/native'
import { dbGetAll, dbGetAllByIndex, dbPut, dbDelete, dbGet, dbDeleteByIndex } from '@/utils/db'

export const useBookStore = defineStore('book', () => {
  const books = ref<Book[]>([])
  const loading = ref(false)

  const sortedBooks = computed(() => {
    return [...books.value].sort((a, b) => b.lastReadAt - a.lastReadAt || b.importedAt - a.importedAt)
  })

  async function loadBooks() {
    loading.value = true
    try {
      books.value = await dbGetAll<Book>('books')
    } finally {
      loading.value = false
    }
  }

  async function addBook(book: Book) {
    await dbPut('books', book)
    books.value.push(book)
  }

  async function updateBook(id: string, patch: Partial<Book>) {
    const book = books.value.find(b => b.id === id)
    if (!book) return
    Object.assign(book, patch)
    await dbPut('books', book)
  }

  async function removeBook(id: string) {
    await dbDelete('books', id)
    await dbDeleteByIndex('chapters', 'bookId', id)
    await dbDeleteByIndex('bookmarks', 'bookId', id)
    // 划线/想法与原始字节没有级联关系：不在这里删，它们会永远留在库里，
    // 既占配额，也会让「笔记」统计出现无主记录。
    await dbDeleteByIndex('highlights', 'bookId', id)
    await dbDelete('sessions', id)
    await dbDelete('files', id)
    books.value = books.value.filter(b => b.id !== id)
  }

  function getBook(id: string): Book | undefined {
    return books.value.find(b => b.id === id)
  }

  return { books, sortedBooks, loading, loadBooks, addBook, updateBook, removeBook, getBook }
})

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<ReaderSettings>({
    fontSize: 19,
    lineHeight: 1.8,
    pageMargin: 22,
    theme: 'white',
    background: 'plain',
    fontFamily: 'system',
    turnPageType: 'horizontal',
    autoPageSeconds: 20,
    firstLineIndent: true,
    // WeRead defaults this off: paragraphs separate by the 2em indent alone.
    paragraphSpacing: false,
    brightness: -1,
    showStatusBar: false,
    volumeKeyTurn: false,
    landscape: false,
    noAutoLock: false,
    listenRate: 1,
    listenVoice: '',
    listenAutoNext: true,
    listenFollow: true,
  })

  async function loadSettings() {
    const saved = await dbGet<ReaderSettings>('settings', 'reader')
    if (saved) {
      Object.assign(settings.value, saved)
      // 旧版本存过未实现的两种翻页方式；它们从来没有对应动画，读回时归一到
      // 真正可用的左右滑动，避免设置页显示一个不存在的选项。
      if (settings.value.turnPageType === 'simulation' || settings.value.turnPageType === 'cover') {
        settings.value.turnPageType = 'horizontal'
      }
    }
  }

  async function update(patch: Partial<ReaderSettings>) {
    Object.assign(settings.value, patch)
    await dbPut('settings', { key: 'reader', ...settings.value })
  }

  return { settings, loadSettings, update }
})

export const useAppSettingsStore = defineStore('appSettings', () => {
  const app = ref<AppSettings>({
    fontScale: 1,
    fontFamily: 'system',
    theme: 'system',
    // 书架是主功能，默认占底栏；和影视一样可以收起来（只隐藏入口，书还在）。
    showShelfTab: true,
    // 影视是可选模块：默认不占底栏，用户在系统设置里主动开启后才出现。
    showTvTab: false,
  })

  const loaded = ref(false)

  async function load() {
    const saved = await dbGet<AppSettings & { key: string }>('settings', 'app')
    if (saved) {
      // Spread only known keys so an older record cannot inject stale fields.
      if (typeof saved.fontScale === 'number') app.value.fontScale = saved.fontScale
      if (typeof saved.fontFamily === 'string') app.value.fontFamily = saved.fontFamily
      if (saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'system') {
        app.value.theme = saved.theme
      } else if ((saved as { followSystemTheme?: boolean }).followSystemTheme === false) {
        // 旧记录只有布尔开关：关掉跟随系统时相当于固定浅色。
        app.value.theme = 'light'
      }
      // 老记录没有这两个键：书架保持默认开启，影视保持默认关闭。
      if (typeof saved.showShelfTab === 'boolean') app.value.showShelfTab = saved.showShelfTab
      if (typeof saved.showTvTab === 'boolean') app.value.showTvTab = saved.showTvTab
    }
    loaded.value = true
    apply()
  }

  /** Push the scale + family onto the document root so CSS can use them. */
  function apply() {
    // Guarded: the store is also constructed in tests and any non-DOM context.
    if (typeof document === 'undefined') return
    const root = document.documentElement
    /*
     * Two multipliers, one variable.
     *
     * `app.fontScale` is this app's own 字体大小 slider; `systemFontScale()` is
     * the Android font-size setting. Native apps scale their sp values by the
     * system setting and WebViews do not, so a page that ignores it always
     * reads one size smaller than the app it imitates on the same phone.
     * The product is capped so a 140% slider on a 130% system setting still
     * fits a 400dp screen.
     */
    const scale = Math.min(1.5, Math.round(app.value.fontScale * systemFontScale() * 100) / 100)
    root.style.setProperty('--app-font-scale', String(scale))
    root.style.setProperty('--app-font-family', fontStackOf(app.value.fontFamily))
  }

  async function update(patch: Partial<AppSettings>) {
    Object.assign(app.value, patch)
    apply()
    await dbPut('settings', { key: 'app', ...app.value })
  }

  return { app, loaded, load, update, apply }
})

export const useChapterStore = defineStore('chapter', () => {
  const chapters = ref<Chapter[]>([])

  async function loadChapters(bookId: string) {
    /*
     * Indexed read, not the whole store: `chapters` holds every chapter body of
     * every book, so selecting the table meant pushing megabytes of HTML across
     * the storage bridge just to throw most of it away. It delayed opening a
     * book — and therefore opening 听书 from the mini control.
     */
    const rows = await dbGetAllByIndex<any>('chapters', 'bookId', bookId)
    chapters.value = rows
      .map((c: any) => ({ ...c, bookId: undefined }))
      .sort((a: Chapter, b: Chapter) => a.index - b.index)
  }

  async function saveChapters(bookId: string, list: Chapter[]) {
    for (const ch of list) {
      await dbPut('chapters', { ...ch, bookId })
    }
    chapters.value = list
  }

  function clear() {
    chapters.value = []
  }

  return { chapters, loadChapters, saveChapters, clear }
})

export const useBookmarkStore = defineStore('bookmark', () => {
  const bookmarks = ref<Bookmark[]>([])

  async function loadBookmarks(bookId: string) {
    const all = await dbGetAll<Bookmark>('bookmarks')
    bookmarks.value = all.filter(b => b.bookId === bookId).sort((a, b) => b.createdAt - a.createdAt)
  }

  async function addBookmark(bm: Bookmark) {
    await dbPut('bookmarks', bm)
    bookmarks.value.unshift(bm)
  }

  async function removeBookmark(id: string) {
    await dbDelete('bookmarks', id)
    bookmarks.value = bookmarks.value.filter(b => b.id !== id)
  }

  async function loadAll() {
    bookmarks.value = await dbGetAll<Bookmark>('bookmarks')
  }

  return { bookmarks, loadBookmarks, addBookmark, removeBookmark, loadAll }
})
