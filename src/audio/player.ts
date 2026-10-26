/**
 * The listen-along state machine.
 *
 * Deliberately a plain `await` loop rather than a timer or an event cascade:
 * the engine contract is "speak resolves when this sentence is done", so the
 * loop body is one sentence. That is the whole design, and it is the only one
 * Android's engine allows — there is no pause, so pausing means stopping and
 * remembering which sentence was speaking.
 *
 * Engines that queue utterances are given two sentences ahead: the next ones
 * are already synthesising while the current one plays, which removes the
 * silent gap between sentences. One-shot engines stay strictly sequential.
 *
 * Online voices additionally get a chapter prepared up front (`prefetch`): the
 * page waits for the first few sentences to land on disk, shows that wait as
 * `buffering`, and lets the rest of the chapter stream in behind playback. That
 * turns every later paragraph boundary into local file playback.
 *
 * A monotonically increasing `token` guards every await: pause / skip / exit
 * bump it, so a sentence that was in flight when the user acted cannot advance
 * the index afterwards.
 */
import { computed, ref } from 'vue'
import { createEngine, TtsCancelled, type EngineReason, type TtsEngine, type TtsVoice } from './tts'
import type { Sentence } from './segmenter'

export type ListenStatus = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'unavailable'

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

/**
 * How many sentences to have on disk before the first one starts playing.
 *
 * A whole chapter takes ~20–40 s to synthesise, which nobody would sit
 * through. Six sentences is 3–5 s at three concurrent sockets — long enough to
 * cover the first few paragraph boundaries, short enough to feel like pressing
 * play.
 */
const PREFETCH_HEAD = 6

/** Engines we tell ahead how many sentences? Two is enough to hide the round trip. */
const LOOKAHEAD = 2

export function useListenPlayer(deps: PlayerDeps) {
  const status = ref<ListenStatus>('idle')
  const index = ref(0)
  const reason = ref<EngineReason | undefined>()
  /** Sentences of the chapter currently being prepared, for the loading label. */
  const bufferProgress = ref({ done: 0, total: 0 })

  let engine: TtsEngine | null = null
  let token = 0
  /** Bumped per prefetch request so stale progress events are dropped. */
  let prefetchSeq = 0
  /**
   * The chapter (and settings) already prepared, by identity. Only the first
   * play of a chapter waits — seeking within a prepared chapter must not flash
   * the loading state again.
   */
  let prepared: { list: Sentence[]; voice: string; rate: number } | null = null

  /*
   * 'ended' still counts as active: the bar must stay up so the reader can see
   * that the chapter finished and either replay it or close the bar. Vanishing
   * the controls the instant the last sentence lands reads as a glitch.
   */
  const active = computed(() =>
    status.value === 'playing' || status.value === 'paused'
    || status.value === 'ended' || status.value === 'buffering'
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

  /**
   * Get the head of the chapter onto disk, then let the rest stream in.
   *
   * @returns false when the run was superseded while waiting (pause, skip,
   *          chapter change) and the caller must stop.
   */
  async function prepare(
    e: TtsEngine,
    list: Sentence[],
    from: number,
    gen: number,
  ): Promise<boolean> {
    const s = deps.settings()
    const voice = s.voice || undefined
    if (!e.canPrefetch?.(voice) || !e.prefetch) return true

    const voiceKey = s.voice || ''
    if (prepared && prepared.list === list && prepared.voice === voiceKey && prepared.rate === s.rate) {
      return true
    }

    const head = Math.min(PREFETCH_HEAD, list.length - from)
    if (head <= 0) return true

    const seq = ++prefetchSeq
    status.value = 'buffering'
    bufferProgress.value = { done: 0, total: head }
    try {
      await e.prefetch(
        list.slice(from, from + head).map(x => x.text),
        s.rate,
        voice,
        (done, total) => {
          if (seq === prefetchSeq) bufferProgress.value = { done, total }
        },
        seq,
      )
    } catch {
      // Preparation is an optimisation, not a requirement: playback below
      // still synthesises sentence by sentence when it fails.
    }
    if (gen !== token) return false

    prepared = { list, voice: voiceKey, rate: s.rate }

    const rest = list.slice(from + head).map(x => x.text)
    if (rest.length) {
      // Not awaited: the point is to be listening while this runs. Its token is
      // newer than `seq`, so its progress events never touch the UI.
      void e.prefetch(rest, s.rate, voice, () => {}, ++prefetchSeq).catch(() => undefined)
    }
    return true
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

    const voice = deps.settings().voice || undefined
    /*
     * Engines that queue utterances can be told ahead: the next sentences
     * synthesise while the current one plays, which is what removes the silent
     * gap at each paragraph boundary. One-shot engines stay sequential.
     */
    const lookahead = e.canLookahead?.(voice) === true
    const queued = new Map<number, Promise<void>>()

    const enqueue = (i: number) => {
      if (i < 0 || queued.has(i)) return
      const now = deps.sentences()
      if (i >= now.length) return
      const p = e.speak(now[i].text, deps.settings().rate, deps.settings().voice || undefined)
      // A lookahead promise can fail while the previous sentence still plays.
      // Mark it handled here; the loop surfaces the error when the sentence is due.
      p.catch(() => {})
      queued.set(i, p)
    }

    index.value = clamp(from, 0, list.length - 1)

    /*
     * Online voices synthesise the chapter to disk first. `buffering` is shown
     * for that wait only; if the user pauses or skips, the run is superseded
     * and this returns false instead of starting playback behind their back.
     */
    if (!await prepare(e, list, index.value, my)) return
    if (my !== token) return

    status.value = 'playing'

    while (my === token) {
      // Re-read per iteration: the chapter may have been swapped underneath.
      const current = deps.sentences()
      const at = index.value
      if (at >= current.length) break

      deps.onSentence?.(current[at], at)
      enqueue(at)
      if (lookahead) {
        for (let k = 1; k <= LOOKAHEAD; k++) enqueue(at + k)
      }

      try {
        await queued.get(at)
      } catch (err) {
        if (my !== token) return
        // Cancellation is the user's own doing (pause / skip / exit).
        if (err instanceof TtsCancelled) return
        // A network voice failing is not a broken phone engine; say so.
        reason.value = err instanceof Error && err.message === 'edge-failed'
          ? 'online-failed'
          : 'engine-init-failed'
        status.value = 'unavailable'
        // Silence the sentence that was queued ahead, if any.
        void e.stop()
        return
      } finally {
        queued.delete(at)
      }

      if (my !== token) return
      index.value = at + 1
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
    await cancelPrefetch()
    await engine?.stop()
  }

  /** Drop the preparation in flight — a paused reader is not downloading audio. */
  async function cancelPrefetch() {
    prefetchSeq++
    try {
      await engine?.cancelPrefetch?.()
    } catch {
      // Nothing was running.
    }
  }

  async function toggle() {
    if (status.value === 'playing' || status.value === 'buffering') {
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
    bufferProgress.value = { done: 0, total: 0 }
    prepared = null
    await cancelPrefetch()
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
    bufferProgress,
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
