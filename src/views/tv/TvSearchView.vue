<script setup lang="ts">
/**
 * 聚合搜索页。
 *
 * 结果按源分组、逐源回填：一个源 3 秒、一个源 15 秒，不能让用户等最慢的那个。
 * 五个源各给一个分组，哪几个源有这个片子、各自多少条，一眼能看出来。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { peekSearch, saveSearch } from '@/utils/tv/cache'
import { searchSources, type TvSearchOutcome } from '@/utils/tv/cms'
import type { TvItem } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const HISTORY_KEY = 'weread.tv.search.v1'

const keyword = ref(String(route.query.q || ''))
const inputEl = ref<HTMLInputElement>()
const outcomes = ref<TvSearchOutcome[]>([])
const searching = ref(false)
const done = ref(0)
const error = ref('')
const recent = ref<string[]>([])

/**
 * 结果缓存在 utils/tv/cache 里（模块级，跨页面复用）：从详情页返回、
 * 重复搜同一个词都不该再打一遍所有源，移动网络上这一来一回就是十几秒。
 */
const total = computed(() => outcomes.value.reduce((n, o) => n + o.items.length, 0))
const pending = computed(() => Math.max(0, store.enabledSources.length - done.value))
const failed = computed(() => outcomes.value.filter(o => o.error))

onMounted(async () => {
  await store.load()
  loadRecent()
  const q = keyword.value.trim()
  // 只在没有关键词时自动聚焦，避免从详情页返回就弹键盘。
  if (!q) {
    await nextTick()
    inputEl.value?.focus()
    return
  }
  await nextTick()
  // 带关键词进来（含从详情页返回）：run 内部先查缓存，命中就不重搜。
  void run()
})

function loadRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    recent.value = Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string').slice(0, 8) : []
  } catch {
    recent.value = []
  }
}

function remember(q: string) {
  recent.value = [q, ...recent.value.filter(v => v !== q)].slice(0, 8)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(recent.value))
  } catch {
    // 隐私模式：本次会话内仍然可用。
  }
}

function clearRecent() {
  recent.value = []
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // ignore
  }
}

async function run(word?: string) {
  const q = String(word ?? keyword.value).trim()
  if (!q || searching.value) return
  keyword.value = q
  if (!store.enabledSources.length) {
    error.value = '还没有启用任何源，先到「源管理」添加'
    return
  }

  error.value = ''
  remember(q)
  router.replace({ name: 'tvSearch', query: { q } })

  // 刚搜过的词直接复用结果，秒开，不重打接口。
  const cached = peekSearch(q)
  if (cached) {
    outcomes.value = cached
    done.value = cached.length
    return
  }

  outcomes.value = []
  done.value = 0
  searching.value = true

  await searchSources(store.enabledSources, q, (outcome) => {
    outcomes.value.push(outcome)
    done.value++
  })

  // 保持源在「源管理」里的顺序，结果陆续回来时分组不会来回跳。
  const order = new Map(store.enabledSources.map((s, i) => [s.id, i]))
  outcomes.value.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0))
  saveSearch(q, outcomes.value)
  searching.value = false
}

function clearInput() {
  keyword.value = ''
  outcomes.value = []
  done.value = 0
  error.value = ''
  router.replace({ name: 'tvSearch' })
  void nextTick(() => inputEl.value?.focus())
}

function openDetail(item: TvItem) {
  router.push({ name: 'tvDetail', query: { source: item.sourceId, id: item.id } })
}

