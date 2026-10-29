<script setup lang="ts">
/**
 * Reader bottom bar — matches WeRead's five icon-only entries:
 * 目录 / 笔记 / 进度 / 亮度 / 字体.
 *
 * Notes:
 *  - no text labels (WeRead uses icons alone here; labels belong to the tab bar)
 *  - the active entry turns brand blue, everything else is secondary grey
 *  - "笔记" replaces the earlier "书签": in WeRead a bookmark *is* a note, and
 *    the panel behind it lists bookmarks for this book
 */
export type ReaderPanel = 'none' | 'font' | 'theme' | 'progress' | 'notes'

import Icon from '@/components/Icon.vue'

defineProps<{
  active: ReaderPanel
  /** Number of bookmarks in this book, shown as a badge on 笔记. */
  noteCount?: number
}>()

const emit = defineEmits<{
  catalog: []
  panel: [p: Exclude<ReaderPanel, 'none'>]
}>()

/* ---- 模板事件 ---- */
function handleOpenCatalog(): void {
  emit('catalog')
}

function handleOpenNotes(): void {
  emit('panel', 'notes')
}

function handleOpenProgress(): void {
  emit('panel', 'progress')
}

function handleOpenTheme(): void {
  emit('panel', 'theme')
}

function handleOpenFont(): void {
  emit('panel', 'font')
}
</script>

<template>
  <div class="bottombar" @click.stop>
    <!-- 目录 -->
    <button class="bottombar__item" aria-label="目录" @click="handleOpenCatalog">
      <Icon name="catalog" :size="23" :width="1.7" />
    </button>

    <!-- 笔记 / 书签 -->
    <button
      class="bottombar__item"
      :class="{ 'bottombar__item--active': active === 'notes' }"
      aria-label="笔记"
      @click="handleOpenNotes"
    >
      <span class="bottombar__icon-wrap">
        <Icon name="note" :size="25" :width="1.9" />
        <span v-if="noteCount" class="bottombar__badge">{{ noteCount > 99 ? '99+' : noteCount }}</span>
      </span>
    </button>

    <!-- 进度 -->
    <button
      class="bottombar__item"
      :class="{ 'bottombar__item--active': active === 'progress' }"
      aria-label="进度"
      @click="handleOpenProgress"
    >
      <Icon name="progress" :size="25" :width="1.9" />
    </button>

    <!-- 亮度 -->
    <button
      class="bottombar__item"
      :class="{ 'bottombar__item--active': active === 'theme' }"
      aria-label="亮度"
      @click="handleOpenTheme"
    >
      <Icon name="brightness" :size="23" :width="1.7" />
    </button>

    <!-- 字体 -->
    <button
      class="bottombar__item"
      :class="{ 'bottombar__item--active': active === 'font' }"
      aria-label="字体"
      @click="handleOpenFont"
    >
      <Icon name="font" :size="23" :width="1.7" />
    </button>
  </div>
</template>

<style scoped>
.bottombar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  /* The 52px bar sits above the gesture bar, not on top of it. */
  height: calc(52px + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  /*
   * Chrome, not reading surface — but it still follows the theme: WeRead's
   * night mode bar is dark (reader_bar_bg_on_black), not a white slab across
   * an otherwise black screen.
   */
  background: var(--bottom-bar-bg);
  box-shadow: 0 -1px 8px var(--shadow);
  animation: slideUp 200ms var(--page-easing);
}

@keyframes slideUp {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.bottombar__item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  transition: color 130ms ease-out;
}

.bottombar__item--active {
  color: var(--accent);
}

.bottombar__icon-wrap {
  position: relative;
  display: flex;
}

.bottombar__badge {
  position: absolute;
  top: -5px;
  right: -9px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: calc(9px * var(--app-font-scale));
  line-height: 15px;
  text-align: center;
}
</style>
