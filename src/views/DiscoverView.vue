<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores'
import { useSourceStore } from '@/stores/source'
import type { Book } from '@/types'
import type { SearchHit } from '@/types/source'
import Icon from '@/components/Icon.vue'
import BookCover from '@/components/BookCover.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import { pickAndImport } from '@/utils/importer'
import { alertDialog } from '@/utils/dialog'

const router = useRouter()
const store = useBookStore()
const sourceStore = useSourceStore()
const searchQuery = ref('')

// This page is cached by <KeepAlive>, so it also needs to load on first visit
// when the user lands here via a deep link instead of through the shelf.
onMounted(async () => {
  if (!store.books.length) store.loadBooks()
  await sourceStore.load()
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

/* ---------- 在线搜索 ---------- */
/*
 * 没有书源时这一页的行为必须和改动前完全一致：输入框只筛本地库。
 * 有书源（且总开关打开）时，回车才切到网络搜索结果。
 */
const onlineActive = ref(false)
const addingKey = ref('')
const addedKeys = ref(new Set<string>())
const picks = ref<Record<string, string>>({})

/**
 * 搜索慢到一定程度才显示三点动画：快请求不要闪一下 loading。
 */
const showSearchLoading = ref(false)
let searchDelay: ReturnType<typeof setTimeout> | null = null

watch(() => sourceStore.searching, (busy) => {
  if (searchDelay) clearTimeout(searchDelay)
  searchDelay = null
  if (!busy) {
    showSearchLoading.value = false
    return
  }
  searchDelay = setTimeout(() => { showSearchLoading.value = true }, 400)
})

watch(searchQuery, (v) => {
  if (!v.trim() && onlineActive.value) {
    onlineActive.value = false
    sourceStore.clearResults()
  }
})

function submitSearch(): void {
  const q = searchQuery.value.trim()
  if (!sourceStore.onlineReady) return
  if (!q) {
    onlineActive.value = false
    sourceStore.clearResults()
    return
  }
  onlineActive.value = true
  void sourceStore.searchOnline(q)
}

interface HitGroup {
  key: string
  hits: SearchHit[]
  primary: SearchHit
}

function normKey(s: string): string {
  return (s || '').replace(/[\s《》「」“”"'·:：\-—]/g, '').toLowerCase()
}

/** 同一本书命中多个源时折叠成一条，点源名切换「加入书架」用哪一家。 */
const groups = computed<HitGroup[]>(() => {
  const map = new Map<string, HitGroup>()
  for (const h of sourceStore.hits) {
    const k = `${normKey(h.title)}|${normKey(h.author)}`
    const g = map.get(k)
    if (g) g.hits.push(h)
    else map.set(k, { key: k, hits: [h], primary: h })
  }
  return Array.from(map.values())
})

const failureText = computed(() => {
  const names = sourceStore.failures.slice(0, 8).map(f => f.sourceName)
  const rest = sourceStore.failures.length - names.length
  return rest > 0 ? `${names.join('、')} 等 ${sourceStore.failures.length} 个` : names.join('、')
})

function activeHit(g: HitGroup): SearchHit {
  const picked = picks.value[g.key]
  return g.hits.find(h => h.sourceId === picked) || g.primary
}

function hitKey(h: SearchHit): string {
  return `${h.sourceId}|${h.bookUrl}`
}

function isAdded(h: SearchHit): boolean {
  if (addedKeys.value.has(hitKey(h))) return true
  // 之前加入过书架的同一本书（同一源 + 同一详情页）直接显示「已加入」。
  return store.books.some(b => b.sourceId === h.sourceId && b.remoteBookUrl === h.bookUrl)
}

/** 书架上已有同名书（另一个源）时，这个按钮就是「换源」。 */
function shelfBookOf(h: SearchHit): Book | undefined {
  return store.books.find(b =>
    !!b.sourceId &&
    normKey(b.title) === normKey(h.title) &&
    normKey(b.author || '') === normKey(h.author || '')
  )
}

type HitAction = 'added' | 'switch' | 'add'

function actionFor(h: SearchHit): HitAction {
  if (isAdded(h)) return 'added'
  const book = shelfBookOf(h)
  if (book && book.sourceId !== h.sourceId) return 'switch'
  return 'add'
}

function actionLabel(h: SearchHit): string {
  if (addingKey.value === hitKey(h)) return actionFor(h) === 'switch' ? '换源中' : '加入中'
  const action = actionFor(h)
  return action === 'added' ? '已加入' : action === 'switch' ? '换到此源' : '加入书架'
}

async function doAction(group: HitGroup): Promise<void> {
  const hit = activeHit(group)
  const action = actionFor(hit)
  if (action === 'added' || addingKey.value) return

  addingKey.value = hitKey(hit)
  try {
    if (action === 'switch') {
      const book = shelfBookOf(hit)
      if (!book) return
      await sourceStore.switchSource(book.id, hit)
      await alertDialog({
        title: '已换源',
        message: `「${book.title}」已切换到 ${hit.sourceName}，阅读进度已尽量保留。`,
        confirmText: '知道了',
      })
    } else {
      await sourceStore.addToShelf(hit)
      addedKeys.value.add(hitKey(hit))
    }
  } catch (e) {
    await alertDialog({ title: '操作失败', message: (e as Error).message })
  } finally {
    addingKey.value = ''
  }
}
</script>

<template>
  <div class="discover tab-page">
    <header class="discover__header">
      <div class="discover__search">
        <Icon name="search" :size="17" />
        <input
          v-model="searchQuery"
          :placeholder="sourceStore.onlineReady ? '搜书名 / 作者（网络书源）' : '搜书名 / 作者'"
          enterkeyhint="search"
          @keyup.enter="submitSearch"
        />
        <span class="discover__search-divider" />
        <button class="discover__search-action" @click="router.push('/shelf')">书架</button>
      </div>
    </header>

    <div v-if="!onlineActive" class="discover__cats">
      <button
        v-for="f in filters"
        :key="f.key"
        class="discover__cat"
        :class="{ 'discover__cat--active': activeFilter === f.key }"
        @click="activeFilter = f.key"
      >{{ f.label }}</button>
    </div>

    <!-- 在线搜索结果 -->
    <main v-if="onlineActive" class="discover__body">
      <div v-if="sourceStore.searching" class="discover__status">
        <LoadingDots v-if="showSearchLoading" />
        <Icon v-else name="search" :size="16" />
        正在搜索书源…
      </div>

      <template v-else>
        <div v-if="groups.length" class="discover__results">
          <div v-for="g in groups" :key="g.key" class="discover__result">
            <span class="discover__result-cover">
              <img
                v-if="activeHit(g).coverUrl"
                :src="activeHit(g).coverUrl || ''"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
              />
              <span v-else class="discover__result-char">{{ (g.primary.title || '书').charAt(0) }}</span>
            </span>
            <div class="discover__result-info">
              <span class="discover__book-title">{{ g.primary.title }}</span>
              <span class="discover__book-author">
                {{ g.primary.author || '未知作者' }} · {{ activeHit(g).sourceName }}
              </span>
              <span v-if="g.primary.lastChapter" class="discover__result-last">{{ g.primary.lastChapter }}</span>
              <div v-if="g.hits.length > 1" class="discover__result-sources">
                <button
                  v-for="h in g.hits"
                  :key="h.sourceId"
                  class="discover__result-src"
                  :class="{ 'discover__result-src--active': activeHit(g).sourceId === h.sourceId }"
                  @click="picks[g.key] = h.sourceId"
                >{{ h.sourceName }}</button>
              </div>
            </div>
            <button
              class="discover__result-add"
              :class="{ 'discover__result-add--done': actionFor(activeHit(g)) === 'added' }"
              @click="doAction(g)"
            >
              {{ actionLabel(activeHit(g)) }}
            </button>
          </div>
        </div>

        <button v-else class="discover__empty" @click="submitSearch">
          没有搜到「{{ sourceStore.lastKey }}」，换个关键词试试
        </button>

        <p v-if="sourceStore.failures.length" class="discover__hint">
          {{ sourceStore.failures.length }} 个书源未返回结果：{{ failureText }}
        </p>

        <p
          v-if="sourceStore.searchScope.total > sourceStore.searchScope.searched"
          class="discover__hint"
        >
          已检索 {{ sourceStore.searchScope.searched }}/{{ sourceStore.searchScope.total }} 个启用书源。书源太多时每次只查前 20 个，可在书源管理里停用不用的源。
        </p>
      </template>
    </main>

    <!-- 本地库筛选（没有书源时的原行为） -->
    <main v-else class="discover__body">
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

/* ---------- 在线结果 ---------- */

.discover__status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 36px 16px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}

.discover__results {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: contentIn 180ms var(--page-easing);
}

.discover__result {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.discover__result + .discover__result {
  padding-top: 14px;
  border-top: 0.5px solid var(--divider);
}

.discover__result-cover {
  width: 56px;
  height: 77px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background: linear-gradient(135deg, #5B7FA6, #3D5A80);
  display: flex;
  align-items: center;
  justify-content: center;
}

.discover__result-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.discover__result-char {
  font-size: 22px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.9);
}

.discover__result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 2px;
}

.discover__result-last {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover__result-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.discover__result-src {
  padding: 3px 8px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}

.discover__result-src--active {
  background: var(--accent-soft);
  color: var(--accent);
}

.discover__result-add {
  flex-shrink: 0;
  align-self: center;
  padding: 7px 12px;
  border-radius: 14px;
  background: var(--accent);
  font-size: calc(12px * var(--app-font-scale));
  color: #fff;
}

.discover__result-add--done {
  background: var(--bg-panel);
  color: var(--text-secondary);
}

.discover__hint {
  margin-top: 14px;
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
