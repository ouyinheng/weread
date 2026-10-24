<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores'
import type { ThemeId } from '@/types'
import { BACKGROUND_OPTIONS } from '@/utils/fonts'
import Icon from '@/components/Icon.vue'
import CapsuleSlider from '@/components/CapsuleSlider.vue'

const store = useSettingsStore()
const s = computed(() => store.settings)

const themes: { id: ThemeId; color: string; dark?: boolean }[] = [
  { id: 'white', color: '#FFFFFF' },
  { id: 'yellow', color: '#F5ECD9' },
  { id: 'green', color: '#C8E6C9' },
  { id: 'black', color: '#1A1A1A', dark: true },
]

const backgrounds = BACKGROUND_OPTIONS

/**
 * -1 means "follow the system"; 100 is the slider's neutral end (no dimming).
 * An untouched setting must not darken the page, so the fallback is the top of
 * the range rather than the 80 the old placeholder showed.
 */
const brightness = computed(() => (s.value.brightness < 0 ? 100 : s.value.brightness))
</script>

<template>
  <div class="theme-panel" @click.stop>
    <!-- Brightness: sun at the low end, the value carried by the thumb. -->
    <div class="tp-row">
      <CapsuleSlider
        :min="20" :max="100" :step="1"
        :value="brightness"
        @update:value="(v: number) => store.update({ brightness: v })"
      >
        <template #min>
          <Icon name="brightness" :size="15" :width="1.8" class="tp-sun" />
        </template>
      </CapsuleSlider>
    </div>

    <div class="tp-label">颜色</div>
    <div class="tp-themes">
      <button
        v-for="t in themes"
        :key="t.id"
        class="tp-theme"
        :class="{ active: s.theme === t.id }"
        :style="{ background: t.color, borderColor: s.theme === t.id ? 'var(--accent)' : 'var(--divider)' }"
        :aria-label="t.id === 'black' ? '夜间' : t.id"
        @click="store.update({ theme: t.id })"
      >
        <Icon v-if="t.dark" name="moon" :size="14" class="tp-theme__moon" />
      </button>
    </div>

    <div class="tp-label">背景</div>
    <div class="tp-bgs">
      <button
        v-for="b in backgrounds"
        :key="b.id"
        class="tp-bg"
        :class="{ active: s.background === b.id }"
        :style="b.css ? { backgroundImage: b.css } : {}"
        :title="b.label"
        :aria-label="b.label"
        @click="store.update({ background: b.id })"
      />
    </div>
  </div>
</template>

<style scoped>
.theme-panel {
  position: absolute;
  left: 0; right: 0; bottom: calc(52px + var(--safe-bottom));
  z-index: 55;
  padding: 18px;
  background: var(--bg-panel);
  border-top: 1px solid var(--divider);
  animation: panelUp .18s ease;
}
@keyframes panelUp {
  from { transform: translateY(12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* The brightness capsule is taller than the panel's other controls. */
.tp-row {
  height: 34px;
  margin-bottom: 18px;
}
.tp-row :deep(.capsule) {
  height: 34px;
  border-radius: 17px;
}
.tp-row :deep(.capsule__thumb) {
  height: 34px;
  border-radius: 17px;
}
.tp-sun {
  color: var(--text-secondary);
}

.tp-label {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  margin-bottom: 8px;
}

/* 颜色 chips: wide rounded rectangles. */
.tp-themes {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.tp-theme {
  flex: 1;
  height: 32px;
  border-radius: 10px;
  border: 2px solid var(--divider);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 背景 chips: flatter pills, five across. */
.tp-bgs {
  display: flex;
  gap: 8px;
}
.tp-bg {
  flex: 1;
  height: 26px;
  border-radius: 13px;
  border: 2px solid var(--divider);
  background: var(--bg-secondary);
}
.tp-bg.active { border-color: var(--accent); }

/* Moon glyph on the dark theme chip: accent blue, as in WeRead. */
.tp-theme__moon {
  color: var(--accent);
}
</style>
