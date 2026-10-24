/**
 * In-book full-text search.
 *
 * The reader already holds every chapter's HTML in memory, so a linear scan is
 * a few milliseconds for a normal novel and avoids building a second index that
 * would have to be kept in sync with imports and deletions. The scan is done on
 * the *rendered* text (tags stripped, whitespace kept) so a hit can be both
 * jumped to (progress counts non-whitespace characters) and painted (DOM text
 * offsets include whitespace).
 */
export interface SearchableChapter {
  index: number
  title: string
  /** Chapter HTML; tags are stripped here, not by the caller. */
  html: string
}

export interface BookSearchHit {
  chapterIndex: number
  chapterTitle: string
  /** Offset in the chapter's rendered body text, whitespace included. */
  domOffset: number
  /** Non-whitespace character offset — the unit progress is stored in. */
  charOffset: number
  excerpt: string
  /** Match position inside `excerpt`. */
  matchStart: number
  matchEnd: number
}

const MAX_PER_CHAPTER = 20
const CONTEXT = 24

/** Tag-stripped text that mirrors what the reader lays out. */
export function htmlToSearchText(html: string): string {
  return (html || '').replace(/<[^>]+>/g, '')
}

function countNonSpace(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i)
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 0x3000 && c !== 0x00a0) n++
  }
  return n
}

export function searchBook(
  chapters: SearchableChapter[],
  query: string,
  limit = 200,
): BookSearchHit[] {
  const word = query.trim()
  if (!word) return []
  const needle = word.toLowerCase()
  const hits: BookSearchHit[] = []

  for (const ch of chapters) {
    if (hits.length >= limit) break
    const text = htmlToSearchText(ch.html)
    if (!text) continue
    const hay = text.toLowerCase()
    let from = 0
    let emitted = 0
    // Non-whitespace characters are counted incrementally as matches move
    // forward, so a chapter is scanned once rather than once per hit.
    let countedTo = 0
    let nonWs = 0

    while (emitted < MAX_PER_CHAPTER && hits.length < limit) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      if (at > countedTo) {
        nonWs += countNonSpace(text, countedTo, at)
        countedTo = at
      }

      const start = Math.max(0, at - CONTEXT)
      const end = Math.min(text.length, at + word.length + CONTEXT)
      const before = text.slice(start, at).replace(/\s+/g, ' ').replace(/^\s+/, '')
      const match = text.slice(at, at + word.length).replace(/\s+/g, ' ')
      const after = text.slice(at + word.length, end).replace(/\s+/g, ' ').replace(/\s+$/, '')
      const lead = start > 0 ? '…' : ''
      const tail = end < text.length ? '…' : ''
      const excerpt = `${lead}${before}${match}${after}${tail}`
      const matchStart = lead.length + before.length

      hits.push({
        chapterIndex: ch.index,
        chapterTitle: ch.title,
        domOffset: at,
        charOffset: nonWs,
        excerpt,
        matchStart,
        matchEnd: matchStart + match.length,
      })

      emitted++
      from = at + Math.max(1, needle.length)
    }
  }

  return hits
}
