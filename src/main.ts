import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

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
    void import('@/views/DiscoverView.vue')
    void import('@/views/MeView.vue')
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm)
  else setTimeout(warm, 200)
})

app.mount('#app')
