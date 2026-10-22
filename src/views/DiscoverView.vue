<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores'
import Icon from '@/components/Icon.vue'
import BookCover from '@/components/BookCover.vue'
import { pickAndImport } from '@/utils/importer'
import type { Book } from '@/types'

const router = useRouter()
const store = useBookStore()
const searchQuery = ref('')

// This page is cached by <KeepAlive>, so it also needs to load on first visit
// when the user lands here via a deep link instead of through the shelf.
onMounted(() => {
  if (!store.books.length) store.loadBooks()
})

/**
 * Filter chips over the *local* library. WeRead's chips lead to store sections;
 * with no store, the honest equivalent is narrowing what the user owns —
 * otherwise they are six buttons that do nothing.
 */
type FilterKey = 'all' | 'reading' | 'finished' | 'unread' | 'long' | 'recent'
const filters: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'unread', label: '未读' },
  { key: 'finished', label: '已读完' },
  { key: 'long', label: '长篇' },
  { key: 'recent', label: '最近' },
]
const activeFilter = ref<FilterKey>('all')

/** Keep the discovery rail honest: it points at the user's own library. */
const suggestions = computed<Book[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  let list = [...store.books].sort((a, b) => b.lastReadAt - a.lastReadAt)

  switch (activeFilter.value) {
    case 'reading': list = list.filter(b => b.progress > 0 && !b.finished); break
    case 'unread': list = list.filter(b => b.progress <= 0); break
    case 'finished': list = list.filter(b => b.finished); break
    case 'long': list = list.filter(b => b.wordCount >= 200000); break
    case 'recent': list = list.filter(b => Date.now() - b.importedAt < 7 * 864e5); break
    default: break
  }

  if (q) {
    list = list.filter(b =>
      b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
    )
  }
  return list
})

function tagOf(b: Book): string {
  return b.progress > 0 ? `已读 ${Math.round(b.progress)}%` : '本地书籍'
}
</script>

<template>
  <div class="discover tab-page">
    <header class="discover__header">
      <div class="discover__search">
        <Icon name="search" :size="17" />
        <input v-model="searchQuery" placeholder="搜书名 / 作者" enterkeyhint="search" />
        <span class="discover__search-divider" />
        <button class="discover__search-action" @click="router.push('/shelf')">书架</button>
      </div>
    </header>

    <div class="discover__cats">
      <button
        v-for="f in filters"
        :key="f.key"
        class="discover__cat"
        :class="{ 'discover__cat--active': activeFilter === f.key }"
        @click="activeFilter = f.key"
      >{{ f.label }}</button>
    </div>

    <main class="discover__body">
      <div class="discover__banner">
        <div class="discover__banner-card">
          <span class="discover__banner-label">本周阅读</span>
          <span class="discover__banner-value">本地书架</span>
          <div class="discover__banner-days">
            <span v-for="d in ['一','二','三','四','五','六','日']" :key="d" class="discover__banner-day">{{ d }}</span>
          </div>
        </div>
        <div class="discover__banner-card discover__banner-card--accent">
          <span class="discover__banner-label">已导入</span>
          <span class="discover__banner-value">{{ store.books.length }} 本</span>
          <span class="discover__banner-foot">离线可读 · 进度本地保存</span>
        </div>
      </div>

      <h2 class="discover__section-title">
        {{ activeFilter === 'all' ? '继续阅读' : filters.find(f => f.key === activeFilter)?.label }}
        <span class="discover__count">{{ suggestions.length }}</span>
      </h2>

      <div v-if="suggestions.length" class="discover__list">
        <button
          v-for="b in suggestions"
          :key="b.id"
          class="discover__book"
          @click="router.push({ name: 'reader', params: { id: b.id } })"
        >
          <span class="discover__book-cover">
            <BookCover :book="b" compact />
          </span>
          <span class="discover__book-info">
            <span class="discover__book-title">{{ b.title }}</span>
            <span class="discover__book-author">{{ b.author || '未知作者' }}</span>
            <span class="discover__book-tag">{{ tagOf(b) }}</span>
          </span>
        </button>
      </div>

      <button v-else class="discover__empty" @click="pickAndImport()">
        {{ searchQuery || activeFilter !== 'all' ? '没有符合条件的书' : '书架还没有书，去导入一本 →' }}
      </button>
    </main>
  </div>
</template>

<style scoped>
.discover {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.discover__header {
  /* Matches the shelf: a ~30dp gap below the status bar. */
  padding: calc(30px + var(--safe-top)) 20px 6px;
  flex-shrink: 0;
}

.discover__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  background: rgba(120, 120, 128, 0.12);
  border-radius: 8px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
}

.discover__search input {
  flex: 1;
  min-width: 0;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.discover__search input::placeholder {
  color: var(--text-secondary);
}

.discover__search-divider {
  width: 1px;
  height: 16px;
  background: rgba(120, 120, 128, 0.3);
}

.discover__search-action {
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
  flex-shrink: 0;
}

.discover__cats {
  display: flex;
  gap: 8px;
  /* WeRead separates the search field from the category rail by ~36dp. */
  padding: 30px 20px 10px;
  overflow-x: auto;
  flex-shrink: 0;
}

.discover__cat {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 7px 14px;
  border-radius: 16px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 140ms, color 140ms;
}

.discover__cat--active {
  background: var(--accent-soft);
  color: var(--accent);
}

.discover__count {
  margin-left: 6px;
  font-size: calc(13px * var(--app-font-scale));
  font-weight: 400;
  color: var(--text-secondary);
}

.discover__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 20px calc(16px + var(--safe-bottom));
}

.discover__banner {
  display: flex;
  gap: 10px;
  margin: 6px 0 22px;
}

.discover__banner-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 12px;
  background: var(--bg-panel);
  min-width: 0;
}

.discover__banner-card--accent {
  background: linear-gradient(135deg, #2b3a4a, #1d2733);
}

.discover__banner-label {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.discover__banner-card--accent .discover__banner-label {
  color: rgba(255, 255, 255, 0.65);
}

.discover__banner-value {
  font-size: calc(21px * var(--app-font-scale));
  font-weight: 700;
  color: var(--text);
  line-height: 1.1;
}

.discover__banner-card--accent .discover__banner-value {
  color: #fff;
}

.discover__banner-foot {
  font-size: calc(11px * var(--app-font-scale));
  color: rgba(255, 255, 255, 0.55);
}

.discover__banner-days {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.discover__banner-day {
  flex: 1;
  text-align: center;
  font-size: calc(10px * var(--app-font-scale));
  color: var(--text-secondary);
  padding: 4px 0;
  border-radius: 4px;
  background: rgba(120, 120, 128, 0.1);
}

.discover__section-title {
  font-size: calc(18px * var(--app-font-scale));
  font-weight: 700;
  color: var(--text);
  margin-bottom: 14px;
}

.discover__list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: contentIn 180ms var(--page-easing);
}

.discover__book:active {
  opacity: 0.6;
}

.discover__book {
  display: flex;
  gap: 12px;
  text-align: left;
  width: 100%;
}

.discover__book-cover {
  width: 56px;
  height: 77px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}

/* BookCover renders its own 3:4 frame; force it to fill this thumb. */
.discover__book-cover :deep(.cover) {
  height: 100%;
}

.discover__book-info {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 2px;
  min-width: 0;
  align-items: flex-start;
}

.discover__book-title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.discover__book-author {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.discover__book-tag {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--accent);
}

.discover__empty {
  width: 100%;
  padding: 40px 16px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 12px;
}
</style>
