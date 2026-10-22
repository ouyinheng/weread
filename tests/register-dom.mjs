/**
 * Process-level DOM bootstrap.
 *
 * Loaded via `node --import`, this runs *before* vite-node touches any module,
 * so @vue/runtime-dom still sees a real `document` when it is evaluated.
 * (vite-node hoists externalized deps like `vue` into static imports, so a
 * plain import inside the test file is always too late.)
 */
import 'fake-indexeddb/auto'
import { GlobalWindow } from 'happy-dom'

const win = new GlobalWindow({ url: 'http://localhost/' })

const exposed = [
  'document', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'ShadowRoot',
  'ResizeObserver', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'HTMLInputElement', 'HTMLDivElement', 'DOMRect',
  'history', 'location', 'localStorage', 'sessionStorage', 'screen', 'scrollTo',
]
// NOTE: deliberately NOT exposing Event/CustomEvent — Node's own EventTarget
// validates against its internal Event class, and shadowing it breaks the CLI.

globalThis.window = win
for (const key of exposed) {
  if (win[key] !== undefined) globalThis[key] = win[key]
}

// navigator is a getter on Node 22's globalThis — must be redefined, not set.
Object.defineProperty(globalThis, 'navigator', {
  value: win.navigator,
  configurable: true,
  writable: true,
})
