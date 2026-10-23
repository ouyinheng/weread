/**
 * Chapter text → speakable sentences.
 *
 * Two constraints come from the speech engine, not from taste:
 *
 *  - `android.speech.tts.TextToSpeech` has **no pause/resume**, so the player
 *    stops and re-speaks to "resume". That only works if a sentence is a
 *    self-contained unit with a stable index — hence this module.
 *  - A single `speak()` call with a whole chapter stutters and some engines
 *    truncate. Sentences stay under `maxLen` characters.
 *
 * Offsets are indices into the string that was passed in. The caller feeds the
 * chapter body's `textContent`, so the same offsets also address the DOM range
 * used to paint the follow-along highlight and to convert into reading
 * progress (see `toCharOffset`).
 */

export interface Sentence {
  /** Start offset in the source string. */
  start: number
  /** End offset, exclusive. */
  end: number
  /** `source.slice(start, end)`, already trimmed. */
  text: string
}

/** Sentence terminators. A newline ends a sentence too — paragraphs are units. */
const HARD_STOP = /[。！？!?…\n]/
/** Where an over-long stretch may be broken without sounding wrong. */
const SOFT_STOP = /[；;，,、：:]/
/** Characters that belong to the sentence they follow. */
const TRAILING = /[”"’'」』）)】\]》]/

export const DEFAULT_MAX_LEN = 200

/**
 * Split `text` into sentences.
 *
 * @param text   chapter body text
 * @param maxLen hard ceiling per sentence; over-long runs break at the last
 *               soft stop before the ceiling, or are cut outright when there
 *               is no punctuation at all (unpunctuated CJK prose does exist)
 */
export function segmentText(text: string, maxLen = DEFAULT_MAX_LEN): Sentence[] {
  if (!text) return []
  const limit = Math.max(20, maxLen)
  const out: Sentence[] = []

  const push = (from: number, to: number) => {
    let s = from
    let e = to
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e <= s) return
    const slice = text.slice(s, e)
    /*
     * Drop segments that carry no speech: pure punctuation, and rules/blank
     * filler that some TXT conversions leave behind ("——", "***"). Reading
     * them aloud produces either silence or literal "破折号破折号".
     */
    if (!/[\p{L}\p{N}]/u.test(slice)) return
    out.push({ start: s, end: e, text: slice })
  }

  let cursor = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (HARD_STOP.test(ch)) {
      let end = i + 1
      /*
       * A run of terminators closes one sentence, not several: "等等……" and
       * "不会吧？！" are single utterances, and splitting them would make the
       * follow-along highlight skip the tail of the line. Closing quotes and
       * brackets belong to the sentence they close for the same reason.
       */
      while (end < text.length && (HARD_STOP.test(text[end]) || TRAILING.test(text[end]))) end++
      push(cursor, end)
      cursor = end
      i = end
      continue
    }

    if (i - cursor + 1 > limit) {
      // Over-long run: break at the last soft stop, else cut at the ceiling.
      let cut = -1
      for (let k = i; k > cursor; k--) {
        if (SOFT_STOP.test(text[k - 1])) {
          cut = k
          break
        }
      }
      if (cut <= cursor) cut = i
      push(cursor, cut)
      cursor = cut
      i = cut
      continue
    }

    i++
  }

  if (cursor < text.length) push(cursor, text.length)
  return out
}

/**
 * Convert a DOM-text offset into the reading-progress coordinate.
 *
 * Progress (`countChars` in utils/progress) counts **non-whitespace**
 * characters, while the DOM textContent these offsets come from keeps the
 * newlines between block elements. Counting the non-whitespace run gives the
 * offset the progress model expects, so listening and page-turning agree.
 */
export function toCharOffset(bodyText: string, domOffset: number): number {
  if (domOffset <= 0) return 0
  return bodyText.slice(0, Math.min(domOffset, bodyText.length)).replace(/\s+/g, '').length
}
