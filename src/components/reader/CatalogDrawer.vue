<script setup lang="ts">
/**
 * Catalogue sheet — matches WeRead's bottom drawer:
 *
 *  - slides up from the bottom, not in from the side
 *  - a segmented bar pairs the search field with a white 「目录」 pill
 *  - every row carries a page number on the right
 *  - the current chapter gets a blue 「当前读到」 marker plus a bookmark shortcut,
 *    so the reading position is findable without hunting
 */
import { computed, ref, watch } from 'vue'
import type { Chapter } from '@/types'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  chapters: Chapter[]
  current: number
  /** Approximate printed page for a chapter index. */
  pageOf?: (chapterIndex: number) => number
}>()

const emit = defineEmits<{
  close: []
  jump: [number]
  bookmark: []
}>()

const searchQuery = ref('')
const listEl = ref<HTMLElement>()

const filtered = computed(() => {
  const q = searchQuery.value.trim()
  if (!q) return props.chapters
  return props.chapters.filter(c => (c.title || '').includes(q))
})

watch(
  () => props.current,
  () => {
    requestAnimationFrame(() => {
      const el = listEl.value?.querySelector('.catalog__row--current') as HTMLElement | null
      el?.scrollIntoView({ block: 'center' })
    })
  },
  { immediate: true },
)

function pageLabel(index: number): number {
  if (props.pageOf) return props.pageOf(index)
  return index + 1
}

/** Flip the jump pill between 去底部 / 去顶部 as the list scrolls. */
const atBottom = ref(false)

function onScroll() {
  const el = listEl.value
  if (!el) return
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

function jumpEnds() {
  const el = listEl.value
  if (!el) return
  el.scrollTo({
    top: atBottom.value ? 0 : el.scrollHeight,
    behavior: 'smooth',
  })
}

/* ---- 模板事件 ---- */
function handleClose(): void {
  emit('close')
}

function handleJump(ch: Chapter): void {
  emit('jump', ch.index)
}

function handleBookmark(): void {
  emit('bookmark')
}
</script>

<template>
  <div class="catalog-mask" @click.self="handleClose">
    <div class="catalog">
      <div class="catalog__grabber" />

      <div class="catalog__bar">
        <div class="catalog__search">
          <Icon name="search" :size="16" />
          <input v-model="searchQuery" placeholder="搜本书" enterkeyhint="search" />
        </div>
        <span class="catalog__pill">目录</span>
      </div>

      <div ref="listEl" class="catalog__list" @scroll="onScroll">
        <div v-for="ch in filtered" :key="ch.index" class="catalog__item">
          <button
            class="catalog__row"
            :class="{ 'catalog__row--current': ch.index === current }"
            @click="handleJump(ch)"
          >
            <span class="catalog__title">{{ ch.title || `第${ch.index + 1}章` }}</span>
            <span class="catalog__page">{{ pageLabel(ch.index) }}</span>
          </button>

          <div v-if="ch.index === current" class="catalog__here">
            <button class="catalog__here-pin" @click="handleBookmark">
              <Icon name="bookmark" :size="16" />
              <span>当前读到</span>
            </button>
            <span class="catalog__here-hint">添加书签</span>
          </div>
        </div>

        <p v-if="!filtered.length" class="catalog__empty">没有匹配的章节</p>
      </div>

      <!-- WeRead floats a jump pill over the list. -->
      <button class="catalog__jump" @click="jumpEnds">
        {{ atBottom ? '去顶部' : '去底部' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.catalog-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
  animation: maskIn 180ms ease-out;
}

@keyframes maskIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.catalog {
  position: relative;
  width: 100%;
  height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  border-radius: 16px 16px 0 0;
  padding-bottom: var(--safe-bottom);
  animation: sheetUp 260ms var(--page-easing);
}

@keyframes sheetUp {
  from {
    transform: translate3d(0, 100%, 0);
  }
  to {
    transform: translate3d(0, 0, 0);
  }
}

.catalog__grabber {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(120, 120, 128, 0.35);
  margin: 8px auto 6px;
  flex-shrink: 0;
}

/* Segmented control: grey field with a white pill on the active side. */
.catalog__bar {
  display: flex;
  align-items: center;
  margin: 4px 14px 10px;
  height: 40px;
  padding: 3px;
  border-radius: 20px;
  background: rgba(120, 120, 128, 0.12);
  flex-shrink: 0;
}

.catalog__search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  min-width: 0;
  color: var(--text-secondary);
}

.catalog__search input {
  flex: 1;
  min-width: 0;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.catalog__search input::placeholder {
  color: var(--text-secondary);
}

.catalog__pill {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  padding: 0 34px;
  border-radius: 17px;
  background: #fff;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.catalog__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* Floating 去底部 / 去顶部 pill, as WeRead draws it over the list. */
.catalog__jump {
  position: absolute;
  right: 16px;
  bottom: calc(16px + var(--safe-bottom));
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: calc(12px * var(--app-font-scale));
  box-shadow: 0 2px 10px var(--shadow);
}

.catalog__item {
  border-bottom: 0.5px solid var(--divider);
}

.catalog__row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 14px 18px;
  text-align: left;
}

.catalog__title {
  flex: 1;
  font-size: calc(15px * var(--app-font-scale));
  line-height: 1.45;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog__row--current .catalog__title {
  font-weight: 500;
}

.catalog__page {
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
  flex-shrink: 0;
}

/* The blue "reading here" marker sits under its chapter row. */
.catalog__here {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 0 18px 14px 34px;
}

.catalog__here-pin {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
}

.catalog__here-hint {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  padding-left: 21px;
}

.catalog__empty {
  padding: 40px 18px;
  text-align: center;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}
</style>
