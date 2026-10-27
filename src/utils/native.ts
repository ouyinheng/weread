/**
 * Thin wrapper over the native shell.
 *
 * The app ships as both a normal web page and a Capacitor Android build, and
 * the two differ in ways the UI must respect:
 *
 *  - **Status bar**: on Android the system draws it above the WebView; its
 *    icon colour has to be set natively (it cannot be derived from CSS).
 *  - **Back**: Android has a hardware/gesture back that maps to history pop;
 *    the browser also has a back button and a `history` the user can leave.
 *  - **Gestures**: the Android system back-gesture starts from the screen edge,
 *    which collides with an edge-swipe page turn, so the reader must react to
 *    horizontal swipes only once they exceed the system gesture inset.
 *
 * Nothing here throws when the plugin is absent — on the web every call is a
 * no-op and the browser's own behaviour applies.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  Plugins?: Record<string, any>
}

function cap(): CapacitorGlobal | undefined {
  // Unit tests run without a DOM; every native helper must be callable there.
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True inside the Android/iOS shell, false in a plain browser tab. */
export function isNativeShell(): boolean {
  const c = cap()
  if (!c) return false
  if (typeof c.isNativePlatform === 'function') return c.isNativePlatform()
  return c.getPlatform ? c.getPlatform() !== 'web' : false
}

export function platform(): 'android' | 'ios' | 'web' {
  const p = cap()?.getPlatform?.()
  if (p === 'android' || p === 'ios') return p
  return 'web'
}

/**
 * Android system gesture inset (dp). A left-edge swipe within this margin is
 * consumed by the OS back gesture, so the reader must not treat it as a page
 * turn or the two behaviours fight.
 */
export const EDGE_GESTURE_INSET = 20

export interface StatusBarOptions {
  /** Use light icons (for dark backgrounds) or dark icons (light backgrounds). */
  dark: boolean
}

/**
 * The bridge injected by MainActivity (`AndroidSystemBars`).
 *
 * Everything here is optional: on the web the object is absent and each caller
 * falls back to a no-op or a CSS default.
 */
interface SystemBarsBridge {
  setLight?: (light: boolean) => void
  /** 状态栏底色（`#rrggbb`）。页面通过 window 拿到的是 -1 时说明没生效。 */
  setBackground?: (hex: string) => void
  /** JSON `{ top, bottom }` in CSS px (dp), already divided by density. */
  getInsets?: () => string
  /** The device's font-size setting (1 = default). */
  getFontScale?: () => number
  /* ---- 阅读模式（只在阅读页生效，退出时还原） ---- */
  setKeepScreenOn?: (on: boolean) => void
  setLandscapeAllowed?: (allowed: boolean) => void
  setVolumeKeys?: (on: boolean) => void
}

declare global {
  interface Window {
    /**
     * Called by the native shell when a volume key is pressed while the reader
     * has 音量键翻页 switched on. Registered by ReaderView.
     */
    __readerVolumeTurn?: (dir: 'prev' | 'next') => void
  }
}

export interface ReaderNativeMode {
  /** 阅读时不自动锁屏 */
  keepAwake: boolean
  /** 阅读时允许横屏 */
  allowLandscape: boolean
  /** 音量键翻页 */
  volumeKeys: boolean
}

/**
 * Apply the reader's behaviour switches to the native window.
 *
 * These are not page styling: keeping the screen awake, locking the activity
 * orientation and swallowing the volume keys all have to be done in the
 * Activity. On the web every call is a no-op, which is why the settings page
 * labels them as Android-only.
 */
export function applyReaderNativeMode(opts: ReaderNativeMode): void {
  const b = bars()
  if (!b) return
  try {
    b.setKeepScreenOn?.(opts.keepAwake)
    b.setLandscapeAllowed?.(opts.allowLandscape)
    b.setVolumeKeys?.(opts.volumeKeys)
  } catch {
    /* bridge half-injected — leave the activity's own defaults */
  }
}

/** Leaving the reader restores normal window behaviour. */
export function resetReaderNativeMode(): void {
  applyReaderNativeMode({ keepAwake: false, allowLandscape: true, volumeKeys: false })
}

function bars(): SystemBarsBridge | undefined {
  return (window as unknown as { AndroidSystemBars?: SystemBarsBridge }).AndroidSystemBars
}

/**
 * Re-read the window insets after the system bars came back.
 *
 * `--statusbar-height` is pushed into CSS from the native inset read. While a
 * fullscreen view covers the window the bars are hidden and that read is 0, so
 * anything that shows them again has to re-publish the real value — otherwise
 * page headers keep the top padding of a bar-less window.
 */
