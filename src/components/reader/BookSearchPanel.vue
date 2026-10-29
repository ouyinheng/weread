<script setup lang="ts">
/**
 * 书内搜索 — a bottom sheet over the reader.
 *
 * The catalogue's search field only filters chapter titles; this one scans the
 * body text and jumps to the matched character. Results are grouped by chapter
 * with a one-line excerpt, which is the fastest way back to "that sentence I
 * read last week".
 */
import { nextTick, onMounted, ref } from 'vue'
import type { BookSearchHit } from '@/utils/book-search'
import Icon from '@/components/Icon.vue'
import LoadingDots from '@/components/LoadingDots.vue'

defineProps<{
  query: string
  results: BookSearchHit[]
  searching: boolean
  /** Chapters whose text is available locally (online books cache lazily). */
  cached: number
  total: number
}>()

const emit = defineEmits<{
  'update:query': [string]
  close: []
  jump: [BookSearchHit]
}>()

const inputEl = ref<HTMLInputElement>()

onMounted(async () => {
  await nextTick()
  inputEl.value?.focus()
})

/* ---- 模板事件 ---- */
function handleClose(): void {
  emit('close')
}

function handleQueryInput(e: Event): void {
  emit('update:query', (e.target as HTMLInputElement).value)
}

function handleClear(): void {
  emit('update:query', '')
}

function handleJump(hit: BookSearchHit): void {
  emit('jump', hit)
}
</script>

<template>
  <div class="bs-mask" @click.self="handleClose">
    <div class="bs">
      <div class="bs__grabber" />

      <div class="bs__bar">
        <Icon name="search" :size="16" />
        <input
          ref="inputEl"
          :value="query"
          placeholder="搜索本书正文"
          enterkeyhint="search"
          @input="handleQueryInput"
        />
        <button v-if="query" class="bs__clear" aria-label="清空搜索" @click="handleClear">×</button>
      </div>

      <div class="bs__meta">
        <span v-if="searching" class="bs__meta-loading">
          <LoadingDots />
          正在搜索…
        </span>
        <span v-else-if="query.trim()">{{ results.length }} 条结果</span>
        <span v-else>输入关键词，搜索本书正文</span>
        <span v-if="cached < total" class="bs__meta-cache"> 仅搜索已缓存的 {{ cached }}/{{ total }} 章 </span>
      </div>

      <div class="bs__list">
        <button
          v-for="(r, i) in results"
          :key="`${r.chapterIndex}-${r.domOffset}-${i}`"
          class="bs__row"
          @click="handleJump(r)"
        >
          <span class="bs__chapter">{{ r.chapterTitle || `第${r.chapterIndex + 1}章` }}</span>
          <span class="bs__excerpt"
            >{{ r.excerpt.slice(0, r.matchStart) }}<mark>{{ r.excerpt.slice(r.matchStart, r.matchEnd) }}</mark
            >{{ r.excerpt.slice(r.matchEnd) }}</span
          >
        </button>

        <p v-if="!query.trim()" class="bs__hint">支持在整本书的正文里找一句话，不只看章节名。</p>
        <p v-else-if="!searching && !results.length" class="bs__hint">没有找到「{{ query.trim() }}」</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bs-mask {
  position: fixed;
  inset: 0;
  z-index: 92;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
  animation: maskIn 180ms ease-out;
}

.bs {
  width: 100%;
  height: min(76vh, 620px);
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  border-radius: 16px 16px 0 0;
  animation: sheetUp 240ms var(--page-easing);
}

.bs__grabber {
  width: 34px;
  height: 4px;
  margin: 8px auto 0;
  border-radius: 2px;
  background: var(--divider);
  flex-shrink: 0;
}

.bs__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 14px 8px;
  padding: 0 12px;
  height: 40px;
  border-radius: 10px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.bs__bar input {
  flex: 1;
  min-width: 0;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.bs__bar input::placeholder {
  color: var(--text-secondary);
}

.bs__clear {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 18px;
  line-height: 1;
  color: var(--text-secondary);
  background: rgba(120, 120, 128, 0.14);
  flex-shrink: 0;
}

.bs__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px 8px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  flex-shrink: 0;
}

.bs__meta-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.bs__meta-cache {
  color: #c07a00;
}

.bs__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 14px calc(16px + var(--safe-bottom));
}

.bs__row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 12px 12px;
  margin-bottom: 8px;
  border-radius: 10px;
  background: var(--bg-panel);
  text-align: left;
}

.bs__row:active {
  background: var(--bg-secondary);
}

.bs__chapter {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.bs__excerpt {
  font-size: calc(14px * var(--app-font-scale));
  line-height: 1.65;
  color: var(--text);
  word-break: break-word;
}

.bs__excerpt mark {
  background: rgba(27, 136, 238, 0.22);
  color: inherit;
  border-radius: 2px;
}

.bs__hint {
  padding: 24px 12px;
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.7;
  color: var(--text-secondary);
  text-align: center;
}

@keyframes maskIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes sheetUp {
  from {
    transform: translate3d(0, 100%, 0);
  }
  to {
    transform: translate3d(0, 0, 0);
  }
}
</style>
