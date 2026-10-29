/**
 * Speech engine abstraction.
 *
 * Android WebView has no `window.speechSynthesis` — Google removed the TTS
 * backend from WebView (Chromium #710238) — so the native path is the only one
 * that works on a phone. The web path exists for `vite dev` in a browser; when
 * neither is present the engine reports `none` and the UI says so instead of
 * pretending to play.
 *
 * Every engine normalises to the same contract: `speak()` resolves when that
 * utterance has finished. The native side is event-driven, so this module keeps
 * a map of in-flight utterance ids and settles them on `onDone` / `onError`.
 * That lets the player be a plain `await` loop.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface TtsVoice {
  name: string
  lang: string
  /** True when the voice synthesises on device, i.e. works offline. */
  local: boolean
  /** Human-facing name, used by curated online voices. */
  label?: string
  /** One-line note: gender, timbre or what the voice suits. */
  desc?: string
  /** `edge` marks the server-side emotional voices. */
  provider?: 'edge'
}

/** Payload of every playback event; `duration` is ms, when the engine knows it. */
export interface TtsEvent {
  utteranceId: string
  /** Length of the utterance just started, in ms (online engine only). */
  duration?: number
}

/** Character range the engine is speaking right now, inside the utterance. */
export interface TtsRangeEvent {
  utteranceId: string
  start: number
  end: number
}

