import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Book, ReaderSettings, Chapter, Bookmark, AppSettings } from '@/types'
import { fontStackOf } from '@/utils/fonts'
import { systemFontScale } from '@/utils/native'
import { dbGetAll, dbPut, dbDelete, dbGet, dbDeleteByIndex } from '@/utils/db'

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
    await dbDelete('sessions', id)
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
    firstLineIndent: true,
    // WeRead defaults this off: paragraphs separate by the 2em indent alone.
    paragraphSpacing: false,
    brightness: -1,
    showStatusBar: false,
    volumeKeyTurn: false,
    landscape: false,
    noAutoLock: false,
  })

  async function loadSettings() {
    const saved = await dbGet<ReaderSettings>('settings', 'reader')
    if (saved) Object.assign(settings.value, saved)
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
    followSystemTheme: true,
  })

  const loaded = ref(false)

  async function load() {
    const saved = await dbGet<AppSettings & { key: string }>('settings', 'app')
    if (saved) {
      // Spread only known keys so an older record cannot inject stale fields.
      if (typeof saved.fontScale === 'number') app.value.fontScale = saved.fontScale
      if (typeof saved.fontFamily === 'string') app.value.fontFamily = saved.fontFamily
      if (typeof saved.followSystemTheme === 'boolean') app.value.followSystemTheme = saved.followSystemTheme
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
    const all = await dbGetAll<any>('chapters')
    chapters.value = all
      .filter((c: any) => c.bookId === bookId)
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
