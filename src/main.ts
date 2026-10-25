import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import { migrateToSqliteInBackground } from './utils/storage/migrate'
import './styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

/**
 * Ask the platform to keep our database instead of evicting it when the disk
 * fills up. One call, no permission prompt on Android WebView for an installed
 * app; browsers that do not support it simply return undefined.
 */
void navigator.storage?.persist?.()?.catch(() => { /* 不支持就算了，不影响阅读 */ })

/**
 * One-time IndexedDB → SQLite copy, off the startup path. It only flips the
 * backend for the next launch, so a failure can never strand the live library.
 */
setTimeout(() => { void migrateToSqliteInBackground() }, 1500)

/**
 * Warm the tab routes before the user taps them.
 *
 * Tab pages are code-split, so the first switch used to stall on a chunk fetch
 * — the outgoing page faded out while the incoming one had not arrived yet,
 * which reads as a flash of empty background. Resolving those chunks right
 * after first paint costs a few KB and removes the only slow switch.
 */
router.isReady().then(() => {
  const warm = () => {
    void import('@/views/ShelfView.vue')
    void import('@/views/MeView.vue')
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm)
  else setTimeout(warm, 200)
})

app.mount('#app')