export interface NativeTtsPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>
  speak(o: { text: string; rate?: number; voice?: string }): Promise<{ utteranceId: string; queued: boolean }>
  stop(): Promise<void>
  getVoices(): Promise<{ voices: TtsVoice[] }>
  /** Pre-load the voice so the first real sentence starts without a stall. */
  warm?(): Promise<void>
  addListener(
    event: 'onStart' | 'onDone' | 'onError',
    cb: (d: TtsEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'onRange',
    cb: (d: TtsRangeEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
}

export interface NativeEdgeTtsPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>
  speak(o: {
    text: string
    rate?: number
    /** Short engine name, e.g. `zh-CN-YunxiNeural`. */
    voice?: string
    /** Prosody pitch, e.g. `-6Hz`. */
    pitch?: string
  }): Promise<{ utteranceId: string; queued: boolean }>
  /**
   * Synthesise a batch to the plugin's disk cache. Resolves when every item has
   * either landed on disk or failed; progress arrives on `onPrefetchProgress`.
   */
  prefetch(o: {
    items: { text: string }[]
    voice?: string
    pitch?: string
    rate?: number
    /** Echoed back on progress events so stale runs can be ignored. */
    token?: number
  }): Promise<{ ok?: number; failed?: number; cached?: number }>
  cancelPrefetch(): Promise<void>
  stop(): Promise<void>
  addListener(
    event: 'onStart' | 'onDone' | 'onError',
    cb: (d: TtsEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'onPrefetchProgress',
    cb: (d: { token: number; done: number; total: number; failed: number }) => void
  ): Promise<{ remove: () => Promise<void> }>
}

/** Progress report for a chapter being prepared. */
export interface PrefetchProgress {
  done: number
  total: number
}

/**
 * Curated online voices.
 *
 * These are the point of the online engine: each one is a neural voice whose
 * pitch is tuned for a kind of story, so a sentence sounds spoken rather than
 * scanned. Six of the fourteen are male. The id is what gets stored in
 * `ReaderSettings.listenVoice`, and its `edge:` prefix is how the engine router
 * knows to go online.
 */
export interface EdgeVoice {
  id: string
  /** Short name the endpoint expects inside SSML. */
  voice: string
  /** Locale reported to the UI; dialect voices carry their own tag. */
  lang: string
  label: string
  desc: string
  /** Prosody pitch; a small offset changes the character without sounding fake. */
  pitch: string
}

export const EDGE_VOICES: EdgeVoice[] = [
  {
    id: 'edge:zh-CN-YunxiNeural',
    voice: 'zh-CN-YunxiNeural',
    lang: 'zh-CN',
    label: '云希 · 青年男声',
    desc: '温柔自然，适合小说叙事',
    pitch: '-2Hz',
  },
  {
    id: 'edge:zh-CN-YunjianNeural',
    voice: 'zh-CN-YunjianNeural',
    lang: 'zh-CN',
    label: '云健 · 沉稳男声',
    desc: '低沉有力，适合历史武侠',
    pitch: '-6Hz',
  },
  {
    id: 'edge:zh-CN-YunyangNeural',
    voice: 'zh-CN-YunyangNeural',
    lang: 'zh-CN',
    label: '云扬 · 播音男声',
    desc: '清晰专业，适合纪实资讯',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-CN-YunxiaNeural',
    voice: 'zh-CN-YunxiaNeural',
    lang: 'zh-CN',
    label: '云夏 · 少年男声',
    desc: '年轻清亮，适合少年主角',
    pitch: '+8Hz',
  },
  {
    id: 'edge:zh-TW-YunJheNeural',
    voice: 'zh-TW-YunJheNeural',
    lang: 'zh-TW',
    label: '云哲 · 台湾男声',
    desc: '温和书卷气，适合言情散文',
    pitch: '-3Hz',
  },
  {
    id: 'edge:zh-CN-XiaoxiaoNeural',
    voice: 'zh-CN-XiaoxiaoNeural',
    lang: 'zh-CN',
    label: '晓晓 · 情感女声',
    desc: '情绪丰富，适合都市言情',
    pitch: '+2Hz',
  },
  {
    id: 'edge:zh-CN-XiaoyiNeural',
    voice: 'zh-CN-XiaoyiNeural',
    lang: 'zh-CN',
    label: '晓伊 · 温柔女声',
    desc: '轻柔软糯，适合日常治愈',
    pitch: '+4Hz',
  },
  {
    id: 'edge:zh-CN-liaoning-XiaobeiNeural',
    voice: 'zh-CN-liaoning-XiaobeiNeural',
    lang: 'zh-CN-liaoning',
    label: '晓北 · 东北女声',
    desc: '接地气有喜感，适合市井乡村',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-CN-shaanxi-XiaoniNeural',
    voice: 'zh-CN-shaanxi-XiaoniNeural',
    lang: 'zh-CN-shaanxi',
    label: '晓妮 · 陕西女声',
    desc: '方言味浓，适合乡土题材',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-TW-HsiaoChenNeural',
    voice: 'zh-TW-HsiaoChenNeural',
    lang: 'zh-TW',
    label: '晓臻 · 台湾女声',
    desc: '细柔台湾腔，适合轻小说',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-TW-HsiaoYuNeural',
    voice: 'zh-TW-HsiaoYuNeural',
    lang: 'zh-TW',
    label: '晓雨 · 台湾女声',
    desc: '清亮台湾腔，适合校园故事',
    pitch: '+2Hz',
  },
  {
    id: 'edge:zh-HK-HiuMaanNeural',
    voice: 'zh-HK-HiuMaanNeural',
    lang: 'zh-HK',
    label: '晓曼 · 粤语女声',
    desc: '粤语发音，适合粤语内容',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-HK-HiuGaaiNeural',
    voice: 'zh-HK-HiuGaaiNeural',
    lang: 'zh-HK',
    label: '晓佳 · 粤语女声',
    desc: '粤语发音，适合粤语内容',
    pitch: '+0Hz',
  },
  {
    id: 'edge:zh-HK-WanLungNeural',
    voice: 'zh-HK-WanLungNeural',
    lang: 'zh-HK',
    label: '云龙 · 粤语男声',
    desc: '粤语发音，适合粤语内容',
    pitch: '-2Hz',
  },
]

/** Display name for a stored voice id, falling back to the raw engine name. */
export function voiceLabel(id: string): string {
  return EDGE_VOICES.find(v => v.id === id)?.label ?? id
}

function edgeVoices(): TtsVoice[] {
  return EDGE_VOICES.map(v => ({
    name: v.id,
    lang: v.lang,
    local: false,
    label: v.label,
    desc: v.desc,
    provider: 'edge' as const,
  }))
}

export type EngineKind = 'native' | 'web' | 'none'

export type EngineReason =
  | 'no-engine'
  | 'no-chinese-voice'
  | 'engine-not-ready'
  | 'engine-init-failed'
  | 'online-failed'

/**
 * Per-utterance subscription.
 *
 * `onStart` fires when audio actually begins — that is the only reliable
 * "now" reference for walking the highlight through a multi-sentence chunk.
 * `onRange` is the exact answer where the engine provides one; the player
 * falls back to a calibrated estimate when it does not.
 */
export interface SpeakHooks {
  onStart?(info: { duration?: number }): void
  onRange?(start: number, end: number): void
}

export interface TtsEngine {
  kind: EngineKind
  reason?: EngineReason
  /**
   * True when `speak()` queues behind the current utterance instead of
   * replacing it. The player then sends one sentence ahead so the engine can
   * synthesise it while the previous one is still playing.
   */
  canLookahead?(voice?: string): boolean
  /** Resolves when the utterance has finished playing. */
  speak(text: string, rate: number, voice?: string, hooks?: SpeakHooks): Promise<void>
  /** Stops immediately; any in-flight `speak()` rejects as cancelled. */
  stop(): Promise<void>
  voices(): Promise<TtsVoice[]>
  /**
   * Pre-load whatever the first sentence would otherwise wait for (voice data,
   * audio pipeline). Best-effort and silent; called before playback starts so
   * the wait overlaps with loading the chapter instead of following a tap.
   */
  warm?(): void
  /**
   * True when this voice can be synthesised to disk before playback. Only the
   * online engine can: on-device engines have no way to render audio to a file
   * through this plugin, and the web engine is a dev-only fallback.
   */
  canPrefetch?(voice?: string): boolean
  /**
   * Prepare sentences for playback. Resolves when they are on disk (or failed);
   * `onProgress` reports how many are done so the UI can show the wait.
   */
  prefetch?(
    items: string[],
    rate: number,
    voice: string | undefined,
    onProgress: (done: number, total: number) => void,
    token: number
  ): Promise<{ ok: number; failed: number }>
  /** Abandon a preparation in flight (pause / leave / chapter change). */
  cancelPrefetch?(): Promise<void>
}

/** Cancellation is not a failure — the player checks this to stay quiet. */
export const CANCELLED = 'tts-cancelled'

export class TtsCancelled extends Error {
  constructor() {
    super(CANCELLED)
    this.name = 'TtsCancelled'
  }
}

function noneEngine(reason: EngineReason): TtsEngine {
  return {
    kind: 'none',
    reason,
    speak() {
      return Promise.reject(new Error(reason))
    },
    stop() {
      return Promise.resolve()
    },
    canLookahead() {
      return false
    },
    voices() {
      return Promise.resolve([])
    },
  }
}

async function nativeEngine(plugin: NativeTtsPlugin): Promise<TtsEngine> {
  /** utteranceId → settle hooks for the sentence currently being spoken. */
  const pending = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void; hooks?: SpeakHooks }
  >()

  const settle = (id: string, ok: boolean) => {
    const hooks = pending.get(id)
    if (!hooks) return
    pending.delete(id)
    if (ok) hooks.resolve()
    else hooks.reject(new Error('tts-error'))
  }

  // Registered up front: a listener attached lazily races the first `speak`.
  await plugin.addListener('onDone', ({ utteranceId }) => settle(utteranceId, true))
  await plugin.addListener('onError', ({ utteranceId }) => settle(utteranceId, false))
  await plugin.addListener('onStart', ({ utteranceId, duration }) => {
    pending.get(utteranceId)?.hooks?.onStart?.({ duration })
  })
  // Word-level ranges (API 26+). Emitted by the engine as it speaks, so the
  // highlight can follow a multi-sentence utterance sentence by sentence.
  try {
    await plugin.addListener('onRange', ({ utteranceId, start, end }) => {
      pending.get(utteranceId)?.hooks?.onRange?.(start, end)
    })
  } catch {
    // Older plugin build without range events: the player estimates instead.
  }

  return {
    kind: 'native',
    // Android queues with QUEUE_ADD, so the next sentence can be prepared while
    // the current one is still playing.
    canLookahead: () => true,
    async speak(text, rate, voice, hooks) {
      const { utteranceId, queued } = await plugin.speak({ text, rate, voice })
      if (!queued) throw new Error('tts-rejected')
      await new Promise<void>((resolve, reject) => {
        pending.set(utteranceId, { resolve, reject, hooks })
      })
    },
    async stop() {
      await plugin.stop()
      /*
       * A flushed utterance never reports onDone, so its waiter would hang the
       * player forever. Settle every outstanding one as cancelled.
       */
      for (const hooks of pending.values()) hooks.reject(new TtsCancelled())
      pending.clear()
    },
    warm() {
      // Silence the engine's cold start: load the voice now, while the chapter
      // text is still being read out of the database.
      void plugin.warm?.().catch(() => undefined)
    },
    async voices() {
      try {
        const { voices } = await plugin.getVoices()
        return voices
      } catch {
        return []
      }
    },
  }
}

function webEngine(): TtsEngine | null {
  if (typeof window === 'undefined') return null
  const synth = window.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return null

  const zhVoices = () =>
    (synth.getVoices() || [])
      .filter(v => (v.lang || '').toLowerCase().startsWith('zh'))
      .map(v => ({ name: v.name, lang: v.lang, local: !!v.localService }))

  return {
    kind: 'web',
    // `speechSynthesis.speak` appends to its own queue.
    canLookahead: () => true,
    speak(text, rate, voice, hooks) {
      return new Promise<void>((resolve, reject) => {
        const utter = new SpeechSynthesisUtterance(text)
        utter.lang = 'zh-CN'
        utter.rate = rate
        if (voice) {
          const match = (synth.getVoices() || []).find(v => v.name === voice)
          if (match) utter.voice = match
        }
        utter.onstart = () => hooks?.onStart?.({})
        utter.onboundary = (e) => {
          if (e.name === 'word' || e.name === 'sentence') hooks?.onRange?.(e.charIndex, e.charIndex + (e.charLength || 0))
        }
        utter.onend = () => resolve()
        utter.onerror = () => reject(new Error('tts-error'))
        synth.speak(utter)
      })
    },
    stop() {
      synth.cancel()
      return Promise.resolve()
    },
    voices() {
      return Promise.resolve(zhVoices())
    },
  }
}

/**
 * Online emotional voices, over the native Edge plugin.
 *
 * Same settle-on-event pattern as the system engine, but a failure is reported
 * as `edge-failed` rather than the generic TTS error: the player turns that
 * into "在线音色合成失败" instead of blaming the phone's speech engine.
 */
async function edgeEngine(plugin: NativeEdgeTtsPlugin): Promise<TtsEngine> {
  const pending = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void; hooks?: SpeakHooks }
  >()
  /** token → the callback that one `prefetch` call is waiting on. */
  const progress = new Map<number, (done: number, total: number) => void>()

  const settle = (id: string, ok: boolean) => {
    const hooks = pending.get(id)
    if (!hooks) return
    pending.delete(id)
    if (ok) hooks.resolve()
    else hooks.reject(new Error('edge-failed'))
  }

  await plugin.addListener('onDone', ({ utteranceId }) => settle(utteranceId, true))
  await plugin.addListener('onError', ({ utteranceId }) => settle(utteranceId, false))
  /*
   * The plugin knows the mp3's exact length once it is prepared, which lets the
   * player place each sentence inside the chunk instead of guessing at a fixed
   * characters-per-second.
   */
  await plugin.addListener('onStart', ({ utteranceId, duration }) => {
    pending.get(utteranceId)?.hooks?.onStart?.({ duration })
  })
  await plugin.addListener('onPrefetchProgress', (d) => {
    progress.get(d.token)?.(d.done ?? 0, d.total ?? 0)
  })

  return {
    kind: 'native',
    // The native side keeps two sentences in flight: the next one synthesises
    // while the current one plays, so the player can ask ahead.
    canLookahead: () => true,
    /*
     * Everything the prefetcher writes is keyed by text+voice+pitch+rate, which
     * is exactly what `speak` looks up, so a prepared chapter plays from disk.
     */
    canPrefetch: () => true,
    async prefetch(items, rate, voice, onProgress, token) {
      const curated = EDGE_VOICES.find(v => v.id === voice) || EDGE_VOICES[0]
      progress.set(token, onProgress)
      try {
        const r = await plugin.prefetch({
          items: items.map(text => ({ text })),
          voice: curated.voice,
          pitch: curated.pitch,
          rate,
          token,
        })
        return { ok: Number(r?.ok) || 0, failed: Number(r?.failed) || 0 }
      } finally {
        progress.delete(token)
      }
    },
    async cancelPrefetch() {
      try {
        await plugin.cancelPrefetch()
      } catch {
        // Nothing was running.
      }
    },
    async speak(text, rate, voice, hooks) {
      const curated = EDGE_VOICES.find(v => v.id === voice) || EDGE_VOICES[0]
      const { utteranceId, queued } = await plugin.speak({
        text,
        rate,
        voice: curated.voice,
        pitch: curated.pitch,
      })
      if (!queued) throw new Error('edge-failed')
      await new Promise<void>((resolve, reject) => {
        pending.set(utteranceId, { resolve, reject, hooks })
      })
    },
    async stop() {
      try {
        await plugin.stop()
      } catch {
        // Nothing to stop on the native side.
      }
      for (const hooks of pending.values()) hooks.reject(new TtsCancelled())
      pending.clear()
    },
    voices() {
      return Promise.resolve(edgeVoices())
    },
  }
}

