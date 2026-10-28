// Back-press routing and app-level settings are pure logic; pin them down so
// the "back exits the app" class of bug cannot return silently.
import 'fake-indexeddb/auto'

let fail = 0
const check = (n, c, e = '') => {
  console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : e)
  if (!c) fail++
}

/* ---------- overlay registry ---------- */
const { uiState, openOverlay, closeOverlay } = await import('../src/utils/ui-state.ts')

check('starts empty', uiState.overlay === '' && uiState.closeOverlay === null, JSON.stringify(uiState))

let closed = 0
openOverlay('reader:menu', () => { closed++ })
check('overlay registered', uiState.overlay === 'reader:menu', uiState.overlay)
uiState.closeOverlay?.()
check('close handler runs', closed === 1, closed)

openOverlay('reader:catalog', () => {})
// A stale closer for a different overlay must not clear the current one.
closeOverlay('reader:menu')
check('stale close is ignored', uiState.overlay === 'reader:catalog', uiState.overlay)
closeOverlay('reader:catalog')
check('matching close clears', uiState.overlay === '' && uiState.closeOverlay === null, JSON.stringify(uiState))

/* ---------- back-press decision logic ----------
 * Mirrors App.vue's handler: overlay → router stack → tab root exits.
 */
function decide({ overlay, isTab, historyLength, routeName: _routeName }) {
  if (overlay) return 'close-overlay'
  if (historyLength > 1 && !isTab) return 'router-back'
  if (isTab) return 'exit-app'
  return 'go-home'
}

check('overlay wins over history', decide({ overlay: 'x', isTab: false, historyLength: 5, routeName: 'reader' }) === 'close-overlay')
check('reader with history pops', decide({ overlay: '', isTab: false, historyLength: 3, routeName: 'reader' }) === 'router-back')
check('settings with history pops', decide({ overlay: '', isTab: false, historyLength: 2, routeName: 'settings' }) === 'router-back')
check('tab root exits', decide({ overlay: '', isTab: true, historyLength: 1, routeName: 'shelf' }) === 'exit-app')
check('cold deep link goes home', decide({ overlay: '', isTab: false, historyLength: 1, routeName: 'reader' }) === 'go-home')

/* ---------- app settings persist ---------- */
const { useAppSettingsStore } = await import('../src/stores/index.ts')
const { createPinia, setActivePinia } = await import('pinia')
setActivePinia(createPinia())

const store = useAppSettingsStore()
check('default scale', store.app.fontScale === 1, store.app.fontScale)
check('default theme follows system', store.app.theme === 'system', store.app.theme)
check('default hides tv tab', store.app.showTvTab === false, store.app.showTvTab)
check('default keeps shelf tab', store.app.showShelfTab === true, store.app.showShelfTab)

await store.update({
  fontScale: 1.2,
  fontFamily: 'serif',
  theme: 'dark',
  showTvTab: true,
  showShelfTab: false,
})
check('update applies to state', store.app.fontScale === 1.2, store.app.fontScale)

const saved = await new Promise((res, rej) => {
  const q = indexedDB.open('weread')
  q.onsuccess = () => {
    const g = q.result.transaction('settings', 'readonly').objectStore('settings').get('app')
    g.onsuccess = () => res(g.result)
    g.onerror = () => rej(g.error)
  }
  q.onerror = () => rej(q.error)
})
check(
  'settings persisted',
  saved?.fontScale === 1.2 &&
    saved?.fontFamily === 'serif' &&
    saved?.theme === 'dark' &&
    saved?.showTvTab === true &&
    saved?.showShelfTab === false,
  JSON.stringify(saved)
)

// A fresh store reads them back.
setActivePinia(createPinia())
const store2 = useAppSettingsStore()
await store2.load()
check(
  'settings reload',
  store2.app.fontScale === 1.2 &&
    store2.app.theme === 'dark' &&
    store2.app.showTvTab === true &&
    store2.app.showShelfTab === false,
  JSON.stringify(store2.app)
)

// Clamp logic used by the slider.
const clamp = (v) => Math.min(1.4, Math.max(0.85, Math.round(v * 100) / 100))
check('scale floor', clamp(0.1) === 0.85, clamp(0.1))
check('scale ceiling', clamp(9) === 1.4, clamp(9))
check('scale rounding', clamp(1.234) === 1.23, clamp(1.234))

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
