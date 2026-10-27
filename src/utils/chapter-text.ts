/**
 * Chapter HTML → the plain text the speech engine reads.
 *
 * The reader renders the body with `v-html`, so the authoritative string for
 * sentence offsets is `body.textContent`. This module reproduces it without a
 * live DOM (the listening session has to keep working after the reader page is
 * gone), which makes the two coordinate systems interchangeable:
 *
 *  - **ordinal, not raw** — `toCharOffset()` counts non-whitespace characters,
 *    so any whitespace difference between a real `textContent` and the string
 *    built here is invisible to offsets. That is what lets a session built from
 *    the database paint the same highlight the reader would have measured.
 *  - **body only** — the chapter opener (`第1章` + name) is injected by the
 *    reader outside `.reader__body` and is deliberately not spoken.
 */

/** Entities a chapter's HTML can carry; `DOMParser` handles them all for us. */
const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
]

/**
 * Text content of `html`.
 *
 * `DOMParser("text/html")` gives exactly what the browser would concatenate for
 * the same markup (block elements contribute no separator, `<br>` none either),
 * which is the property the offset mapping depends on. The regex path is the
 * fallback for contexts without a DOM (unit tests).
 */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const body = doc.body
      if (body) return body.textContent || ''
    } catch {
      // Fall through to the regex path.
    }
  }
  let text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  // A block boundary is a real separator in any plain-text view of the page.
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  for (const [re, ch] of ENTITIES) text = text.replace(re, ch)
  return text
}

/** Speakable text of a chapter: the rendered body, nothing else. */
export function chapterPlainText(html: string): string {
  return htmlToPlainText(html)
}