/**
 * Route per voice: `edge:` ids go online, everything else stays on the phone.
 *
 * The system engine is still the default, so simply opening 听书 never touches
 * the network. When the phone has no Chinese voice pack at all, the online
 * voices keep the feature usable instead of declaring it unavailable.
 */
function compositeEngine(system: TtsEngine, edge: TtsEngine): TtsEngine {
  const isOnline = (voice?: string) => !!voice && EDGE_VOICES.some(v => v.id === voice)

  return {
    kind: 'native',
    canLookahead(voice) {
      // Online voices synthesise ahead on the native queue; on-device voices
      // queue with QUEUE_ADD. Both accept one sentence in advance.
      if (isOnline(voice)) return edge.canLookahead?.(voice) === true
      if (system.kind === 'none') return edge.canLookahead?.(voice) === true
      return system.canLookahead?.(voice) === true
    },
    speak(text, rate, voice, hooks) {
      if (isOnline(voice)) return edge.speak(text, rate, voice, hooks)
      if (system.kind === 'none') return edge.speak(text, rate, EDGE_VOICES[0].id, hooks)
      return system.speak(text, rate, voice, hooks)
    },
    warm() {
      // Warm both: the chosen voice is only known per call, and warming is
      // silent and cheap. The system engine is the one with a real cold start.
      system.warm?.()
    },
    /*
     * Only the online path can be prepared ahead. When the phone's own engine
     * is being used, playback is already a local queue — there is nothing to
     * render to disk, and a loading state would be pure ceremony.
     */
    canPrefetch(voice) {
      const online = isOnline(voice) || system.kind === 'none'
      return online && edge.canPrefetch?.(voice) === true
    },
    prefetch(items, rate, voice, onProgress, token) {
      if (edge.prefetch && (isOnline(voice) || system.kind === 'none')) {
        return edge.prefetch(items, rate, voice, onProgress, token)
      }
      return Promise.resolve({ ok: 0, failed: 0 })
    },
    async cancelPrefetch() {
      await edge.cancelPrefetch?.()
    },
    async stop() {
      await Promise.all([system.stop(), edge.stop()])
    },
    async voices() {
      const [onDevice, online] = await Promise.all([system.voices(), edge.voices()])
      return [...online, ...onDevice]
    },
  }
}

