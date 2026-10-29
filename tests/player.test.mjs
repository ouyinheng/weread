import { useListenPlayer } from '../src/audio/player.ts'
import { segmentText } from '../src/audio/segmenter.ts'
import { buildPlan } from '../src/audio/chunker.ts'
import { TtsCancelled } from '../src/audio/tts.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/** Let queued promises settle. */
const tick = () => new Promise(r => setTimeout(r, 0))
const wait = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * A speech engine whose utterances finish only when the test says so. This is
 * the whole point of injecting the engine: the state machine's job is deciding
 * *what* to speak and when, and that must be verifiable without a phone.
 */
function fakeEngine({ lookahead = false } = {}) {
  /** In-flight utterances, oldest first. */
  const live = []
  const spoken = []
  return {
    spoken,
    live,
    engine: {
      kind: 'native',
      canLookahead: () => lookahead,
      async speak(text, _rate, _voice, hooks) {
        spoken.push(text)
        await new Promise((resolve, reject) => { live.push({ text, hooks, resolve, reject }) })
      },
      async stop() {
        for (const x of live.splice(0)) x.reject(new TtsCancelled())
      },
      async voices() { return [] },
    },
    /** The engine starts speaking utterance `i`; `duration` is its real length. */
    start(i = 0, duration) { live[i]?.hooks?.onStart?.({ duration }) },
    /** The engine reports the character it has reached inside utterance `i`. */
    range(i = 0, at) { live[i]?.hooks?.onRange?.(at, at) },
    /** Utterance `i` finishes. */
    release(i = 0) { live.splice(i, 1)[0]?.resolve() },
    queued: () => live.length,
  }
}

const sentences = segmentText('第一句。第二句。第三句。')
const chunkText = buildPlan(sentences)[0].text
const baseSettings = { rate: 1, voice: '', autoNextChapter: false }

/**
 * Thirty short sentences: one short head utterance (so the first word starts
 * fast) followed by full-length ones.
 */
const longSentences = segmentText('这一句很短。'.repeat(30))
const longChunks = buildPlan(longSentences)

/* ---------- a chunk (not a sentence) is what gets spoken ---------- */
{
  const fake = fakeEngine()
  const seen = []
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    onSentence: (_s, i) => seen.push(i),
    createEngine: async () => fake.engine,
  })

  check('sentences available', sentences.length === 3, sentences.length)
  check('a short paragraph is a single utterance', chunkText.includes('\n'), chunkText)
  check('long text splits into a short head plus full chunks',
    longChunks.length === 3 && longChunks[0].to - longChunks[0].from < 10, longChunks.length)

  void player.play(0)
  await tick()
  check('status playing', player.status.value === 'playing', player.status.value)
  check('starts at 0', player.index.value === 0 && seen[0] === 0, JSON.stringify(seen))
  check('speaks the whole chunk in one utterance', fake.spoken[0] === chunkText,
    JSON.stringify(fake.spoken[0]))

  fake.release(0)
  await wait(10)
  check('one utterance ends the chapter', fake.spoken.length === 1, fake.spoken.length)
  check('ended after the last chunk', player.status.value === 'ended', player.status.value)
  check('playhead rests on the last sentence', player.index.value === 2, player.index.value)
}

