<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { ref, computed, onMounted } from 'vue'
import { useChapterStore, useBookmarkStore, useBookStore } from '@/stores'
import Icon from '@/components/Icon.vue'

type TabKey = 'catalog' | 'bookmark' | 'note'

const route = useRoute()
const router = useRouter()
const chapterStore = useChapterStore()
const bookmarkStore = useBookmarkStore()
const bookStore = useBookStore()

const bookId = route.params.id as string
const searchQuery = ref('')
const activeTab = ref<TabKey>('catalog')

const book = computed(() => bookStore.getBook(bookId))
const chapters = computed(() => chapterStore.chapters)
const bookmarks = computed(() => bookmarkStore.bookmarks)

const tabs: { key: TabKey; label: string }[] = [
  { key: 'catalog', label: '目录' },
  { key: 'bookmark', label: '书签' },
  { key: 'note', label: '笔记' },
]

const filteredChapters = computed(() => {
  const q = searchQuery.value.trim()
  if (!q) return chapters.value
  return chapters.value.filter(c => (c.title || '').includes(q))
})

onMounted(async () => {
  if (!bookStore.books.length) await bookStore.loadBooks()
  await Promise.all([chapterStore.loadChapters(bookId), bookmarkStore.loadBookmarks(bookId)])
})

function jumpTo(index: number) {
  router.replace({ name: 'reader', params: { id: bookId }, query: { chapter: index } })
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function removeBookmark(id: string) {
  await bookmarkStore.removeBookmark(id)
}
</script>

<template>
  <div class="catalog-page">
    <header class="catalog-header">
      <button class="catalog-back" @click="router.back()">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <div class="catalog-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="catalog-tab"
          :class="{ active: activeTab === t.key }"
          @click="activeTab = t.key"
        >{{ t.label }}</button>
      </div>
    </header>

    <div class="catalog-book">
      <span class="catalog-book-title">{{ book?.title || '未知书籍' }}</span>
      <span v-if="book?.author" class="catalog-book-author">{{ book.author }}</span>
    </div>

    <div v-if="activeTab === 'catalog'" class="catalog-search">
      <Icon name="search" :size="16" />
      <input v-model="searchQuery" placeholder="搜本章节" />
    </div>

    <!-- Catalog -->
    <div v-if="activeTab === 'catalog'" class="catalog-body">
      <button
        v-for="ch in filteredChapters"
        :key="ch.index"
        class="catalog-row"
        :class="{ 'catalog-row--current': book && ch.index === book.lastChapterIndex }"
        @click="jumpTo(ch.index)"
      >
        <span class="catalog-row-title">{{ ch.title || `第${ch.index + 1}章` }}</span>
        <span v-if="book && ch.index === book.lastChapterIndex" class="catalog-row-badge">当前读到</span>
      </button>
      <p v-if="!filteredChapters.length" class="catalog-empty">没有匹配的章节</p>
    </div>

    <!-- Bookmarks -->
    <div v-else-if="activeTab === 'bookmark'" class="catalog-body">
      <div v-for="bm in bookmarks" :key="bm.id" class="bookmark-row">
        <button class="bookmark-main" @click="jumpTo(bm.chapterIndex)">
          <span class="bookmark-chapter">{{ chapters[bm.chapterIndex]?.title || `第${bm.chapterIndex + 1}章` }}</span>
          <span class="bookmark-excerpt">{{ bm.excerpt || '（无摘录）' }}</span>
          <span class="bookmark-time">{{ formatDate(bm.createdAt) }}</span>
        </button>
        <button class="bookmark-del" @click="removeBookmark(bm.id)">删除</button>
      </div>
      <p v-if="!bookmarks.length" class="catalog-empty">阅读时点「书签」即可记录当前位置</p>
    </div>

    <!-- Notes -->
    <div v-else class="catalog-body">
      <p class="catalog-empty">暂无笔记。划线、想法功能在后续版本开放。</p>
    </div>
  </div>
</template>

<style scoped>
.catalog-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}
.catalog-header {
  display: flex;
  align-items: center;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  gap: 12px;
}
.catalog-back {
  display: flex;
  padding: 4px;
  color: var(--text);
}
.catalog-tabs {
  display: flex;
  gap: 20px;
  flex: 1;
  justify-content: center;
}
.catalog-tab {
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text-secondary);
  padding-bottom: 4px;
  border-bottom: 2px solid transparent;
}
.catalog-tab.active {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.catalog-book {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 16px 8px;
}
.catalog-book-title {
  font-size: calc(13px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalog-book-author {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalog-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 16px 8px;
  padding: 8px 14px;
  background: var(--bg-secondary);
  border-radius: 18px;
}
.catalog-search input {
  flex: 1;
  font-size: calc(13px * var(--app-font-scale));
}
.catalog-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px calc(16px + var(--safe-bottom));
}
.catalog-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 14px 12px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
  border-bottom: 1px solid var(--divider);
}
.catalog-row--current {
  color: var(--accent);
  font-weight: 600;
}
.catalog-row-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalog-row-badge {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--accent);
  flex-shrink: 0;
}
.bookmark-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--divider);
}
.bookmark-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px;
  text-align: left;
}
.bookmark-chapter {
  font-size: calc(13px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}
.bookmark-excerpt {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bookmark-time {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}
.bookmark-del {
  font-size: calc(12px * var(--app-font-scale));
  color: #E74C3C;
  padding: 8px 12px;
  flex-shrink: 0;
}
.catalog-empty {
  padding: 48px 16px;
  text-align: center;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}
</style>
