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
 */
import { computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsStore, useAppSettingsStore } from './stores'
import TabBar from './components/TabBar.vue'
import ImportOverlay from './components/ImportOverlay.vue'
import DialogHost from './components/DialogHost.vue'
import { applyStatusBarStyle, isNativeShell } from './utils/native'
import { isTabRoute } from './router/tabs'
import { uiState } from './utils/ui-state'

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

/** Pages that draw their own full-bleed background instead of the app canvas. */
const isFullBleed = computed(() => String(route.name || '') === 'reader')

/** Only tab pages are cached; detail pages should re-read fresh data. */
const keepAliveNames = ['shelf', 'discover', 'me']

/**
 * Read straight from the guard's decision. Fall back to `none` for the very
 * first render, where there is no previous route to animate from.
 */
const transitionName = computed(() => String(route.meta.transition || 'none'))

/* ---------- theme + native chrome ---------- */
const isDarkTheme = computed(() => settings.settings.theme === 'black')

function syncDocumentTheme() {
  document.documentElement.setAttribute('data-theme', settings.settings.theme)
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
  syncDocumentTheme()
  syncNativeChrome()
})

/* Follow the OS colour scheme when the user asks for it. */
const darkMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
function onSchemeChange() {
  if (!appSettings.app.followSystemTheme) return
  document.documentElement.setAttribute(
    'data-theme',
    darkMedia?.matches ? 'black' : settings.settings.theme
  )
  syncNativeChrome()
}
onMounted(() => darkMedia?.addEventListener?.('change', onSchemeChange))
onBeforeUnmount(() => darkMedia?.removeEventListener?.('change', onSchemeChange))

watch(() => settings.settings.theme, () => {
  syncDocumentTheme()
  syncNativeChrome()
})

watch(() => appSettings.app.followSystemTheme, (follow) => {
  if (follow) onSchemeChange()
  else syncDocumentTheme()
})

watch(() => route.fullPath, syncNativeChrome, { flush: 'post' })

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
    <ImportOverlay />
    <DialogHost />
  </div>
</template>

<style>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
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
