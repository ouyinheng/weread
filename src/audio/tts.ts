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

export interface NativeTtsPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>
  speak(o: { text: string; rate?: number; voice?: string }): Promise<{ utteranceId: string; queued: boolean }>
  stop(): Promise<void>
  getVoices(): Promise<{ voices: TtsVoice[] }>
  addListener(
    event: 'onStart' | 'onDone' | 'onError',
    cb: (d: { utteranceId: string }) => void
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
  stop(): Promise<void>
  addListener(
    event: 'onStart' | 'onDone' | 'onError',
    cb: (d: { utteranceId: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
}

/**
 * Curated online voices.
 *
 * These are the point of the online engine: each one is a neural voice whose
 * pitch is tuned for a kind of story, so a sentence sounds spoken rather than
 * scanned. Four of the nine are male. The id is what gets stored in
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

export interface TtsEngine {
  kind: EngineKind
  reason?: EngineReason
  /** Resolves when the utterance has finished playing. */
  speak(text: string, rate: number, voice?: string): Promise<void>
  /** Stops immediately; any in-flight `speak()` rejects as cancelled. */
  stop(): Promise<void>
  voices(): Promise<TtsVoice[]>
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
    voices() {
      return Promise.resolve([])
    },
  }
}

async function nativeEngine(plugin: NativeTtsPlugin): Promise<TtsEngine> {
  /** utteranceId → settle hooks for the sentence currently being spoken. */
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()

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

  return {
    kind: 'native',
    async speak(text, rate, voice) {
      const { utteranceId, queued } = await plugin.speak({ text, rate, voice })
      if (!queued) throw new Error('tts-rejected')
      await new Promise<void>((resolve, reject) => {
        pending.set(utteranceId, { resolve, reject })
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
    speak(text, rate, voice) {
      return new Promise<void>((resolve, reject) => {
        const utter = new SpeechSynthesisUtterance(text)
        utter.lang = 'zh-CN'
        utter.rate = rate
        if (voice) {
          const match = (synth.getVoices() || []).find(v => v.name === voice)
          if (match) utter.voice = match
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
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()

  const settle = (id: string, ok: boolean) => {
    const hooks = pending.get(id)
    if (!hooks) return
    pending.delete(id)
    if (ok) hooks.resolve()
    else hooks.reject(new Error('edge-failed'))
  }

  await plugin.addListener('onDone', ({ utteranceId }) => settle(utteranceId, true))
  await plugin.addListener('onError', ({ utteranceId }) => settle(utteranceId, false))

  return {
    kind: 'native',
    async speak(text, rate, voice) {
      const curated = EDGE_VOICES.find(v => v.id === voice) || EDGE_VOICES[0]
      const { utteranceId, queued } = await plugin.speak({
        text,
        rate,
        voice: curated.voice,
        pitch: curated.pitch,
      })
      if (!queued) throw new Error('edge-failed')
      await new Promise<void>((resolve, reject) => {
        pending.set(utteranceId, { resolve, reject })
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
    speak(text, rate, voice) {
      if (isOnline(voice)) return edge.speak(text, rate, voice)
      if (system.kind === 'none') return edge.speak(text, rate, EDGE_VOICES[0].id)
      return system.speak(text, rate, voice)
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
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const status = await plugin.isAvailable()
      if (status.available) return nativeEngine(plugin)
      if (status.reason !== 'engine-not-ready') {
        return noneEngine((status.reason as EngineReason) || 'no-engine')
      }
    } catch {
      return noneEngine('no-engine')
    }
    await new Promise(r => setTimeout(r, 150))
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
 * start can legitimately answer `engine-not-ready`. Poll for ~1.2s before
 * declaring it broken — that is faster than the engine's worst case but long
 * enough to cover a warm cache.
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
