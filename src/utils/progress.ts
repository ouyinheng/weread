/**
 * Progress model: (chapterIndex, charOffset), never page numbers.
 *
 * WeRead itself passes ARG_BOOK_START_CHAR_POS between pages, so a character
 * offset is the only position that survives font-size, line-height, margin and
 * screen-width changes. Page indices are derived, never persisted.
 */

/** Character count of a chapter's HTML, tag/whitespace stripped. */
export function countChars(html: string): number {
  if (!html) return 0
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

export interface ChapterChars {
  index: number
  chars: number
}

/** Total characters before `chapterIndex`. */
export function charsBefore(list: number[], chapterIndex: number): number {
  let sum = 0
  for (let i = 0; i < chapterIndex && i < list.length; i++) sum += list[i]
  return sum
}

export function totalChars(list: number[]): number {
  return list.reduce((a, b) => a + b, 0)
}

/** Overall progress 0..100 for a (chapter, charOffset) position. */
export function progressPercent(list: number[], chapterIndex: number, charOffset: number): number {
  const total = totalChars(list)
  if (!total) return 0
  const read = charsBefore(list, chapterIndex) + Math.max(0, charOffset)
  return Math.min(100, Math.max(0, (read / total) * 100))
}

/** Page index → character offset within a chapter. */
export function pageToChar(page: number, pageCount: number, chapterChars: number): number {
  if (!chapterChars || chapterChars <= 0 || pageCount <= 1) return 0
  const p = Math.max(0, Math.min(pageCount - 1, page))
  return Math.round((p / pageCount) * chapterChars)
}

/** Character offset → page index, inverse of pageToChar. */
export function charToPage(offset: number, pageCount: number, chapterChars: number): number {
  if (!chapterChars || chapterChars <= 0 || pageCount <= 1) return 0
  const page = Math.round((Math.max(0, Math.min(chapterChars, offset)) / chapterChars) * pageCount)
  return Math.max(0, Math.min(pageCount - 1, page))
}

/** Remaining reading time in minutes at a sustained chars-per-minute rate. */
export function remainingMinutes(list: number[], chapterIndex: number, charOffset: number, cpm = 400): number {
  const total = totalChars(list)
  if (!total) return 0
  const remain = Math.max(0, total - charsBefore(list, chapterIndex) - Math.max(0, charOffset))
  if (!cpm || cpm <= 0) return 0
  return Math.round(remain / cpm)
}

/** Human-readable "time to finish", WeRead style. */
export function remainText(minutes: number): string {
  if (minutes < 1) return '即将读完'
  if (minutes < 60) return `约 ${minutes} 分钟后读完`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `约 ${h} 小时 ${m} 分钟后读完` : `约 ${h} 小时后读完`
}
