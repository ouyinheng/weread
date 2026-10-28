import { createRouter, createWebHistory } from 'vue-router'
import { isTabRoute, tabIndex } from './tabs'

/** Depth used to decide push vs. pop direction. */
export function routeDepth(name: unknown): number {
  const n = String(name || '')
  if (n === 'reader' || n === 'sourceDetail' || n === 'tvDetail' || n === 'tvPlay') return 3
  if (n === 'catalog' || n === 'settings' || n === 'sourceList' || n === 'search' || n === 'tvSearch' || n === 'tvSources' || n === 'tvHistory') return 2
  if (n === 'fontSettings') return 3
  return 1
}

const routes = [
  { path: '/', redirect: '/shelf' },
  { path: '/shelf', name: 'shelf', component: () => import('@/views/ShelfView.vue'), meta: { tab: 'shelf' } },
  { path: '/tv', name: 'tv', component: () => import('@/views/tv/TvHomeView.vue'), meta: { tab: 'tv' } },
  { path: '/tv/search', name: 'tvSearch', component: () => import('@/views/tv/TvSearchView.vue') },
  { path: '/tv/detail', name: 'tvDetail', component: () => import('@/views/tv/TvDetailView.vue') },
  { path: '/tv/play', name: 'tvPlay', component: () => import('@/views/tv/TvPlayerView.vue') },
  { path: '/tv/sources', name: 'tvSources', component: () => import('@/views/tv/TvSourcesView.vue') },
  { path: '/tv/history', name: 'tvHistory', component: () => import('@/views/tv/TvHistoryView.vue') },
  { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
  // 发现页暂时下线，旧链接统一落到搜索页。
  { path: '/discover', redirect: '/search' },
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