/* ---------- the highlight walks through the sentences of a chunk ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => longSentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  const chunk = longChunks[0]
  check('first chunk queued', fake.spoken[0] === chunk.text, '')
  check('playhead on the first sentence of the chunk', player.index.value === chunk.from,
    player.index.value)

  // The engine knows its audio is 400 ms long: ~80 ms per sentence.
  fake.start(0, 400)
  await wait(180)
  check('highlight advanced inside the chunk', player.index.value > chunk.from,
    player.index.value)
  check('highlight stayed inside the chunk', player.index.value <= chunk.to, player.index.value)
  await wait(300)
  check('reached the end of the chunk', player.index.value === chunk.to, player.index.value)
}

/* ---------- engine character ranges win over the estimate ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => longSentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  const chunk = longChunks[0]
  // Offset of the very last sentence inside the chunk text.
  fake.range(0, chunk.starts[chunk.to - chunk.from])
  await tick()
  check('range event jumps the highlight to that sentence', player.index.value === chunk.to,
    player.index.value)

  // A late range event for an earlier sentence must not drag it back.
  fake.range(0, 0)
  await tick()
  check('highlight never moves backwards', player.index.value === chunk.to, player.index.value)
}

/* ---------- queuing engines get the next chunks ahead of time ---------- */
{
  const fake = fakeEngine({ lookahead: true })
  const player = useListenPlayer({
    sentences: () => longSentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  check('queues the following chunks while the first plays',
    fake.spoken.length === Math.min(3, longChunks.length)
    && fake.spoken[1] === longChunks[1].text, JSON.stringify(fake.spoken.length))
  check('highlight stays on the chunk being spoken', player.index.value === longChunks[0].from,
    player.index.value)

  fake.release(0)
  await wait(10)
  check('advanced once the first chunk finished', player.index.value === longChunks[1].from,
    player.index.value)
  check('does not re-synthesise what is already queued',
    fake.spoken.length === Math.min(3, longChunks.length), fake.spoken.length)
}

/* ---------- pause keeps the sentence, resume speaks it again ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => longSentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  fake.start(0, 300)
  await wait(180)                        // a few sentences into the chunk
  const at = player.index.value
  check('moved off the first sentence', at > 0, at)

  await player.pause()
  check('status paused', player.status.value === 'paused', player.status.value)
  check('pause left the sentence alone', player.index.value === at, player.index.value)

  fake.spoken.length = 0
  void player.play(player.index.value)   // resolves at chapter end, never awaited
  await tick()
  check('resumed on the same sentence', player.index.value === at, player.index.value)
  check('re-speaks from that sentence, not the chunk start',
    fake.spoken[0]?.startsWith(longSentences[at].text), JSON.stringify(fake.spoken[0]))
}

/* ---------- a cancelled chunk cannot advance the index ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  await player.stop()
  await tick()
  check('stop resets index', player.index.value === 0, player.index.value)
  check('stop sets idle', player.status.value === 'idle', player.status.value)
  check('no further utterances spoken', fake.spoken.length === 1, fake.spoken.length)
}

/* ---------- next / prev step one sentence ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  void player.next(); await tick()
  check('next moves to 1', player.index.value === 1, player.index.value)
  void player.next(); await tick()
  check('next moves to 2', player.index.value === 2, player.index.value)
  void player.next(); await tick()
  check('next clamps at last', player.index.value === 2, player.index.value)
  void player.prev(); await tick()
  check('prev moves back to 1', player.index.value === 1, player.index.value)
}

/* ---------- chapter end ---------- */
{
  const fake = fakeEngine()
  let ended = false
  let advances = 0
  const player = useListenPlayer({
    sentences: () => (ended ? [] : sentences),
    settings: () => ({ ...baseSettings, autoNextChapter: true }),
    createEngine: async () => fake.engine,
    onChapterEnd: () => {
      advances++
      ended = true
      return true
    },
  })

  void player.play(0)
  await tick()
  fake.release(0)
  await tick()
  check('asked for the next chapter', advances === 1, advances)
  check('chapter end stops cleanly', player.status.value === 'ended', player.status.value)
}

/* ---------- autoNextChapter off: no chapter switch ---------- */
{
  const fake = fakeEngine()
  let advances = 0
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,       // autoNextChapter: false
    createEngine: async () => fake.engine,
    onChapterEnd: () => { advances++; return false },
  })

  void player.play(0)
  await tick()
  fake.release(0)
  await tick()
  check('no chapter switch when off', advances === 0, advances)
}

