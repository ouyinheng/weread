<script setup lang="ts">
/**
 * 独立搜索页。
 *
 * 只做一件事：从已启用的网络书源里搜书。原来的「发现」页把本地书架筛选、
 * 阅读统计和搜索混在一起，入口也多；这里参考阅读类应用的通行做法，用
 * 顶部返回 + 搜索框 + 搜索历史的单页结构，结果直接可加入书架或换源。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores'
import { useSourceStore } from '@/stores/source'
import type { Book } from '@/types'
import type { SearchHit } from '@/types/source'
import Icon from '@/components/Icon.vue'
import { alertDialog, confirmDialog } from '@/utils/dialog'

const HISTORY_KEY = 'weread.searchHistory'
const HISTORY_MAX = 10

const router = useRouter()
const store = useBookStore()
const sourceStore = useSourceStore()

const query = ref('')
const submitted = ref(false)
const inputEl = ref<HTMLInputElement>()
const history = ref<string[]>(readHistory())
const addingKey = ref('')
const addedKeys = ref(new Set<string>())
const picks = ref<Record<string, string>>({})

const hasEnabledSource = computed(() => sourceStore.enabledSources.length > 0)

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX)
      : []
  } catch {
    return []
  }
}

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
  } catch {
    // 存储不可用时只保留本次会话的历史。
  }
}

function remember(word: string): void {
  history.value = [word, ...history.value.filter(x => x !== word)].slice(0, HISTORY_MAX)
  saveHistory()
}

function clearHistory(): void {
  history.value = []
  saveHistory()
}

onMounted(async () => {
  if (!store.books.length) store.loadBooks()
  await sourceStore.load()
  sourceStore.clearResults()
  await nextTick()
  inputEl.value?.focus()
})

watch(query, (v) => {
  if (!v.trim() && submitted.value) {
    submitted.value = false
    sourceStore.clearResults()
  }
})

function goBack(): void {
  if (window.history.state?.back) router.back()
  else router.replace({ name: 'shelf' })
}

function clearQuery(): void {
  query.value = ''
  submitted.value = false
  sourceStore.clearResults()
  inputEl.value?.focus()
}

/** 搜索前确保有书源且总开关已打开；没有就带着用户去处理。 */
async function ensureReady(): Promise<boolean> {
  if (sourceStore.onlineReady) return true
  if (!hasEnabledSource.value) {
    await router.push({ name: 'sourceList' })
    return false
  }
  const ok = await confirmDialog({
    title: '开启网络书源',
    message: '搜索会向书源站点发起网络请求。',
    confirmText: '开启',
  })
  if (!ok) return false
  await sourceStore.setNetworkEnabled(true)
  return true
}

async function submit(): Promise<void> {
  const word = query.value.trim()
  if (!word) return
  const ready = await ensureReady()
  if (!ready) return
  remember(word)
  submitted.value = true
  void sourceStore.searchOnline(word)
}

function searchFor(word: string): void {
  query.value = word
  void submit()
}

