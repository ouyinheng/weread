/**
 * Driver-agnostic library copy used by the SQLite migration.
 *
 * Kept separate from the orchestrator so it can be unit-tested with two
 * IndexedDB drivers (the Android SQLite backend cannot run under Node). The
 * verification step lives here because "copy as much as possible" is not a
 * migration: a partial copy must fail loudly and leave the old store in use.
 */
import type { DBDriver, StoreName } from './types'

/** Text stores copied as whole tables (no per-book split needed). */
const SMALL_STORES: StoreName[] = ['books', 'sessions', 'settings', 'sources', 'daily']
/** Per-book stores, copied one book at a time to keep memory bounded. */
const BOOK_STORES: StoreName[] = ['chapters', 'bookmarks', 'highlights']

export interface CopyResult {
  books: number
  chapters: number
}

/**
 * Copy every text store from `source` to `target` and verify the row counts.
 *
 * `files` is intentionally not copied — original bytes stay in IndexedDB until
 * they move to the filesystem. A target that already holds a partial copy is
 * cleared first, so a failed run can be retried safely.
 */
export async function copyLibrary(
  source: DBDriver,
  target: DBDriver,
  onProgress?: (done: number, total: number, message: string) => void,
): Promise<CopyResult> {
  const books = await source.getAll('books')
  const total = books.length + SMALL_STORES.length

  for (const store of SMALL_STORES) await target.clear(store)
  for (const store of BOOK_STORES) await target.clear(store)

  let done = 0
  for (const store of SMALL_STORES) {
    const rows = await source.getAll(store)
    if (rows.length) await target.putMany(store, rows)
    done++
    onProgress?.(done, total, `正在迁移数据 ${done}/${total}`)
  }

  for (const book of books) {
    for (const store of BOOK_STORES) {
      const rows = await source.getAllByIndex(store, 'bookId', book.id)
      if (rows.length) await target.putMany(store, rows)
    }
    done++
    onProgress?.(done, total, `正在迁移书籍 ${done - SMALL_STORES.length}/${books.length}`)
  }

  // A reading session could have written progress after the first pass; the
  // small stores are cheap, so refresh them rather than losing that position.
  for (const store of SMALL_STORES) {
    const rows = await source.getAll(store)
    if (rows.length) await target.putMany(store, rows)
    else await target.clear(store)
  }

  /*
   * The library may have changed while the copy ran (this is a background job
   * in a live app). Reconcile the book list: drop books deleted during the run
   * so they cannot reappear next launch, and copy books imported after the
   * first pass so they are not stranded in IndexedDB.
   */
  const latestBooks = await source.getAll('books')
  const latestIds = new Set(latestBooks.map(b => b.id))
  const firstIds = new Set(books.map(b => b.id))
  for (const existing of await target.getAll('books')) {
    if (latestIds.has(existing.id)) continue
    await target.delete('books', existing.id)
    for (const store of BOOK_STORES) await target.deleteByIndex(store, 'bookId', existing.id)
  }
  await target.putMany('books', latestBooks)
  for (const book of latestBooks) {
    if (firstIds.has(book.id)) continue
    for (const store of BOOK_STORES) {
      const rows = await source.getAllByIndex(store, 'bookId', book.id)
      if (rows.length) await target.putMany(store, rows)
    }
  }

  // Verify what actually landed. A partial copy must never be marked done.
  const srcBooks = latestBooks.length
  const dstBooks = await target.count('books')
  if (srcBooks !== dstBooks) {
    throw new Error(`书籍数量不一致：${dstBooks}/${srcBooks}`)
  }
  const srcChapters = await countBookRows(source, latestBooks, 'chapters')
  const dstChapters = await target.count('chapters')
  if (srcChapters !== dstChapters) {
    throw new Error(`章节数量不一致：${dstChapters}/${srcChapters}`)
  }
  const srcHighlights = await countBookRows(source, latestBooks, 'highlights')
  const dstHighlights = await target.count('highlights')
  if (srcHighlights !== dstHighlights) {
    throw new Error(`划线数量不一致：${dstHighlights}/${srcHighlights}`)
  }

  return { books: dstBooks, chapters: dstChapters }
}

async function countBookRows(
  source: DBDriver,
  books: any[],
  store: StoreName,
): Promise<number> {
  let n = 0
  for (const book of books) n += (await source.getAllByIndex(store, 'bookId', book.id)).length
  return n
}
