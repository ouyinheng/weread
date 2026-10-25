import { useListenPlayer } from '../src/audio/player.ts'
import { segmentText } from '../src/audio/segmenter.ts'
import { TtsCancelled } from '../src/audio/tts.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/** Let queued promises settle. */
const tick = () => new Promise(r => setTimeout(r, 0))

/**
 * A speech engine whose utterances finish only when the test says so. This is
 * the whole point of injecting the engine: the state machine's job is deciding
 * *which* sentence to speak and when, and that must be verifiable without a
 * phone.
 */
function fakeEngine() {
  const spoken = []
  let pending = null
  return {
    spoken,
    engine: {
      kind: 'native',
      async speak(text) {
        spoken.push(text)
        await new Promise((resolve, reject) => { pending = { resolve, reject } })
      },
      async stop() {
        if (pending) {
          const p = pending
          pending = null
          p.reject(new TtsCancelled())
        }
      },
      async voices() { return [] },
    },
    /** Finish the sentence currently being spoken. */
    release() {
      if (pending) {
        const p = pending
        pending = null
        p.resolve()
      }
    },
    busy: () => pending !== null,
  }
}

const sentences = segmentText('第一句。第二句。第三句。')
const baseSettings = { rate: 1, voice: '', autoNextChapter: false }

/* ---------- sequential playback ---------- */
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
  void player.play(0)
  await tick()
  check('status playing', player.status.value === 'playing', player.status.value)
  check('starts at 0', player.index.value === 0 && seen[0] === 0, JSON.stringify(seen))
  check('spoke first sentence', fake.spoken[0] === '第一句。', fake.spoken[0])

  fake.release(); await tick()
  check('advanced to 1', player.index.value === 1, player.index.value)
  fake.release(); await tick()
  fake.release(); await tick()

  check('spoke all three', fake.spoken.length === 3, JSON.stringify(fake.spoken))
  check('each sentence once', seen.join(',') === '0,1,2', JSON.stringify(seen))
  check('ended after last', player.status.value === 'ended', player.status.value)
}

/* ---------- queuing engines get one sentence of lookahead ---------- */
{
  const spoken = []
  const pending = []
  const engine = {
    kind: 'native',
    canLookahead: () => true,
    async speak(text) {
      spoken.push(text)
      await new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
    },
    async stop() {
      const list = pending.splice(0)
      for (const p of list) p.reject(new TtsCancelled())
    },
    async voices() { return [] },
  }
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => engine,
  })

  void player.play(0)
  await tick()
  check(
    'queues the next sentence while the first is still playing',
    spoken.length === 2 && spoken[1] === '第二句。',
    JSON.stringify(spoken)
  )
  check('highlight stays on the sentence being spoken', player.index.value === 0, player.index.value)

  pending.shift().resolve(); await tick()
  check('advanced once the first finished', player.index.value === 1, player.index.value)
  check('queued a third while the second plays', spoken[2] === '第三句。', JSON.stringify(spoken))
}

/* ---------- pause keeps the sentence, resume speaks it again ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  fake.release(); await tick()          // sentence 0 done, 1 speaking
  check('now on sentence 1', player.index.value === 1, player.index.value)

  await player.pause()
  check('status paused', player.status.value === 'paused', player.status.value)
  check('pause left index alone', player.index.value === 1, player.index.value)

  // `play` resolves when the chapter ends, so it is never awaited here.
  void player.play(player.index.value)
  await tick()
  check('resumed on the same sentence', player.index.value === 1, player.index.value)
  check('re-spoke sentence 1', fake.spoken.at(-1) === '第二句。', fake.spoken.at(-1))
}

/* ---------- a cancelled sentence cannot advance the index ---------- */
{
  const fake = fakeEngine()
  const player = useListenPlayer({
    sentences: () => sentences,
    settings: () => baseSettings,
    createEngine: async () => fake.engine,
  })

  void player.play(0)
  await tick()
  await player.stop()                    // cancels mid-sentence
  await tick()
  check('stop resets index', player.index.value === 0, player.index.value)
  check('stop sets idle', player.status.value === 'idle', player.status.value)
  check('no further sentences spoken', fake.spoken.length === 1, fake.spoken.length)
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
  fake.release(); await tick()
  fake.release(); await tick()
  fake.release(); await tick()
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
  fake.release(); await tick()
  fake.release(); await tick()
  fake.release(); await tick()
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
  check('seek speaks the target', fake.spoken.at(-1) === '第三句。', fake.spoken.at(-1))

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
  check('spoke the right sentence', fake.spoken[0] === '第二句。', fake.spoken[0])
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