/* ---------- engine missing: honest unavailable state ---------- */
{
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => ({
      kind: 'none',
      reason: 'no-chinese-voice',
      speak: () => Promise.reject(new Error('none')),
      stop: () => Promise.resolve(),
      voices: () => Promise.resolve([]),
    }),
  })

  await player.play(0)
  check('status unavailable', player.status.value === 'unavailable', player.status.value)
  check('reason surfaced', player.reason.value === 'no-chinese-voice', player.reason.value)
}

/* ---------- seek jumps straight to a sentence (progress bar) ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  void player.seek(2)
  await tick()
  check('seek jumps to 2', player.index.value === 2, player.index.value)
  check('seek speaks from that sentence', fake.spoken.at(-1) === '第三句。', fake.spoken.at(-1))

  void player.seek(99)
  await tick()
  check('seek clamps to last', player.index.value === 2, player.index.value)
}

/* ---------- playFromOffset starts at the containing sentence ---------- */
{
  const fake = fakeEngine()
  // Offsets inside the text: sentence 0 = 0..4, sentence 1 = 4..8, sentence 2 = 8..12
  const offsets = [0, 4, 8]
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.playFromOffset(5, offsets)
  await tick()
  check('offset 5 lands on sentence 1', player.index.value === 1, player.index.value)
  check('spoke from the right sentence', fake.spoken[0] === '第二句。\n第三句。', fake.spoken[0])
}

/* ---------- online voice: only the first chunk is waited for ---------- */
{
  const fake = fakeEngine({ lookahead: true })
  /** @type {Array<(done: number, total: number) => void>} */
  const reporters = []
  let finish = null
  const engine = {
    ...fake.engine,
    canPrefetch: () => true,
    prefetch(items, _rate, _voice, onProgress) {
      reporters.push(onProgress)
      return new Promise((resolve) => {
        finish = () => {
          onProgress(items.length, items.length)
          resolve({ ok: items.length, failed: 0 })
        }
      })
    },
    async cancelPrefetch() {},
  }
  const player = useListenPlayer({
    sentences: () => longSentences,
    settings: () => baseSettings,
    createEngine: async () => engine,
  })

  void player.play(0)
  await tick()
  check('shows buffering while the first chunk renders', player.status.value === 'buffering',
    player.status.value)
  check('says nothing before it is ready', fake.spoken.length === 0, fake.spoken.length)
  check('progress starts at zero', player.bufferProgress.value.done === 0,
    JSON.stringify(player.bufferProgress.value))
  check('buffering counts as active', player.active.value)
  check('reports how many chunks there are', player.bufferProgress.value.total === longChunks.length,
    JSON.stringify(player.bufferProgress.value))

  // The first chunk lands; the rest of the chapter is still downloading.
  reporters[0](1, longChunks.length)
  await tick()
  check('starts playing on the first chunk, not the whole chapter',
    player.status.value === 'playing', player.status.value)
  check('speaks the first chunk', fake.spoken[0] === longChunks[0].text,
    JSON.stringify(fake.spoken[0]))

  finish()
  await tick()
  check('still playing after the rest arrives', player.status.value === 'playing',
    player.status.value)
}

/* ---------- pausing during preparation cancels it ---------- */
{
  const fake = fakeEngine()
  let released = false
  let cancels = 0
  const engine = {
    ...fake.engine,
    canPrefetch: () => true,
    prefetch() {
      // Never resolves on its own; `cancelPrefetch` releases it, like the plugin.
      return new Promise((resolve) => {
        engine._resolve = () => { released = true; resolve({ ok: 0, failed: 0 }) }
      })
    },
    async cancelPrefetch() {
      cancels++
      engine._resolve?.()
    },
  }
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => engine,
  })

  void player.play(0)
  await tick()
  await player.pause()
  check('pause cancelled the download', cancels >= 1, cancels)
  await tick()
  check('late preparation does not start playback', fake.spoken.length === 0,
    JSON.stringify(fake.spoken))
  check('stays paused', player.status.value === 'paused', player.status.value)
  check('preparation was released', released)
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
