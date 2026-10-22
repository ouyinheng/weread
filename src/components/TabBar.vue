<script setup lang="ts">
/**
 * Persistent bottom tab bar.
 *
 * Lives in App.vue rather than inside each view: when it sat inside the pages,
 * every tab switch unmounted and remounted the bar (icon flash + scroll jump).
 *
 * Icons are inlined SVG whose colour comes from CSS `currentColor`, not from
 * `v-html` strings built per render — rebuilding three SVG trees on every tap
 * was both a flicker source and a needless layout cost.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TABS } from '@/router/tabs'
import Icon from '@/components/Icon.vue'
import type { IconName } from '@/components/icon-names'
import { tapFeedback } from '@/utils/native'

const TAB_ICONS: Record<string, IconName> = {
  discover: 'tab-read',
  shelf: 'tab-shelf',
  me: 'tab-me',
}

const route = useRoute()
const router = useRouter()

const activeName = computed(() => String(route.name || ''))

function isActive(name: string): boolean {
  return activeName.value === name
}

/**
 * `push` would stack a new history entry per tap, so the hardware back button
 * on Android would walk backwards through tabs the user already left.
 * Tab switching is a lateral move, not a stack push.
 */
function go(name: string) {
  if (activeName.value === name) return
  tapFeedback()
  router.replace({ name })
}
</script>

<template>
  <nav class="tabbar" role="tablist">
    <button
      v-for="tab in TABS"
      :key="tab.name"
      class="tabbar__item"
      :class="{ 'tabbar__item--active': isActive(tab.name) }"
      role="tab"
      :aria-selected="isActive(tab.name)"
      @click="go(tab.name)"
    >
      <span class="tabbar__icon">
        <Icon :name="TAB_ICONS[tab.name]" :size="26" :width="1.6" />
      </span>
      <span class="tabbar__label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  display: flex;
  flex-shrink: 0;
  /* The bar itself stays 50px tall; the gesture bar's inset is added on top of
     it rather than eaten out of it (border-box would otherwise squeeze the
     icons to nothing on a device with a 24px navigation inset). */
  height: calc(var(--tabbar-height) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  /* Follows the theme: white in light themes, #1F1F1F in black. */
  background: var(--bottom-bar-bg);
  border-top: 0.5px solid var(--divider);
  transition: background-color var(--page-duration) var(--page-easing);
}

.tabbar__item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--tabbar-inactive);
  /* Colour is the only animated property: compositing a transform here would
     fight the page transition running at the same time. */
  transition: color 120ms ease-out;
}

.tabbar__item--active {
  color: var(--accent);
}

.tabbar__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  transition: transform 120ms ease-out;
}

.tabbar__item:active .tabbar__icon {
  transform: scale(0.9);
}

.tabbar__label {
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.2;
  letter-spacing: 0.2px;
}
</style>
