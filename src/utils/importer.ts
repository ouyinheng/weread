/**
 * Local book import — the whole flow, with no screen attached.
 *
 * Import used to be a page: tap 导入 → sheet → page → 选择文件. Two of those
 * three steps existed only to host a button, which is why the picker now opens
 * straight from the tap (the file dialog is allowed to open only inside a user
 * gesture, so hopping through a route would have broken that anyway).
 *
 * The parse/store half lives here so every entry point (shelf, 发现, 我,
 * 设置) runs the same code, and the progress the user watches while a large
 * EPUB is parsed is reported through `importState`, which one overlay renders.
 */
import { reactive } from 'vue'
import { parseTxt, parseEpub, PARSER_VERSION } from './parser'
import { dbPutMany } from './db'
import { saveSourceFile } from './library'
import { useBookStore } from '@/stores'

/** Extensions the parser actually handles. Anything else is refused up front. */
export const IMPORT_ACCEPT = '.txt,.epub,.md'
export const IMPORT_HINT = '支持 txt / epub / md'

export interface ImportState {
  busy: boolean
  /** File being parsed right now. */
  name: string
  index: number
  total: number
  /** Failure message, cleared on the next attempt. */
  error: string
  /** Short completion notice ("已导入 3 本"), auto-cleared. */
  notice: string
}

export const importState = reactive<ImportState>({
  busy: false,
  name: '',
  index: 0,
  total: 0,
  error: '',
  notice: '',
})

let noticeTimer: ReturnType<typeof setTimeout> | null = null

export function dismissImportError(): void {
  importState.error = ''
}

function notify(text: string): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  importState.notice = text
  noticeTimer = setTimeout(() => { importState.notice = '' }, 2600)
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

export function isImportable(name: string): boolean {
  return ['txt', 'epub', 'md'].includes(extOf(name))
}

/**
 * One-tap import: picker → parse → shelf, for entry points that stay put.
 *
 * `onDone` receives the ids that were imported (empty if the user cancelled or
 * every file failed), so a caller can jump into a single new book without
 * duplicating the bookkeeping.
 */
export function pickAndImport(onDone?: (ids: string[]) => void): void {
  chooseFiles(async (files) => {
    const ids = await importFiles(files)
    onDone?.(ids)
  })
}

/**
 * Open the system file picker and hand the chosen files to `onPicked`.
 *
 * Must be called synchronously from a click: browsers (and the Android
 * WebView) only allow a file dialog that is opened inside the user gesture.
 */
export function chooseFiles(onPicked: (files: File[]) => void, multiple = true): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = IMPORT_ACCEPT
  input.multiple = multiple
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.onchange = () => {
    const files = Array.from(input.files || [])
    input.remove()
    if (files.length) onPicked(files)
  }
  // Some WebViews only fire `change` for an input that is in the document.
  document.body.appendChild(input)
  input.click()
}

/** Parse one file and persist the book + its chapters + the original bytes. */export async function importBookFile(file: File): Promise<string> {
  const ext = extOf(file.name)
  if (!isImportable(file.name)) {
    throw new Error(`不支持 .${ext || '未知'} 格式，请选择 txt / epub / md`)
  }

  const buffer = await file.arrayBuffer()
  const parsed = ext === 'epub'
    ? await parseEpub(buffer, file.name)
    : await parseTxt(buffer, file.name)

  const id = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const book = {
    id,
    title: parsed.title || file.name,
    author: parsed.author,
    format: (ext === 'epub' ? 'epub' : 'txt') as 'txt' | 'epub',
    cover: parsed.cover,
    wordCount: parsed.totalWords,
    fileSize: file.size,
    importedAt: Date.now(),
    lastReadAt: Date.now(),
    progress: 0,
    lastChapterIndex: 0,
    lastCharOffset: 0,
    finished: false,
    parserVersion: PARSER_VERSION,
    sourceName: file.name,
  }

  // Chapters go in one transaction: a 3000-chapter book would take minutes with
  // a write per row.
  const rows = parsed.chapters.map((c: any, i: number) => ({
    bookId: id,
    index: i,
    title: c.title || `第${i + 1}章`,
    html: c.html,
    text: c.text,
    charOffset: 0,
    wordCount: (c.text || '').replace(/\s/g, '').length,
  }))

  await dbPutMany('chapters', rows)
  await useBookStore().addBook(book as any)

  // Keep the original bytes so a future parser upgrade can rebuild in place.
  // Failure here is not fatal — the book is already readable.
  try {
    await saveSourceFile(id, file.name, buffer)
  } catch { /* quota: the book still reads */ }

  return id
}

/**
 * Import every file, one at a time, reporting progress.
 *
 * Returns the ids that made it. A single bad file does not abort the batch:
 * the error is surfaced and the rest still land on the shelf.
 */
export async function importFiles(files: File[]): Promise<string[]> {
  if (importState.busy) return []
  const usable = files.filter(f => isImportable(f.name))
  const skipped = files.length - usable.length

  if (!usable.length) {
    importState.error = `不支持的文件格式，请选择 txt / epub / md`
    notify('')
    return []
  }

  importState.busy = true
  importState.error = ''
  importState.total = usable.length
  importState.index = 0

  const ids: string[] = []
  try {
    for (let i = 0; i < usable.length; i++) {
      const file = usable[i]
      importState.index = i + 1
      importState.name = file.name
      try {
        ids.push(await importBookFile(file))
      } catch (e: any) {
        importState.error = `${file.name}：${e?.message || '导入失败'}`
      }
      // Yield so the overlay repaints between files.
      await new Promise(r => setTimeout(r, 0))
    }
  } finally {
    importState.busy = false
    importState.name = ''
    importState.total = 0
    importState.index = 0
  }

  if (ids.length && !importState.error) {
    notify(ids.length === 1 ? '已导入 1 本' : `已导入 ${ids.length} 本`)
  } else if (ids.length) {
    notify(`已导入 ${ids.length} 本，${skipped ? `${skipped} 个文件被跳过` : '部分文件失败'}`)
  }
  return ids
}
