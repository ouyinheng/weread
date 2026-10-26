<script setup lang="ts">
/**
 * 聚合搜索页。
 *
 * 结果按源分组、逐源回填：一个源 3 秒、一个源 15 秒，不能让用户等最慢的那个。
 * 单源失败只在自己的分组里显示错误，不影响其它源。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { searchSources, type TvSearchOutcome } from '@/utils/tv/cms'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const keyword = ref(String(route.query.q || ''))
const inputEl = ref<HTMLInputElement>()
const outcomes = ref<TvSearchOutcome[]>([])
const searching = ref(false)
const done = ref(0)
const error = ref('')

/**
 * 进程内结果缓存：从详情页返回时不该再打一遍所有源（移动网络上这一来一回
 * 就是十几秒）。同一关键词 60 秒内直接复用。
 */
const searchCache = new Map<string, { at: number; outcomes: TvSearchOutcome[] }>()
const CACHE_TTL = 60 * 1000

const total = computed(() => outcomes.value.reduce((n, o) => n + o.items.length, 0))
const pending = computed(() => Math.max(0, store.enabledSources.length - done.value))

onMounted(async () => {
  await store.load()
  const q = keyword.value.trim()
  const hit = q ? searchCache.get(q) : undefined
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    outcomes.value = hit.outcomes
    done.value = hit.outcomes.length
    return
  }
  // 只在没有关键词时自动聚焦，避免从详情页返回就弹键盘。
  if (!q) {
    await nextTick()
    inputEl.value?.focus()
    return
  }
  await nextTick()
  void run()
})

async function run() {
  const q = keyword.value.trim()
  if (!q || searching.value) return
  if (!store.enabledSources.length) {
    error.value = '还没有启用任何源，先到「源管理」添加'
    return
  }

  error.value = ''
  outcomes.value = []
  done.value = 0
  searching.value = true
  router.replace({ name: 'tvSearch', query: { q } })

  await searchSources(store.enabledSources, q, (outcome) => {
    outcomes.value.push(outcome)
    done.value++
  })

  // 有结果的源排前面，失败/空源沉底
  outcomes.value.sort((a, b) => b.items.length - a.items.length || a.sourceName.localeCompare(b.sourceName, 'zh'))
  searchCache.set(q, { at: Date.now(), outcomes: outcomes.value })
  searching.value = false
}

function openDetail(item: { id: string; sourceId: string }) {
  router.push({ name: 'tvDetail', query: { source: item.sourceId, id: item.id } })
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
          @keyup.enter="run"
        />
      </div>
      <button class="tv-search__submit" :disabled="searching || !keyword.trim()" @click="run">
        {{ searching ? '搜索中' : '搜索' }}
      </button>
    </header>

    <main class="tv-search__body">
      <p v-if="error" class="tv-search__error">{{ error }}</p>

      <div v-if="searching" class="tv-search__progress">
        已完成 {{ done }} / {{ store.enabledSources.length }} 个源
      </div>

      <div v-if="!searching && !outcomes.length && !error" class="tv-search__idle">
        <p class="tv-search__idle-title">输入片名开始搜索</p>
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
            <span class="tv-card__meta">{{ [item.year, item.area].filter(Boolean).join(' · ') || item.typeName || '' }}</span>
          </button>
        </div>
      </section>

      <div v-if="searching && pending" class="tv-search__pending">
        <span class="tv-search__dot" />
        还有 {{ pending }} 个源在路上
      </div>

      <p v-if="!searching && outcomes.length && total === 0" class="tv-search__error">
        所有源都没有结果，换个关键词或换源试试
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
  border-radius: 8px;
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

.tv-search__idle { padding-top: 22vh; text-align: center; }
.tv-search__idle-title { margin: 0 0 6px; font-size: 15px; color: var(--text); }
.tv-search__idle-desc { margin: 0; font-size: 12px; color: var(--text-secondary); }

.tv-search__error {
  margin: 10px 0;
  font-size: 13px;
  color: #d9534f;
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
  gap: 10px 8px;
}
.tv-card {
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
.tv-card:active { opacity: 0.7; }
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
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-card__name {
  margin-top: 6px;
  font-size: 12.5px;
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
</style>
