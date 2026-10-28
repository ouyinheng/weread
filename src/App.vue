<script setup lang="ts">
/**
 * App shell.
 *
 * Owns the pieces that must survive navigation:
 *  - the persistent tab bar (it used to live inside each view, so every switch
 *    unmounted and rebuilt it — that was the tab flicker)
 *  - `<KeepAlive>` for tab pages, so switching costs one transition instead of
 *    a full re-mount plus IndexedDB reload
 *  - the transition direction, computed by the router guard and read from
 *    `route.meta.transition`
 *  - status bar / tab bar colour, sampled from the active page surface
 *  - the floating 听书 control, which belongs to the *session*, not to the
 *    reader: listening continues when you go back to 书架, so its control has
 *    to be on every page too.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsStore, useAppSettingsStore } from './stores'
import { useSourceStore } from './stores/source'
import TabBar from './components/TabBar.vue'
import ListenBar from './components/reader/ListenBar.vue'
import ImportOverlay from './components/ImportOverlay.vue'
import DialogHost from './components/DialogHost.vue'
import { applyStatusBarBackground, applyStatusBarStyle, isNativeShell } from './utils/native'
import { homeTab, isTabRoute, visibleTabs } from './router/tabs'
import { uiState } from './utils/ui-state'
import { listenSession } from './audio/session'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const appSettings = useAppSettingsStore()

/**
 * The tab bar belongs to the tab shell only. Pushed pages (settings, catalog)
 * and the reader are full-screen destinations: showing a tab bar under them
 * would offer a lateral escape mid-flow that native apps do not have.
 */
const showsTabBar = computed(() => isTabRoute(route.name) && !uiState.hideTabBar)

/** The video player owns a full-bleed black stage; the page under it is ordinary app chrome. */
const isTvPlayer = computed(() => String(route.name || '') === 'tvPlay')

/** Pages that draw their own full-bleed background instead of the app canvas. */
const isFullBleed = computed(() => String(route.name || '') === 'reader' || isTvPlayer.value)

/** Only tab pages are cached; detail pages should re-read fresh data. */
const keepAliveNames = ['shelf', 'tv', 'me']

/* ---------- 听书 mini control ---------- */
/**
 * Visible on every page while a session is live — 书架 / 影视 / 我 / 设置 都不例外.
 * The one exception is the reader's own full-screen 听书 page: it *is* the
 * control surface, and a floating bar on top of it would cover its buttons.
 */
const showsListenBar = computed(() => {
  if (!listenSession.active.value) return false
  const onOwnReader =
    route.name === 'reader' &&
    String(route.params.id || '') === listenSession.bookId.value
  return !(onOwnReader && listenSession.expanded.value)
})

const listenStatus = computed(() => listenSession.status.value)
const listenCover = computed(() => listenSession.cover.value)
const listenTimerLeft = computed(() => listenSession.timerLeft.value)

function toggleListen() {
  void listenSession.toggle()
}

function closeListen() {
  void listenSession.stop()
}

/**
 * Expand the session. Inside the reader of the same book that is a local state
 * change; anywhere else it navigates back into that book's 听书 page, at the
 * chapter the voice is on — not at the book's saved position, which may lag a
 * chapter behind during auto-advance.
 */
async function expandListen() {
  const onOwnReader =
    route.name === 'reader' && String(route.params.id || '') === listenSession.bookId.value
  if (onOwnReader) {
    listenSession.expand()
    return
  }
  if (!listenSession.bookId.value) return
  await router.push({
    name: 'reader',
    params: { id: listenSession.bookId.value },
    query: { listen: '1', chapter: String(listenSession.chapterIndex.value) },
  })
}

/**
 * Read straight from the guard's decision. Fall back to `none` for the very
 * first render, where there is no previous route to animate from.
 */
const transitionName = computed(() => String(route.meta.transition || 'none'))

/* ---------- theme + native chrome ---------- */
/**
 * 阅读主题只属于阅读页：书架、搜索、设置等页面跟随应用自己的浅色/跟随系统
 * 设置，不再因为换阅读背景而整屏变色。
 */
const darkMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
const systemDark = ref(!!darkMedia?.matches)
const appTheme = computed(() => {
  if (appSettings.app.theme === 'dark') return 'black'
  if (appSettings.app.theme === 'light') return 'white'
  return systemDark.value ? 'black' : 'white'
})
const activeTheme = computed(() => {
  // 播放页跟应用主题，不吃阅读页的纸张色：视频舞台是黑的，但下方
  // 信息区（标题/标签/选集）是普通页面，参考图里就是白底。
  if (isTvPlayer.value) return appTheme.value
  return isFullBleed.value ? settings.settings.theme : appTheme.value
})
const isDarkTheme = computed(() => activeTheme.value === 'black')

function syncDocumentTheme() {
  document.documentElement.setAttribute('data-theme', activeTheme.value)
  // Tells the WebView to render form controls / scrollbars to match.
  document.documentElement.style.colorScheme = isDarkTheme.value ? 'dark' : 'light'
}

/**
 * Status bar colour = the *content* surface, not the page canvas.
 *
 * WeRead paints the strip above the list with the same colour as the white
 * cards, so the top of the screen reads as content rather than chrome. The tab
 * bar is the opposite: white against the grey canvas.
 */
const pageSurfaceVar = computed(() => {
  // The reader is full-bleed: its strip must match the reading background
  // (white / sepia / green / black), otherwise a band appears above the text.
  if (isFullBleed.value) return '--bg'
  return '--bg-panel'
})

function cssVarValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function syncNativeChrome() {
  const dark = isDarkTheme.value
  applyStatusBarStyle({ dark })
  // 系统栏底色跟着页面走；否则深色页顶部会留一条白带（图标也是白的）。
  const surface = cssVarValue(pageSurfaceVar.value)
  if (surface) void applyStatusBarBackground(surface)

  // Keep the browser/Android task-switcher colour in sync with the page.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const surface = cssVarValue(pageSurfaceVar.value)
    if (surface) meta.setAttribute('content', surface)
  }

  // Expose the resolved surface to CSS (the tab bar uses it directly).
  document.documentElement.style.setProperty('--page-surface', `var(${pageSurfaceVar.value})`)
}

onMounted(async () => {
  // App-level appearance first: it changes the chrome's font before first paint.
  await appSettings.load()
  await settings.loadSettings()
  // 读书源并读回总开关；失败不阻塞首屏（存储异常时会话仍可读本地书）。
  try { await useSourceStore().load() } catch { /* 书源不可用时按本地库运行 */ }
  syncDocumentTheme()
  syncNativeChrome()
})

/* Follow the OS colour scheme when the user asks for it. */
function onSchemeChange() {
  systemDark.value = !!darkMedia?.matches
  syncDocumentTheme()
  syncNativeChrome()
}
onMounted(() => darkMedia?.addEventListener?.('change', onSchemeChange))
onBeforeUnmount(() => darkMedia?.removeEventListener?.('change', onSchemeChange))

watch(
  [() => settings.settings.theme, () => route.name, () => appSettings.app.theme],
  () => {
    syncDocumentTheme()
    syncNativeChrome()
  }
)

watch(() => route.fullPath, syncNativeChrome, { flush: 'post' })

/*
 * Both tab roots can be hidden from 系统设置. If the active route is a tab the
 * user just turned off — or a cold deep link to one — fall back to the first
 * tab still in the bar, so the page never shows a bar with no selected tab.
 */
watch(
  [
    () => appSettings.loaded,
    () => appSettings.app.showShelfTab,
    () => appSettings.app.showTvTab,
    () => route.name,
  ],
  () => {
    if (!appSettings.loaded) return
    const visibility = {
      showShelfTab: appSettings.app.showShelfTab,
      showTvTab: appSettings.app.showTvTab,
    }
    const shown = visibleTabs(visibility).map(tab => tab.name as string)
    if (isTabRoute(route.name) && !shown.includes(String(route.name))) {
      void router.replace({ name: homeTab(visibility) })
    }
  }
)