/** Wrap the phone's own engine; unavailable becomes a typed `none` engine. */
async function systemEngine(): Promise<TtsEngine> {
  let plugin: NativeTtsPlugin
  try {
    plugin = registerPlugin<NativeTtsPlugin>('Tts')
  } catch {
    return noneEngine('no-engine')
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const status = await plugin.isAvailable()
      if (status.available) return nativeEngine(plugin)
      if (status.reason !== 'engine-not-ready') {
        return noneEngine((status.reason as EngineReason) || 'no-engine')
      }
    } catch {
      return noneEngine('no-engine')
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return noneEngine('engine-not-ready')
}

/** The online plugin is optional: older builds and `vite dev` do not have it. */
async function onlineEngine(): Promise<TtsEngine | null> {
  let plugin: NativeEdgeTtsPlugin
  try {
    plugin = registerPlugin<NativeEdgeTtsPlugin>('EdgeTts')
    const status = await plugin.isAvailable()
    if (!status.available) return null
    return await edgeEngine(plugin)
  } catch {
    return null
  }
}

/**
 * Pick the best available engine.
 *
 * The native engine initialises asynchronously, so the first call after a cold
 * start can legitimately answer `engine-not-ready`. Poll for ~3s before
 * declaring it broken: giving up early turns a slow-but-fine engine into a
 * "not supported" screen, and the caller warms this up in parallel with loading
 * the chapter so the wait is usually invisible anyway.
 */
export async function createEngine(): Promise<TtsEngine> {
  if (Capacitor.isNativePlatform()) {
    const [system, online] = await Promise.all([systemEngine(), onlineEngine()])
    if (!online) return system
    return system.kind === 'none' ? online : compositeEngine(system, online)
  }

  const web = webEngine()
  return web || noneEngine('no-engine')
}

/** Player-facing copy for a failure reason. */
export function reasonText(reason?: EngineReason): string {
  switch (reason) {
    case 'no-chinese-voice':
      return '手机里没有中文语音包，去系统设置里装一个就能听'
    case 'engine-not-ready':
      return '语音引擎还没准备好，稍后再试'
    case 'engine-init-failed':
      return '语音引擎启动失败，检查系统设置里的文字转语音'
    case 'online-failed':
      return '在线音色合成失败，检查网络后重试，或换一个离线音色'
    default:
      return '这台设备不支持朗读'
  }
}