function metaOf(item: TvItem): string {
  return [item.year, item.area, item.typeName].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="tv-search">
    <header class="tv-search__bar">
      <button class="tv-search__back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <div class="tv-search__field">
        <Icon name="search" :size="16" />
        <input
          ref="inputEl"
          v-model="keyword"
          class="tv-search__input"
          type="search"
          placeholder="搜电影、剧集、综艺"
          enterkeyhint="search"
          @keyup.enter="run()"
        />
        <button v-if="keyword" class="tv-search__clear" aria-label="清空" @click="clearInput">
          <Icon name="close" :size="14" :width="2" />
        </button>
      </div>
      <button class="tv-search__submit" :disabled="searching || !keyword.trim()" @click="run()">
        {{ searching ? '搜索中' : '搜索' }}
      </button>
    </header>

    <main class="tv-search__body">
      <p v-if="error" class="tv-search__error">{{ error }}</p>

      <div v-if="searching" class="tv-search__progress">
        已完成 {{ done }} / {{ store.enabledSources.length }} 个源
      </div>

      <div v-if="!searching && !outcomes.length && !error" class="tv-search__idle" :class="{ 'tv-search__idle--empty': !recent.length }">
        <p v-if="recent.length" class="tv-search__idle-label">
          <span>最近搜索</span>
          <button class="tv-search__clear-history" @click="clearRecent">清空</button>
        </p>
        <div v-if="recent.length" class="tv-search__chips">
          <button v-for="word in recent" :key="word" class="tv-chip" @click="run(word)">
            {{ word }}
          </button>
        </div>
        <p v-else class="tv-search__idle-title">输入片名开始搜索</p>
        <p class="tv-search__idle-desc">会同时查询 {{ store.enabledSources.length }} 个已启用的源</p>
      </div>

      <section v-for="o in outcomes" :key="o.sourceId" class="tv-group">
        <div class="tv-group__head">
          <span class="tv-group__name">{{ o.sourceName }}</span>
          <span class="tv-group__count">
            {{ o.error ? o.error : `${o.items.length} 条` }}
          </span>
        </div>

        <div v-if="o.items.length" class="tv-grid">
          <button
            v-for="item in o.items"
            :key="item.id"
            class="tv-card"
            @click="openDetail(item)"
          >
            <div class="tv-card__cover">
              <img v-if="item.pic" :src="item.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="tv-card__ph">{{ item.name.slice(0, 2) }}</span>
              <span v-if="item.remarks" class="tv-card__remark">{{ item.remarks }}</span>
            </div>
            <span class="tv-card__name">{{ item.name }}</span>
            <span class="tv-card__meta">{{ metaOf(item) }}</span>
          </button>
        </div>
      </section>

      <div v-if="searching && !outcomes.length" class="tv-skeleton-grid">
        <span v-for="n in 6" :key="n" class="tv-skeleton" />
      </div>

      <div v-if="searching && pending" class="tv-search__pending">
        <span class="tv-search__dot" />
        还有 {{ pending }} 个源在路上
      </div>

      <p v-if="!searching && done && !total" class="tv-search__error">
        所有源都没有结果，换个关键词或换源试试
      </p>

      <p v-if="!searching && failed.length" class="tv-search__failed">
        {{ failed.length }} 个源没有响应：{{ failed.map(f => f.sourceName).join('、') }}
      </p>
    </main>
  </div>
</template>

<style scoped>
.tv-search {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.tv-search__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(8px + var(--safe-top)) 10px 8px;
  border-bottom: 1px solid var(--divider);
}
.tv-search__back {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  background: transparent;
  color: var(--text);
}
.tv-search__field {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border-radius: 17px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.tv-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
}
.tv-search__input::-webkit-search-cancel-button { display: none; }
.tv-search__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: var(--divider);
  color: var(--bg);
}
.tv-search__submit {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 14px;
  font-family: inherit;
  padding: 6px 4px;
}
.tv-search__submit:disabled { color: var(--text-secondary); }

.tv-search__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 10px 14px calc(20px + var(--safe-bottom));
}

.tv-search__progress,
.tv-search__pending {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 8px;
}
.tv-search__pending { display: flex; align-items: center; gap: 6px; }
.tv-search__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }

.tv-search__idle { padding-top: 6px; }
.tv-search__idle--empty { padding-top: 16vh; }
.tv-search__idle-title { margin: 0 0 6px; font-size: 15px; color: var(--text); text-align: center; }
.tv-search__idle-desc { margin: 0; font-size: 12px; color: var(--text-secondary); }
.tv-search__idle--empty .tv-search__idle-desc { text-align: center; }
.tv-search__idle-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}
.tv-search__clear-history {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-search__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 22px;
}
.tv-chip {
  max-width: 46%;
  border: 0;
  border-radius: 15px;
  padding: 6px 13px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-chip:active { opacity: 0.7; }

.tv-search__error {
  margin: 10px 0;
  font-size: 13px;
  color: #d9534f;
}
.tv-search__failed {
  margin: 16px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.tv-group { margin-bottom: 20px; }
.tv-group__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.tv-group__name { font-size: 14px; font-weight: 600; color: var(--text); }
.tv-group__count { font-size: 11px; color: var(--text-secondary); }

.tv-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px 9px;
}
.tv-card {
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
.tv-card:active { opacity: 0.72; }
.tv-card__cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tv-card__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tv-card__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 18px;
  color: var(--text-secondary);
}
.tv-card__remark {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 12px 6px 4px;
  font-size: 10px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-card__name {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tv-card__meta {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px 9px;
}
.tv-skeleton {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  background: var(--bg-secondary);
  animation: tv-pulse 1.2s ease-in-out infinite;
}
@keyframes tv-pulse { 50% { opacity: 0.45; } }
</style>