async function openSetup(): Promise<void> {
  if (!hasEnabledSource.value) {
    await router.push({ name: 'sourceList' })
    return
  }
  await ensureReady()
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
  <div class="search-page">
    <header class="search__header">
      <button class="search__back tap-target" aria-label="返回" @click="goBack">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <div class="search__field">
        <Icon name="search" :size="16" />
        <input
          ref="inputEl"
          v-model="query"
          placeholder="搜书名 / 作者"
          enterkeyhint="search"
          autocomplete="off"
          @keyup.enter="submit"
        />
        <button v-if="query" class="search__clear tap-target" aria-label="清空" @click="clearQuery">
          <Icon name="close" :size="14" :width="2" />
        </button>
      </div>
      <button class="search__submit tap-target" @click="submit">搜索</button>
    </header>

    <main class="search__body">
      <!-- 还没搜索：搜索历史 + 书源状态 -->
      <template v-if="!submitted">
        <div v-if="!sourceStore.onlineReady" class="search__setup">
          <Icon name="book-open" :size="30" :width="1.4" />
          <p class="search__setup-title">{{ hasEnabledSource ? '网络书源未开启' : '还没有可用的书源' }}</p>
          <p class="search__setup-desc">
            {{ hasEnabledSource ? '开启后才能在书源站点里搜索书籍。' : '搜索依赖书源，先导入并启用书源。' }}
          </p>
          <button class="search__setup-btn" @click="openSetup">
            {{ hasEnabledSource ? '开启网络书源' : '去导入书源' }}
          </button>
        </div>

        <div v-if="history.length" class="search__history">
          <div class="search__history-head">
            <span>搜索历史</span>
            <button class="search__history-clear" aria-label="清空搜索历史" @click="clearHistory">
              <Icon name="trash" :size="16" />
            </button>
          </div>
          <div class="search__chips">
            <button
              v-for="h in history"
              :key="h"
              class="search__chip"
              @click="searchFor(h)"
            >{{ h }}</button>
          </div>
        </div>
      </template>

      <!-- 搜索结果 -->
      <template v-else>
        <div v-if="sourceStore.searching" class="search__status">
          <Icon name="search" :size="16" />
          正在搜索书源…
        </div>

        <template v-else>
          <div v-if="groups.length" class="search__results">
            <div v-for="g in groups" :key="g.key" class="search__result">
              <span class="search__result-cover">
                <img
                  v-if="activeHit(g).coverUrl"
                  :src="activeHit(g).coverUrl || ''"
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
                <span v-else class="search__result-char">{{ (g.primary.title || '书').charAt(0) }}</span>
              </span>
              <div class="search__result-info">
                <span class="search__book-title">{{ g.primary.title }}</span>
                <span class="search__book-author">
                  {{ g.primary.author || '未知作者' }} · {{ activeHit(g).sourceName }}
                </span>
                <span v-if="g.primary.lastChapter" class="search__result-last">{{ g.primary.lastChapter }}</span>
                <div v-if="g.hits.length > 1" class="search__result-sources">
                  <button
                    v-for="h in g.hits"
                    :key="h.sourceId"
                    class="search__result-src"
                    :class="{ 'search__result-src--active': activeHit(g).sourceId === h.sourceId }"
                    @click="picks[g.key] = h.sourceId"
                  >{{ h.sourceName }}</button>
                </div>
              </div>
              <button
                class="search__result-add"
                :class="{ 'search__result-add--done': actionFor(activeHit(g)) === 'added' }"
                @click="doAction(g)"
              >
                {{ actionLabel(activeHit(g)) }}
              </button>
            </div>
          </div>

          <div v-else class="search__empty">
            <p class="search__empty-title">没有搜到「{{ sourceStore.lastKey }}」</p>
            <p class="search__empty-desc">换个书名或作者试试，也可以先在书源管理里启用更多书源。</p>
          </div>

          <p v-if="sourceStore.failures.length" class="search__hint">
            {{ sourceStore.failures.length }} 个书源未返回结果：{{ failureText }}
          </p>

          <p
            v-if="sourceStore.searchScope.total > sourceStore.searchScope.searched"
            class="search__hint"
          >
            已检索 {{ sourceStore.searchScope.searched }}/{{ sourceStore.searchScope.total }} 个启用书源。书源太多时每次只查前 20 个，可在书源管理里停用不用的源。
          </p>
        </template>
      </template>
    </main>
  </div>
</template>

<style scoped>
.search-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.search__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  flex-shrink: 0;
}

.search__back {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  flex-shrink: 0;
}

.search__field {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  /* 44px field: the <input> was a 17px band inside a 36px pill, so a tap on
     the pill's own padding did nothing. */
  height: 44px;
  padding: 0 10px;
  border-radius: 8px;
  background: rgba(120, 120, 128, 0.12);
  color: var(--text-placeholder);
}

.search__field input {
  flex: 1;
  min-width: 0;
  /* Fills the pill so the whole field focuses, not just the 17px text band. */
  align-self: stretch;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.search__field input::placeholder {
  color: var(--text-placeholder);
}

.search__clear {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(120, 120, 128, 0.28);
  color: #fff;
  flex-shrink: 0;
}

.search__submit {
  flex-shrink: 0;
  padding: 0 4px 0 6px;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--accent);
}

.search__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px 16px calc(20px + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.search__setup {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 18px;
  border-radius: 12px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  text-align: center;
  flex-shrink: 0;
}

.search__setup-title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.search__setup-desc {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
}

.search__setup-btn {
  margin-top: 4px;
  min-height: 44px;
  padding: 0 20px;
  display: inline-flex;
  align-items: center;
  border-radius: 16px;
  background: var(--accent);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--on-accent);
}

.search__history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}

.search__history-clear {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.search__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.search__chip {
  max-width: 100%;
  padding: 7px 13px;
  border-radius: 16px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search__chip:active {
  opacity: 0.6;
}

.search__status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 36px 16px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}

.search__results {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: contentIn 180ms var(--page-easing);
}

.search__result {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.search__result + .search__result {
  padding-top: 14px;
  border-top: 0.5px solid var(--divider);
}

.search__result-cover {
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

.search__result-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.search__result-char {
  font-size: 22px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.9);
}

.search__result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 2px;
}

.search__book-title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search__book-author {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search__result-last {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search__result-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.search__result-src {
  padding: 3px 8px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}

.search__result-src--active {
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.search__result-add {
  flex-shrink: 0;
  align-self: center;
  padding: 7px 12px;
  border-radius: 14px;
  background: var(--accent);
  font-size: calc(12px * var(--app-font-scale));
  color: var(--on-accent);
}

.search__result-add--done {
  background: var(--bg-panel);
  color: var(--text-secondary);
}

.search__empty {
  padding: 36px 16px;
  border-radius: 12px;
  background: var(--bg-panel);
  text-align: center;
}

.search__empty-title {
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
  margin-bottom: 6px;
}

.search__empty-desc {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.search__hint {
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
