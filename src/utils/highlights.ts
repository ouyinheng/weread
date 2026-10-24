/**
 * 划线 / 想法 — selected ranges in the reading page.
 *
 * A highlight stores character offsets into the chapter's *body* text (the
 * rendered chapter heading is chrome and not counted), which is what lets it
 * survive a font-size change and a re-layout: the reader re-renders the HTML
 * and re-wraps the ranges every time, rather than keeping DOM references.
 */
import type { Highlight, HighlightColor } from '@/types'
import { dbDelete, dbDeleteByIndex, dbGetAll, dbPut } from '@/utils/db'

export async function loadHighlights(bookId: string): Promise<Highlight[]> {
  const all = await dbGetAll<Highlight>('highlights')
  return all.filter(h => h.bookId === bookId)
}

export async function addHighlight(
  h: Omit<Highlight, 'id' | 'createdAt'>
): Promise<Highlight> {
  const row: Highlight = {
    ...h,
    id: `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  }
  await dbPut('highlights', row)
  return row
}

export async function removeHighlight(id: string): Promise<void> {
  await dbDelete('highlights', id)
}

/** Purge every highlight belonging to a book (called when it leaves the shelf). */
export async function purgeBookHighlights(bookId: string): Promise<void> {
  await dbDeleteByIndex('highlights', 'bookId', bookId)
}

/**
 * Wrap each `[start, end)` character range of `html`'s text in a `<mark>`.
 *
 * The HTML is parsed into a detached tree and walked once per range; splitting
 * the text nodes as we go keeps the offsets valid because each range is applied
 * against the freshly re-parsed markup.
 */
export function applyHighlights(html: string, ranges: { start: number; end: number; color?: HighlightColor }[]): string {
  if (!html || !ranges.length) return html

  const doc = new DOMParser().parseFromString(`<div id="wr-root">${html}</div>`, 'text/html')
  const root = doc.getElementById('wr-root')
  if (!root) return html

  for (const r of ranges) {
    if (!(r.end > r.start)) continue
    wrapRange(root, r.start, r.end, r.color)
  }
  return root.innerHTML
}

function wrapRange(root: HTMLElement, start: number, end: number, color?: HighlightColor): void {
  // Snapshot the text nodes first: inserting <mark> mid-walk would make the
  // walker visit the wrapped text a second time and corrupt the offsets.
  const nodes: Text[] = []
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let scanned: Node | null
  while ((scanned = walker.nextNode())) nodes.push(scanned as Text)

  let pos = 0
  for (const text of nodes) {
    const len = text.data.length
    const from = Math.max(start, pos)
    const to = Math.min(end, pos + len)
    if (from < to) {
      const cut = text.splitText(from - pos)
      cut.splitText(to - from)
      const mark = root.ownerDocument!.createElement('mark')
      mark.className = color && color !== 'blue' ? `reader__hl reader__hl--${color}` : 'reader__hl'
      cut.parentNode!.insertBefore(mark, cut)
      mark.appendChild(cut)
    }
    pos += len
    if (pos >= end) return
  }
}
