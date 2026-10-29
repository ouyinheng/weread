/**
 * The listen-along state machine.
 *
 * Deliberately a plain `await` loop rather than a timer or an event cascade:
 * the engine contract is "speak resolves when this chunk is done", so the loop
 * body is one chunk. Pausing means stopping and remembering which sentence was
 * speaking (Android has no pause).
 *
 * **What is spoken is a chunk, not a sentence.** A chunk is a few consecutive
 * sentences glued together (see `chunker.ts`) because both engines pay a fixed
 * cost per `speak()` call — a silent re-arm on the phone engine, a network
 * round trip on the online one. One sentence per call therefore left an audible
 * hole at every sentence and paragraph boundary. Chunks are still sentence
 * aligned, so `index`, 跟读高亮 and progress keep their old meaning.
 *
 * Chunks are handed to the engine ahead of time: the next ones are already
 * synthesising while the current one plays, so the boundary at the end of a
 * chunk is covered too.
 *
 * Online voices additionally get the chapter prepared up front (`prefetch`):
 * the page waits for the *first* chunk to land on disk (one chunk, not six
 * sentences — that wait used to be several seconds) and lets the rest stream in
 * behind playback, so every later boundary is local file playback.
 *
 * The highlight walks through the sentences inside a chunk from three sources,
 * best first: engine character ranges (`onRange`), the chunk's real audio
 * length when the engine reports one, and finally a self-calibrating estimate
 * of the voice's characters-per-second.
 *
 * A monotonically increasing `token` guards every await: pause / skip / exit
 * bump it, so a chunk that was in flight when the user acted cannot advance the
 * index afterwards.
 */
import { computed, ref } from 'vue'
import {
  createEngine,
  TtsCancelled,
  type EngineReason,
  type SpeakHooks,
  type TtsEngine,
  type TtsVoice,
} from './tts'
import type { Sentence } from './segmenter'
import { buildPlan, sentenceAt, type Chunk } from './chunker'

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

/** How many chunks to hand the engine ahead of the one playing. */
const LOOKAHEAD = 2

/**
 * Fallback speaking speed, 汉字/秒, for engines that report neither character
 * ranges nor an audio length. It is only the starting guess: every finished
 * chunk re-measures it (see `calibrate`), so the estimate converges on the real
 * voice within one chunk — including after the rate slider changes.
 */
const DEFAULT_CHARS_PER_SECOND = 4.2

