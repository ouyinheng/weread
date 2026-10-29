/**
 * Sentences → speakable chunks.
 *
 * Why this exists: every `speak()` call costs the engine a fresh start — the
 * phone engine re-arms its synthesis pipeline per utterance (~0.3–1 s of
 * silence on most Chinese engines) and the online voice needs a network round
 * trip per utterance. Reading one sentence per utterance therefore puts a hole
 * at *every* sentence and paragraph boundary, which is exactly what "段与段
 * 之间停一下" sounds like.
 *
 * So consecutive sentences are glued into one utterance of roughly
 * {@link CHUNK_CHARS} characters. Fewer, longer utterances mean the engine
 * only pays that cost once every ~20 s instead of once every ~5 s, and the
 * boundaries it does have are already queued ahead by the player, so they are
 * inaudible.
 *
 * Chunks stay sentence-aligned on purpose: `index` still points at a sentence,
 * so 跟读高亮、进度、暂停续听 all keep working on the same coordinates as
 * before — only the unit handed to the engine got bigger.
 */
import type { Sentence } from './segmenter'

export interface Chunk {
  /** First sentence index (inclusive). */
  from: number
  /** Last sentence index (inclusive). */
  to: number
  /** What gets spoken: the sentences joined by a newline. */
  text: string
  /**
   * Offset of each sentence inside `text`; index `i - from` for sentence `i`.
   * Precomputed because the highlighter maps engine character ranges back to
   * sentences on every progress event.
   */
  starts: number[]
}

/**
 * Characters per utterance.
 *
 * At ~4.2 汉字/秒 this is ~19 s of audio: long enough that per-utterance
 * overhead is amortised, short enough that pausing still resumes near where
 * the reader stopped listening.
 */
export const CHUNK_CHARS = 80

/** Separator between two sentences. A newline gives every engine a beat. */
const JOIN = '\n'

/**
 * Characters in the *first* utterance of a run.
 *
 * Every play / pause-resume / seek starts with nothing queued ahead, so this
 * one utterance is paid for in full before the first word: a short one gets
 * audio out in a fraction of a second, and the long ones after it are already
 * being synthesised behind it. ~8 s of speech.
 */
export const HEAD_CHUNK_CHARS = 32

/**
 * Group `list` from sentence `from` onwards.
 *
 * A sentence longer than the limit gets a chunk of its own — splitting it
 * again would cut mid-sentence and sound worse than one long utterance.
 */
export function buildChunks(
  list: Sentence[],
  from = 0,
  maxChars = CHUNK_CHARS,
): Chunk[] {
  const out: Chunk[] = []
  let i = Math.max(0, Math.min(from, list.length))
  while (i < list.length) {
    let chars = 0
    let j = i
    while (j < list.length) {
      const len = list[j].text.length
      // Always take at least one sentence, however long it is.
      if (j > i && chars + len > maxChars) break
      chars += len
      j++
    }
    const starts: number[] = []
    let pos = 0
    for (let k = i; k < j; k++) {
      starts.push(pos)
      pos += list[k].text.length + JOIN.length
    }
    out.push({ from: i, to: j - 1, text: list.slice(i, j).map(s => s.text).join(JOIN), starts })
    i = j
  }
  return out
}

/**
 * The whole plan for a run: one short head, then the remaining chapter in
 * full-length chunks.
 *
 * The head is short because it is the only utterance with nothing queued
 * behind it — its synthesis time is the silence the listener hears before the
 * first word. Everything after it is spoken while the previous chunk plays.
 */
export function buildPlan(list: Sentence[], from = 0): Chunk[] {
  if (from >= list.length) return []
  const head = buildChunks(list, from, HEAD_CHUNK_CHARS)[0]
  if (!head) return []
  return [head, ...buildChunks(list, head.to + 1)]
}

/**
 * Which sentence of `chunk` contains character `at` of the chunk text.
 *
 * Used by the `onRange` path: the phone engine reports the character range it
 * is speaking right now, which is the only exact answer available without
 * timestamps.
 */
export function sentenceAt(chunk: Chunk, at: number): number {
  const offsets = chunk.starts
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= at) lo = mid
    else hi = mid - 1
  }
  return chunk.from + lo
}
