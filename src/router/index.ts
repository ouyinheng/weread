import { createRouter, createWebHistory } from 'vue-router'
import { isTabRoute, tabIndex } from './tabs'

/** Depth used to decide push vs. pop direction. */
export function routeDepth(name: unknown): number {
  const n = String(name || '')
  if (n === 'reader' || n === 'sourceDetail') return 3
  if (n === 'catalog' || n === 'settings' || n === 'sourceList') return 2
  if (n === 'fontSettings') return 3
  return 1
}

const routes = [
  { path: '/', redirect: '/shelf' },
  { path: '/shelf', name: 'shelf', component: () => import('@/views/ShelfView.vue'), meta: { tab: 'shelf' } },
  { path: '/discover', name: 'discover', component: () => import('@/views/DiscoverView.vue'), meta: { tab: 'discover' } },
  { path: '/me', name: 'me', component: () => import('@/views/MeView.vue'), meta: { tab: 'me' } },
  { path: '/reader/:id', name: 'reader', component: () => import('@/views/ReaderView.vue') },
  { path: '/catalog/:id', name: 'catalog', component: () => import('@/views/CatalogView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/settings/font', name: 'fontSettings', component: () => import('@/views/FontSettingsView.vue') },
  { path: '/sources', name: 'sourceList', component: () => import('@/views/SourceListView.vue') },
  // 用 query 传书源 id：id 本身就是一个 URL，放进 path 参数会反复编码。
  { path: '/sources/detail', name: 'sourceDetail', component: () => import('@/views/SourceDetailView.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

/**
 * Decide the transition direction *before* the DOM changes.
 *
 * `<transition>` cannot tell whether a navigation was forward or back on its
 * own. Computing it here means the name is already correct when the leave hook
 * runs — that is what removes the one-frame flicker where the outgoing page
 * animates the wrong way.
 */
router.beforeEach((to, from) => {
  const toTab = isTabRoute(to.name)
  const fromTab = isTabRoute(from.name)

  let name = 'none'
  if (to.name === 'reader') {
    name = 'reader'
  } else if (toTab && fromTab) {
    name = tabIndex(to.name) >= tabIndex(from.name) ? 'tab-forward' : 'tab-back'
  } else {
    const toDepth = routeDepth(to.name)
    const fromDepth = routeDepth(from.name)
    if (toDepth > fromDepth) name = 'push'
    else if (toDepth < fromDepth) name = 'pop'
    else name = toTab ? 'tab-back' : 'none'
  }

  to.meta.transition = name
  return true
})

export default router
