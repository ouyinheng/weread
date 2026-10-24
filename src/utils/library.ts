import type { Book } from '@/types'
import { dbGet, dbPut, dbPutMany, dbPutRaw, dbDeleteByIndex } from '@/utils/db'
import { parseTxt, parseEpub, PARSER_VERSION, type ParsedBook } from '@/utils/parser'

export interface StoredFile {
  bookId: string
  name: string
  bytes: ArrayBuffer
}

/** Keep the original file so a parser upgrade can rebuild the book later. */
export async function saveSourceFile(bookId: string, name: string, bytes: ArrayBuffer): Promise<void> {
  // Structured clone handles ArrayBuffer natively; the Proxy-stripping helper in
  // db.ts round-trips through JSON and would destroy the bytes.
  await dbPutRaw('files', { bookId, name, bytes })
}

export async function loadSourceFile(bookId: string): Promise<StoredFile | undefined> {
  const rec = await dbGet<StoredFile>('files', bookId)
  return rec
}

/**
 * Re-parse a book from its stored source bytes with the current parser.
 * Returns true when the book was rebuilt.
 */
export async function rebuildBook(book: Book): Promise<boolean> {
  const source = await loadSourceFile(book.id)
  if (!source || !source.bytes) return false

  const name = source.name || book.sourceName || `${book.title}.${book.format}`
  let parsed: ParsedBook
  if (book.format === 'epub') parsed = await parseEpub(source.bytes, name)
  else parsed = await parseTxt(source.bytes, name)

  if (!parsed.chapters.length) return false

  await dbDeleteByIndex('chapters', 'bookId', book.id)
  const rows = parsed.chapters.map((c, i) => ({
    bookId: book.id,
    index: i,
    title: c.title || `第${i + 1}章`,
    html: c.html,
    text: c.text,
    charOffset: 0,
    wordCount: c.text.replace(/\s/g, '').length,
  }))
  await dbPutMany('chapters', rows)

  await dbPut('books', {
    ...book,
    title: parsed.title || book.title,
    author: parsed.author || book.author,
    cover: parsed.cover || book.cover,
    wordCount: parsed.totalWords,
    parserVersion: PARSER_VERSION,
    sourceName: name,
    // Positions were computed against the old chapter list; clamp them.
    lastChapterIndex: Math.min(book.lastChapterIndex, parsed.chapters.length - 1),
  })
  return true
}

/** True when this book was produced by an older parser generation. */
export function needsRebuild(book: Book): boolean {
  return (book.parserVersion ?? 1) < PARSER_VERSION
}
