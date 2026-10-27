/**
 * OS-level "now playing" bridge for 听书.
 *
 * Background playback on Android needs two things the WebView cannot give:
 * a foreground service (so the process is not frozen or killed the moment the
 * user goes home) and a notification the user can pause from. Both live on the
 * native side (`ListenService` / `ListenPlugin`); this module is the thin,
 * failure-tolerant bridge.
 *
 * It is intentionally not an audio player: the sentence loop still runs in JS,
 * queuing utterances through the TTS plugins. The service's only job is to keep
 * that loop alive and to report button presses back as `onToggle` / `onStop`.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface NowPlayingState {
  /** Book title — the notification's headline. */
  title: string
  /** Chapter / sentence line under it. */
  text: string
  playing: boolean
}

export interface NowPlayingPlugin {
  start(o: NowPlayingState): Promise<void>
  update(o: NowPlayingState): Promise<void>
  stop(): Promise<void>
  addListener(
    event: 'onToggle' | 'onStop',
    cb: () => void
  ): Promise<{ remove: () => Promise<void> }>
}

let plugin: NowPlayingPlugin | null = null
let probed = false

function native(): NowPlayingPlugin | null {
  if (!Capacitor.isNativePlatform()) return null
  if (!probed) {
    probed = true
    try {
      plugin = registerPlugin<NowPlayingPlugin>('Listen')
    } catch {
      plugin = null
    }
  }
  return plugin
}

/**
 * Everything here is best-effort: a build without the native plugin, or a
 * phone that refuses the notification permission, must still play audio.
 */
export async function nowPlayingStart(state: NowPlayingState): Promise<void> {
  try {
    await native()?.start(state)
  } catch {
    // No foreground service — playback still works in the foreground.
  }
}

export async function nowPlayingUpdate(state: NowPlayingState): Promise<void> {
  try {
    await native()?.update(state)
  } catch {
    // Ignored: the notification is cosmetic.
  }
}

export async function nowPlayingStop(): Promise<void> {
  try {
    await native()?.stop()
  } catch {
    // Ignored.
  }
}

/** Notification button presses. Returns a no-op disposer when unavailable. */
export async function onNowPlayingAction(
  event: 'onToggle' | 'onStop',
  cb: () => void
): Promise<() => void> {
  const p = native()
  if (!p) return () => {}
  try {
    const handle = await p.addListener(event, cb)
    return () => {
      Promise.resolve(handle.remove?.()).catch(() => {})
    }
  } catch {
    return () => {}
  }
}
