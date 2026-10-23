/**
 * The listen-along state machine.
 *
 * Deliberately a plain `await` loop rather than a timer or an event cascade:
 * the engine contract is "speak resolves when this sentence is done", so the
 * loop body is one sentence. That is the whole design, and it is the only one
 * Android's engine allows — there is no pause, so pausing means stopping and
 * remembering which sentence was speaking.
 *
 * A monotonically increasing `token` guards every await: pause / skip / exit
 * bump it, so a sentence that was in flight when the user acted cannot advance
 * the index afterwards.
 */
import { computed, ref } from 'vue'
import { createEngine, TtsCancelled, type EngineReason, type TtsEngine, type TtsVoice } from './tts'
import type { Sentence } from './segmenter'

export type ListenStatus = 'idle' | 'playing' | 'paused' | 'ended' | 'unavailable'

export interface ListenSettings {
  /** 1.0 is the engine's natural pace. */
  rate: number
  /** Engine voice name; empty means the engine default. */
  voice: string
  /** Roll into the next chapter when this one finishes. */
  autoNextChapter: boolean
}

export interface PlayerDeps {
  /** Sentences of the chapter being listened to. */
  sentences: () => Sentence[]
  settings: () => ListenSettings
  /** Called as each sentence starts — paint the highlight and save progress. */
  onSentence?: (sentence: Sentence, index: number) => void
  /** Advance to the next chapter. Return false when there is none. */
  onChapterEnd?: () => boolean | Promise<boolean>
  /**
   * Engine factory, injectable so the state machine can be tested without a
   * speech engine. Defaults to the platform engine.
   */
  createEngine?: () => Promise<TtsEngine>
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function useListenPlayer(deps: PlayerDeps) {
  const status = ref<ListenStatus>('idle')
  const index = ref(0)
  const reason = ref<EngineReason | undefined>()

  let engine: TtsEngine | null = null
  let token = 0

  /*
   * 'ended' still counts as active: the bar must stay up so the reader can see
   * that the chapter finished and either replay it or close the bar. Vanishing
   * the controls the instant the last sentence lands reads as a glitch.
   */
  const active = computed(() =>
    status.value === 'playing' || status.value === 'paused' || status.value === 'ended'
  )
  const available = computed(() => status.value !== 'unavailable')

  async function ensureEngine(): Promise<TtsEngine | null> {
    if (engine) return engine
    engine = await (deps.createEngine || createEngine)()
    if (engine.kind === 'none') {
      reason.value = engine.reason
      status.value = 'unavailable'
      return null
    }
    return engine
  }

  /** The loop. Runs one sentence per iteration until the chapter ends. */
  async function run(from: number) {
    const e = await ensureEngine()
    if (!e) return

    const list = deps.sentences()
    if (!list.length) {
      status.value = 'ended'
      return
    }

    /*
     * Invalidate the previous loop *before* silencing the engine. Order
     * matters: `stop()` settles the outstanding `speak()` promise as
     * cancelled, and the old loop must already know it is stale or it would
     * treat that rejection as an error and flip the UI to unavailable.
     */
    const my = ++token
    await e.stop()

    index.value = clamp(from, 0, list.length - 1)
    status.value = 'playing'

    while (my === token) {
      // Re-read per iteration: the chapter may have been swapped underneath.
      const current = deps.sentences()
      if (index.value >= current.length) break
      const sentence = current[index.value]

      deps.onSentence?.(sentence, index.value)

      try {
        await e.speak(sentence.text, deps.settings().rate, deps.settings().voice || undefined)
      } catch (err) {
        if (my !== token) return
        // Cancellation is the user's own doing (pause / skip / exit).
        if (err instanceof TtsCancelled) return
        // A network voice failing is not a broken phone engine; say so.
        reason.value = err instanceof Error && err.message === 'edge-failed'
          ? 'online-failed'
          : 'engine-init-failed'
        status.value = 'unavailable'
        return
      }

      if (my !== token) return
      index.value++
    }

    if (my !== token) return
    status.value = 'ended'

    if (!deps.settings().autoNextChapter) return
    const advanced = await deps.onChapterEnd?.()
    if (my !== token || !advanced) return
    // Not awaited: this would nest one frame per chapter on a long book.
    void run(0)
  }

  async function play(from = index.value) {
    await run(from)
  }

  async function pause() {
    // Bump first: the in-flight sentence must not advance the index.
    token++
    status.value = 'paused'
    await engine?.stop()
  }

  async function toggle() {
    if (status.value === 'playing') {
      await pause()
      return
    }
    if (status.value === 'unavailable') {
      // A second tap retries — the user may have just installed a voice pack.
      engine = null
      reason.value = undefined
      status.value = 'idle'
    }
    await play(status.value === 'paused' ? index.value : 0)
  }

  async function next() {
    const list = deps.sentences()
    await run(Math.min(index.value + 1, Math.max(0, list.length - 1)))
  }

  async function prev() {
    await run(Math.max(0, index.value - 1))
  }

  /** Jump straight to a sentence (progress bar drag). */
  async function seek(to: number) {
    const list = deps.sentences()
    await run(clamp(to, 0, Math.max(0, list.length - 1)))
  }

  /** System voices for the voice picker; lazily boots the engine. */
  async function voices(): Promise<TtsVoice[]> {
    const e = await ensureEngine()
    return e ? e.voices() : []
  }

  async function stop() {
    token++
    status.value = 'idle'
    index.value = 0
    await engine?.stop()
  }

  /**
   * Re-speak the current sentence, e.g. after the rate or voice changed so the
   * new setting is audible now rather than from the next sentence.
   */
  async function restartCurrent() {
    if (status.value === 'playing') await run(index.value)
  }

  /**
   * Start listening from a character offset in the current chapter.
   * @param charOffsets per-sentence progress offsets, same length as sentences
   */
  async function playFromOffset(offset: number, charOffsets: number[]) {
    // The sentence *containing* the offset, not the first one starting after
    // it: resuming mid-sentence must repeat that sentence, not skip it.
    let at = 0
    for (let i = 0; i < charOffsets.length; i++) {
      if (charOffsets[i] <= offset) at = i
      else break
    }
    await run(at)
  }

  return {
    status,
    index,
    reason,
    active,
    available,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    voices,
    stop,
    restartCurrent,
    playFromOffset,
  }
}