export function refreshSafeArea(): void {
  if (!isNativeShell()) return
  const insets = nativeInsets()
  setPx('--statusbar-height', insets.top)
  setPx('--nav-inset', insets.bottom)
}

/**
 * System-bar insets in CSS px.
 *
 * The WebView never reports these to CSS (`env(safe-area-inset-top)` is 0 on
 * Android), and since Android 15 / targetSdk 35 the window is drawn edge to
 * edge whether or not we ask, so the page is responsible for keeping its own
 * chrome clear of the clock and the gesture pill.
 */
export function nativeInsets(): { top: number; bottom: number } {
  try {
    const raw = bars()?.getInsets?.()
    if (raw) {
      const parsed = JSON.parse(raw) as { top?: number; bottom?: number }
      const top = Number(parsed.top)
      const bottom = Number(parsed.bottom)
      return {
        top: Number.isFinite(top) && top > 0 ? top : 0,
        bottom: Number.isFinite(bottom) && bottom > 0 ? bottom : 0,
      }
    }
  } catch {
    /* bridge present but returned garbage — fall through */
  }
  return { top: 0, bottom: 0 }
}

/**
 * The device font-size multiplier (Android 「字体大小」).
 *
 * A native app's sp values grow with this setting; a WebView's px values do
 * not, which is why the same screen reads smaller here than in WeRead on a
 * phone whose font size is set to 大. Clamped so a 200% system setting cannot
 * blow the layout apart.
 */
export function systemFontScale(): number {
  if (!isNativeShell()) return 1
  try {
    const raw = Number(bars()?.getFontScale?.())
    if (Number.isFinite(raw) && raw > 0) return Math.min(1.3, Math.max(1, raw))
  } catch {
    /* no bridge — treat as default */
  }
  return 1
}

function setPx(name: string, value: number) {
  document.documentElement.style.setProperty(name, `${value}px`)
}

/**
 * Paint the native status bar to match the current page.
 *
 * Android draws the system bars outside the WebView, so their colour cannot come
 * from CSS. We make both bars transparent and let the page show through, then
 * report their sizes back to CSS as `--statusbar-height` / `--nav-inset` so page
 * headers and the tab bar can keep clear of them. No-op on the web.
 */
/**
 * Paint the status bar with the page's own surface colour.
 *
 * The WebView does not extend under the system bars on every device/OEM combo
 * (this emulator is one), so the strip above the page is the *window*
 * background — white. On a dark page that leaves a white band with white
 * clock/battery icons on it.
 */
export async function applyStatusBarBackground(hex: string): Promise<void> {
  try {
    bars()?.setBackground?.(hex)
  } catch {
    /* bridge not injected */
  }
}

export async function applyStatusBarStyle(opts: StatusBarOptions): Promise<void> {
  // Native bridge installed by MainActivity: flips status + navigation bar icon
  // colours. `light` background ⇒ dark icons. Harmless when absent (web).
  try {
    bars()?.setLight?.(!opts.dark)
  } catch {
    /* bridge not injected */
  }

  if (!isNativeShell()) {
    setPx('--statusbar-height', 0)
    setPx('--nav-inset', 0)
    return
  }

  // Bridge first: it reads the real window insets, which stay correct on
  // Android 15+ where the StatusBar plugin's overlay/colour calls are no-ops.
  let applied = false
  const insets = nativeInsets()
  if (insets.top > 0 || insets.bottom > 0) {
    setPx('--statusbar-height', insets.top)
    setPx('--nav-inset', insets.bottom)
    applied = true
  }

  const style = cap()?.Plugins?.StatusBar
  if (!style) return
  try {
    // Overlay first: the page's own colour must be visible behind the icons.
    await style.setOverlaysWebView?.({ overlay: true })
    await style.setBackgroundColor?.({ color: '#00000000' })
    await style.setStyle?.({ style: opts.dark ? 'DARK' : 'LIGHT' })

    if (applied) return
    const info = await style.getInfo?.()
    const height = Number(info?.height ?? 0)
    if (Number.isFinite(height) && height > 0) setPx('--statusbar-height', height)
  } catch {
    /* plugin missing or version mismatch — the CSS safe-area still applies */
  }
}

/** Haptic tap used for light interaction feedback on native only. */
export function tapFeedback(): void {
  if (!isNativeShell()) return
  const h = cap()?.Plugins?.Haptics
  try {
    h?.impact?.({ style: 'LIGHT' })
  } catch {
    /* optional */
  }
}
