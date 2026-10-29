<script setup lang="ts">
/**
 * Font picker — the second-level page behind 设置 → 字体.
 *
 * It owns the reading face (the same `settings.fontFamily` the reader panel
 * writes), so choosing a family here changes body text immediately. Sizes,
 * margins and leading stay in the reader's own panel, where the user can see
 * the effect on a real page.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppSettingsStore, useSettingsStore } from '@/stores'
import {
  FONT_GROUPS,
  FONT_OPTIONS,
  fontLabelOf,
  fontStackOf,
  type FontGroup,
  type FontOption,
} from '@/utils/fonts'
import Icon from '@/components/Icon.vue'

const route = useRoute()
const router = useRouter()
const store = useSettingsStore()
const appStore = useAppSettingsStore()

/** 系统设置里的「字体」带 scope=app，只改界面；阅读设置里的字体不带参数。 */
const isApp = computed(() => route.query.scope === 'app')
const selected = computed(() => (isApp.value ? appStore.app.fontFamily : store.settings.fontFamily))
const group = ref<FontGroup | 'all'>('all')

const tabs = computed(() => {
  const count = (g: FontGroup) => FONT_OPTIONS.filter(f => f.group === g).length
  return [
    { id: 'all' as const, label: `全部(${FONT_OPTIONS.length})` },
    ...FONT_GROUPS.map(g => ({ id: g.id, label: `${g.label}(${count(g.id)})` })),
  ]
})

const shown = computed(() =>
  group.value === 'all' ? FONT_OPTIONS : FONT_OPTIONS.filter(f => f.group === group.value),
)

function choose(id: string) {
  if (isApp.value) void appStore.update({ fontFamily: id })
  else void store.update({ fontFamily: id })
}

/* ---- 模板事件 ---- */
function handleBack(): void {
  router.back()
}

function handlePickGroup(t: { id: FontGroup | 'all' }): void {
  group.value = t.id
}

function handleChoose(f: FontOption): void {
  choose(f.id)
}
</script>

<template>
  <div class="font-page">
    <header class="font-header">
      <button class="font-back tap-target" aria-label="返回" @click="handleBack">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="font-title">{{ isApp ? '界面字体' : '字体' }}</span>
    </header>

    <div class="font-body">
      <div class="font-preview">
        <span class="font-preview__sample" :style="{ fontFamily: fontStackOf(selected) }">
          春风又绿江南岸
        </span>
        <span class="font-preview__line" :style="{ fontFamily: fontStackOf(selected) }">
          明月何时照我还
        </span>
        <span class="font-preview__meta">当前字体 · {{ fontLabelOf(selected) }}</span>
      </div>

      <div class="font-tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="font-tab tap-target"
          :class="{ 'font-tab--on': group === t.id }"
          @click="handlePickGroup(t)"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="font-list">
        <button
          v-for="f in shown"
          :key="f.id"
          class="font-row"
          :class="{ 'font-row--on': selected === f.id }"
          @click="handleChoose(f)"
        >
          <span class="font-row__label">{{ f.label }}</span>
          <!-- Only the sample switches face: a list whose *labels* render in
               eight different fonts is unreadable as a list. -->
          <span class="font-row__sample" :style="{ fontFamily: f.stack }">读书之乐</span>
          <Icon v-if="selected === f.id" name="check" :size="18" :width="2.2" class="font-row__check" />
        </button>
      </div>

      <p v-if="!isApp" class="font-note">
        字号、边距、行距请在阅读页底部「字体」面板调整，改动会立即显示在正文上。
      </p>
    </div>
  </div>
</template>

<style scoped>
.font-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.font-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  flex-shrink: 0;
}

.font-back {
  position: absolute;
  /* 44×44 hit box; the glyph stays 24 and moves with it (-3px each side keeps
     the optical centre where the 38px version had it). */
  left: 5px;
  bottom: -1px;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  border-radius: 50%;
}

.font-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.font-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  padding: 8px 12px calc(20px + var(--safe-bottom));
}

.font-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 22px 16px 18px;
  border-radius: 12px;
  background: var(--bg-panel);
  margin-bottom: 12px;
  animation: fontIn 180ms var(--page-easing);
}

@keyframes fontIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.font-preview__sample {
  font-size: calc(22px * var(--app-font-scale));
  color: var(--text);
  line-height: 1.5;
}

.font-preview__line {
  font-size: calc(16px * var(--app-font-scale));
  color: var(--text);
  line-height: 1.5;
}

.font-preview__meta {
  margin-top: 4px;
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}

.font-tabs {
  display: flex;
  gap: 8px;
  padding: 4px 0 10px;
  overflow-x: auto;
  flex-shrink: 0;
}

.font-tab {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  /* 44px: the chips row is the filter for the whole list below it. */
  min-height: 44px;
  padding: 0 14px;
  border-radius: 16px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
  white-space: nowrap;
  transition:
    background-color 140ms,
    color 140ms;
}

.font-tab--on {
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.font-list {
  background: var(--bg-panel);
  border-radius: 12px;
  overflow: hidden;
}

.font-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 0.5px solid var(--divider);
  text-align: left;
}

.font-row:last-child {
  border-bottom: none;
}

.font-row:active {
  opacity: 0.55;
}

.font-row__label {
  flex: 1;
  font-size: calc(16px * var(--app-font-scale));
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.font-row__sample {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  flex-shrink: 0;
}

.font-row--on .font-row__label {
  color: var(--accent);
}

.font-row__check {
  color: var(--accent);
  flex-shrink: 0;
}

.font-note {
  padding: 10px 4px 0;
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