export function useListenPlayer(deps: PlayerDeps) {
  const status = ref<ListenStatus>('idle')
  const index = ref(0)
  const reason = ref<EngineReason | undefined>()
  /** Chunks of the chapter currently being prepared, for the loading label. */
  const bufferProgress = ref({ done: 0, total: 0 })

  let engine: TtsEngine | null = null
  /** Engine boot in flight; shared so prewarm and play cannot boot twice. */
  let booting: Promise<TtsEngine | null> | null = null
  /** Bumped to supersede an in-flight run. */
  let token = 0
  /** Bumped per prefetch request so stale progress events are dropped. */
  let prefetchSeq = 0
  /** Measured speaking speed, and the rate it was measured at. */
  let charsPerSecond = DEFAULT_CHARS_PER_SECOND
  let calibratedAtRate = 0

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

  /**
   * Create the engine on first use, and tell it to load the voice in the
   * background.
   *
   * `warm()` is the difference between "tap 听书 → 1 s of nothing" and tapping
   * straight into speech: the engine's cold start (voice data, audio pipeline)
   * overlaps with loading the chapter instead of following the tap.
   *
   * The in-flight promise is shared, because `prewarm` and the first `play`
   * both ask for the engine and must not boot two speech engines.
   */
  async function ensureEngine(): Promise<TtsEngine | null> {
    if (engine) return engine
    if (!booting) {
      booting = (async () => {
        const e = await (deps.createEngine || createEngine)()
        booting = null
        if (e.kind === 'none') {
          reason.value = e.reason
          status.value = 'unavailable'
          return null
        }
        engine = e
        e.warm?.()
        return e
      })()
    }
    return booting
  }

  /** Start the engine early (opening 听书), so `play` does not pay for init. */
  function prewarm(): void {
    if (engine) return
    void ensureEngine().catch(() => undefined)
  }

  /**
   * Get the first chunk onto disk, then let the rest stream in.
   *
   * Only the first chunk is awaited. Waiting for a fixed head of six sentences
   * (the old behaviour) cost several seconds before the first word; one chunk
   * is ~20 s of audio, which is enough runway for the prefetcher to stay ahead.
   *
   * @returns false when the run was superseded while waiting (pause, skip,
   *          chapter change) and the caller must stop.
   */
  async function prepare(
    e: TtsEngine,
    chunks: Chunk[],
    voice: string | undefined,
    startStatus: ListenStatus,
    gen: number,
  ): Promise<boolean> {
    const s = deps.settings()
    if (!chunks.length) return true
    if (!e.canPrefetch?.(voice) || !e.prefetch) return true

    // One preparation at a time: a seek must not leave the previous
    // whole-chapter run fighting this one for sockets.
    await cancelPrefetch()

    const seq = ++prefetchSeq
    const visible = startStatus !== 'playing'
    if (visible) {
      status.value = 'buffering'
      bufferProgress.value = { done: 0, total: chunks.length }
    }

    let releaseFirst = () => {}
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve })

    const all = e.prefetch(
      chunks.map(c => c.text),
      s.rate,
      voice,
      (done, total) => {
        if (seq !== prefetchSeq) return
        if (visible) bufferProgress.value = { done, total }
        if (done >= 1) releaseFirst()
      },
      seq,
    ).catch(() => undefined)

    // Whatever finishes first: the first chunk is on disk, or the run died.
    await Promise.race([firstReady, all])
    if (gen !== token) return false

    /*
     * The remaining chunks keep synthesising behind playback. Not awaited: the
     * point is to be listening while that happens.
     */
    void all
    return true
  }

  /** The loop. Runs one chunk per iteration until the chapter ends. */
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
    const startStatus = status.value
    await e.stop()

    const { rate, voice } = deps.settings()
    const voiceName = voice || undefined

    index.value = clamp(from, 0, list.length - 1)

    const chunks = buildPlan(list, index.value)
    if (!await prepare(e, chunks, voiceName, startStatus, my)) return
    if (my !== token) return

    const lookahead = e.canLookahead?.(voiceName) === true
    const queued = new Map<number, Promise<void>>()
    /**
     * Cancels the running highlight walk for the current chunk. Held in an
     * object because it is replaced from inside `walk` and read from the loop —
     * a plain `let` reads as `null` to the type checker there.
     */
    const walker: { stop: (() => void) | null } = { stop: null }
    const stopWalk = () => {
      walker.stop?.()
      walker.stop = null
    }

    const say = (i: number) => {
      // Monotonic: a stale walk or a range event from the previous chunk must
      // never drag the highlight backwards.
      if (i < 0 || i >= list.length || i <= index.value) return
      index.value = i
      deps.onSentence?.(list[i], i)
    }

    /**
     * Walk the highlight through a chunk's sentences.
     *
     * `durationMs` comes from the engine when it knows the real audio length
     * (online voice). Otherwise the measured characters-per-second is used,
     * which is why `calibrate` exists.
     */
    const walk = (chunk: Chunk, durationMs?: number) => {
      stopWalk()
      if (chunk.to <= chunk.from) return
      const chars = chunk.text.length
      const perChar = durationMs && durationMs > 0
        ? durationMs / chars
        : 1000 / (charsPerSecond * Math.max(0.5, rate || 1))
      let handles: ReturnType<typeof setTimeout>[] = []
      for (let i = chunk.from + 1; i <= chunk.to; i++) {
        const delay = chunk.starts[i - chunk.from] * perChar
        handles.push(setTimeout(() => {
          if (my !== token) return
          say(i)
        }, delay))
      }
      walker.stop = () => {
        for (const h of handles) clearTimeout(h)
        handles = []
      }
    }

    /** Learn the voice's real pace from a chunk that just finished. */
    const calibrate = (chunk: Chunk, startedAt: number) => {
      const elapsed = Date.now() - startedAt
      // Too short to measure (a stub engine, a paused chunk): keep the guess.
      if (elapsed < 300) return
      const measured = (chunk.text.length / elapsed) * 1000
      if (!(measured > 0.5 && measured < 40)) return
      if (calibratedAtRate !== rate) {
        // First measurement at this pace, or the slider just moved: trust it.
        charsPerSecond = measured
        calibratedAtRate = rate
        return
      }
      // Slow EMA: one odd chunk (a pause, a stutter) must not move it far.
      charsPerSecond = charsPerSecond * 0.7 + measured * 0.3
    }

    /** Per-utterance subscriptions for one chunk. */
    const hooksFor = (chunk: Chunk): SpeakHooks => ({
      onStart: (info) => {
        if (my !== token) return
        // Audio starts *now*: re-base the walk on the real length if the
        // engine reported one, instead of the estimate armed at queue time.
        walk(chunk, info?.duration)
      },
      onRange: (start) => {
        if (my !== token) return
        say(sentenceAt(chunk, start))
      },
    })

    const speak = (k: number): Promise<void> => {
      const hit = queued.get(k)
      if (hit) return hit
      const chunk = chunks[k]
      let startedAt = 0
      const hooks = hooksFor(chunk)
      const wrapped: SpeakHooks = {
        onStart: (info) => { startedAt = Date.now(); hooks.onStart?.(info) },
        onRange: hooks.onRange,
      }
      const p = e.speak(chunk.text, rate, voiceName, wrapped)
      // A lookahead promise can fail while the previous chunk still plays.
      // Mark it handled here; the loop surfaces the error when it is due.
      p.catch(() => {})
      p.then(() => {
        if (startedAt) calibrate(chunk, startedAt)
      }).catch(() => {})
      queued.set(k, p)
      return p
    }

    status.value = 'playing'

    try {
      for (let k = 0; k < chunks.length; k++) {
        if (my !== token) return
        const chunk = chunks[k]

        /*
         * The playhead enters the chunk at its first sentence; the walk moves
         * it forward while the (now longer) utterance plays.
         */
        stopWalk()
        index.value = chunk.from
        deps.onSentence?.(list[chunk.from], chunk.from)
        walk(chunk)

        speak(k)
        if (lookahead) {
          for (let n = 1; n <= LOOKAHEAD; n++) {
            if (k + n < chunks.length) speak(k + n)
          }
        }

        try {
          await queued.get(k)
        } catch (err) {
          if (my !== token) return
          // Cancellation is the user's own doing (pause / skip / exit).
          if (err instanceof TtsCancelled) return
          // A network voice failing is not a broken phone engine; say so.
          reason.value = err instanceof Error && err.message === 'edge-failed'
            ? 'online-failed'
            : 'engine-init-failed'
          status.value = 'unavailable'
          // Silence the chunk that was queued ahead, if any.
          void e.stop()
          return
        } finally {
          queued.delete(k)
        }
      }

      if (my !== token) return
      index.value = list.length - 1
      status.value = 'ended'
    } finally {
      stopWalk()
    }

    if (my !== token) return
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
    // Bump first: the in-flight chunk must not advance the index.
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
    await cancelPrefetch()
    await engine?.stop()
  }

  /**
   * Re-speak the current sentence, e.g. after the rate or voice changed so the
   * new setting is audible now rather than from the next sentence.
   */
  async function restartCurrent() {
    if (status.value === 'playing') {
      // New voice or pace invalidates the measurement.
      calibratedAtRate = 0
      await run(index.value)
    }
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
    prewarm,
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