/*
 * Re-read the system bars when the app comes back to the foreground: the
 * status bar can have been hidden by another app or by immersive mode, and the
 * insets we cached are then stale. It also covers rotation on Android (the
 * activity keeps the WebView alive through `configChanges`).
 */
function onAppVisible() {
  if (!document.hidden) syncNativeChrome()
}
onMounted(() => document.addEventListener('visibilitychange', onAppVisible))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onAppVisible))

/* ---------- back navigation ---------- */
/**
 * **Web**: the browser owns history. We never intercept it; tab switches use
 * `replace`, so the browser back button leaves the app instead of replaying
 * every tab the user visited.
 *
 * **Native (Android)**: back must behave like a native app —
 *   1. an open overlay closes first (menu → panel → sheet)
 *   2. otherwise pop the router stack if there is anything to pop
 *   3. only at a tab root with nothing to pop does the app background itself
 *
 * Step 3 is the only place `exitApp` runs.
 *
 * The earlier implementation never fired at all: `@capacitor/app` was not a
 * dependency, so `Plugins.App` was undefined, the handler returned early, and
 * Android closed the Activity on every back press. That is the "back exits the
 * app" bug.
 */
let removeBackListener: (() => void) | null = null

function setupBackHandler() {
  if (!isNativeShell()) return
  const app = (window as unknown as { Capacitor?: { Plugins?: Record<string, any> } })
    .Capacitor?.Plugins?.App
  if (!app?.addListener) return

  const handle = app.addListener('backButton', () => {
    // 1. An open overlay owns the first press.
    if (uiState.overlay) {
      uiState.closeOverlay?.()
      return
    }

    // 2. Router stack: pop when there is something behind us.
    if (window.history.length > 1 && !isTabRoute(route.name)) {
      router.back()
      return
    }

    // 3. Tab root with an empty stack: the app may background itself.
    if (isTabRoute(route.name)) {
      app.exitApp?.()
      return
    }

    // Deep-linked into a sub-page cold: go home instead of quitting.
    router.replace({ name: 'shelf' })
  })

  removeBackListener = () => {
    Promise.resolve(handle).then(h => h?.remove?.()).catch(() => {})
  }
}

onMounted(setupBackHandler)

onBeforeUnmount(() => {
  removeBackListener?.()
})
</script>

<template>
  <div class="app" :class="{ 'app--fullscreen': isFullBleed }">
    <div class="app__viewport">
      <router-view v-slot="{ Component }">
        <!--
          No `mode="out-in"`: with it, the outgoing page finishes leaving before
          the incoming one starts, so the viewport shows the canvas for 1-2
          frames — the flash users reported. Running both transitions at once
          keeps something painted at every moment.
        -->
        <transition :name="transitionName">
          <keep-alive :include="keepAliveNames">
            <component :is="Component" :key="String(route.name)" />
          </keep-alive>
        </transition>
      </router-view>
    </div>
    <TabBar v-if="showsTabBar" />
    <!-- 听书常驻控件：跟随会话，不跟随页面。 -->
    <ListenBar
      v-if="showsListenBar"
      :status="listenStatus"
      :cover="listenCover"
      :timer-left="listenTimerLeft"
      @toggle="toggleListen"
      @expand="expandListen"
      @close="closeListen"
    />
    <ImportOverlay />
    <DialogHost />
  </div>
</template>

<style>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  /*
   * 整屏内容让开左右切边。竖屏是 0，横屏（刘海/挖孔在侧边）才生效；
   * 阅读页和播放页宁可两侧留一点黑，也不让工具栏按钮压在挖孔下面。
   */
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  /* Page canvas: WeRead puts white cards on a light grey field. */
  background: var(--page-surface, var(--bg-page));
  transition: background-color var(--page-duration) var(--page-easing);
}

.app__viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  /* The single source of the page colour during a transition, so the fading
     pages themselves can stay transparent. */
  background: var(--page-surface, var(--bg-page));
  transition: background-color var(--page-duration) var(--page-easing);
}

.app__viewport > * {
  height: 100%;
}

/* Routed pages stack during a transition instead of displacing each other. */
.app__viewport > .tab-page {
  position: absolute;
  inset: 0;
}
</style>
