<script setup lang="ts">
/**
 * 影视首页（tab）。
 *
 * 布局对齐长视频 App 的信息层级：搜索入口在最上，接着「继续观看」和频道
 * chips；「全部」是按分区横滑的片库（刚刚上架 / 电影 / 电视剧…），点具体
 * 频道进海报墙。列表数据走页面级缓存：返回本页或来回切 tab 都不重新打
 * 接口，过期才静默换新，避免一回来就转圈。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { peekLatest, saveLatest } from '@/utils/tv/cache'
import { latestFrom } from '@/utils/tv/cms'
import type { TvHistoryEntry, TvItem } from '@/utils/tv/types'

// 组件名对上 App.vue 的 keep-alive include，tab 页面才不会一返回就整页重建。
defineOptions({ name: 'tv' })

const router = useRouter()
const store = useTvStore()

const items = ref<TvItem[]>([])
const loading = ref(false)
const error = ref('')
const activeCat = ref('全部')

const CATEGORY_ORDER = ['电影', '电视剧', '综艺', '动漫', '纪录片']

function categoryOf(item: TvItem): string {
  const t = item.typeName || ''
  if (!t) return '其他'
  if (/纪录/.test(t)) return '纪录片'
  if (/电影|影片/.test(t)) return '电影'
  if (/剧/.test(t)) return '电视剧'
  if (/综艺|真人/.test(t)) return '综艺'
  if (/动漫|动画|卡通/.test(t)) return '动漫'
  return '其他'
}

interface Rail {
  key: string
  title: string
  items: TvItem[]
}

const recent = computed(() => store.history.slice(0, 12))
const hasSources = computed(() => store.sources.length > 0)

/** 「全部」下的分区：最新一批在前，然后按频道各一条横滑带。 */
const rails = computed<Rail[]>(() => {
  const out: Rail[] = []
  const fresh = items.value.slice(0, 12)
  if (fresh.length) out.push({ key: 'new', title: '刚刚上架', items: fresh })
  for (const cat of CATEGORY_ORDER) {
    const list = items.value.filter(i => categoryOf(i) === cat)
    if (list.length >= 4) out.push({ key: cat, title: cat, items: list })
  }
  return out
})

const chips = computed(() => ['全部', ...rails.value.filter(r => r.key !== 'new').map(r => r.title)])

/** 点了具体频道就进海报墙。 */
const activeGrid = computed(() =>
  activeCat.value === '全部' ? [] : items.value.filter(i => categoryOf(i) === activeCat.value),
)

onMounted(sync)
/**
 * keep-alive 回到本页时按缓存新鲜度决定要不要换新。首次激活紧跟
 * onMounted，跳过一次避免重复拉。
 */
let activatedBefore = false
onActivated(() => {
  if (!activatedBefore) {
    activatedBefore = true
    return
  }
  void sync()
})

/** 有缓存先画缓存；不新鲜才去拉，拉的时候有旧数据就不转圈。 */
async function sync() {
  await store.load()
  const cached = peekLatest()
  if (cached) {
    items.value = cached.items
    if (cached.fresh) return
  }
  void reload({ silent: items.value.length > 0 })
}

/** 逐源拉第一页合并去重：一个源只给一页，多并几个源片库才够分频道。 */
async function reload(opts: { silent?: boolean } = {}) {
  const sources = store.enabledSources.slice(0, 3)
  if (!sources.length) return
  if (!opts.silent) loading.value = true
  error.value = ''

  const results = await Promise.allSettled(sources.map(s => latestFrom(s, 30)))
  const merged: TvItem[] = []
  const seen = new Set<string>()
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const it of r.value) {
      if (seen.has(it.name)) continue
      seen.add(it.name)
      merged.push(it)
    }
  }

  if (merged.length) {
    items.value = merged
    saveLatest(merged)
    // 静默换新后选中的频道可能没了，退回「全部」，不留空海报墙。
    if (activeCat.value !== '全部' && !chips.value.includes(activeCat.value)) activeCat.value = '全部'
  } else if (!items.value.length) {
    error.value = '最近更新暂时拉不到，进「管理」测一下源'
  }
  loading.value = false
}

function goSearch() {
  router.push({ name: 'tvSearch' })
}

function goSources() {
  router.push({ name: 'tvSources' })
}

function openItem(item: TvItem) {
  router.push({ name: 'tvDetail', query: { source: item.sourceId, id: item.id } })
}

function resume(h: TvHistoryEntry) {
  router.push({
    name: 'tvPlay',
    query: { source: h.sourceId, id: h.vodId, g: String(h.groupIndex), e: String(h.episodeIndex) },
  })
}

function percentOf(h: TvHistoryEntry): number {
  if (!h.duration) return 0
  return Math.min(100, Math.max(2, Math.round((h.position / h.duration) * 100)))
}

function episodeLabel(h: TvHistoryEntry): string {
  const pct = percentOf(h)
  return pct > 2 ? `看到 ${h.episodeName} · ${pct}%` : h.episodeName
}

function metaOf(item: TvItem): string {
  return [item.year, item.area].filter(Boolean).join(' · ') || item.typeName || ''
}
</script>

<template>
  <div class="tv tab-page">
    <header class="tv__top">
      <button class="tv__search" @click="goSearch">
        <Icon name="search" :size="17" />
        <span class="tv__search-text">搜电影、剧集、综艺</span>
      </button>
      <!-- Same order as the shelf: search pill first, then the title row.
           The title element was here but empty, which is why this tab started
           90px higher than 书架 and had no way into 视频源管理. -->
      <div class="tv__head">
        <h1 class="tv__title">影视</h1>
        <button class="tv__manage" @click="goSources">管理视频源</button>
      </div>
    </header>

    <main class="tv__body">
      <div v-if="!hasSources" class="tv__empty">
        <div class="tv__empty-icon">
          <Icon name="media" :size="48" :width="0.95" />
        </div>
        <p class="tv__empty-title">还没有视频源</p>
        <p class="tv__empty-desc">添加苹果 CMS 接口地址后即可搜索播放</p>
        <button class="tv__empty-btn" @click="goSources">添加视频源</button>
      </div>

      <template v-else>
        <section v-if="recent.length" class="tv__section">
          <div class="tv__section-head">
            <h2 class="tv__section-title">继续观看</h2>
            <button class="tv__section-more" @click="goSearch">去找片</button>
          </div>
          <div class="tv__rail">
            <button v-for="h in recent" :key="h.key" class="tv-continue" @click="resume(h)">
              <div class="tv-continue__pic">
                <img v-if="h.pic" :src="h.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
                <span v-else class="tv-continue__ph">{{ h.name.slice(0, 2) }}</span>
                <span class="tv-continue__play">
                  <Icon name="play" :size="15" :width="2" />
                </span>
                <span class="tv-continue__bar">
                  <span class="tv-continue__bar-fill" :style="{ width: percentOf(h) + '%' }" />
                </span>
              </div>
              <span class="tv-continue__name">{{ h.name }}</span>
              <span class="tv-continue__sub">{{ episodeLabel(h) }}</span>
            </button>
          </div>
        </section>

        <div v-if="chips.length > 1" class="tv__chips">
          <button
            v-for="c in chips"
            :key="c"
            class="tv-chip"
            :class="{ 'tv-chip--on': activeCat === c }"
            @click="activeCat = c"
          >
            {{ c }}
          </button>
        </div>

        <template v-if="activeCat === '全部'">
          <section v-for="rail in rails" :key="rail.key" class="tv__section">
            <div class="tv__section-head">
              <h2 class="tv__section-title">{{ rail.title }}</h2>
              <span v-if="rail.key !== 'new'" class="tv__section-from">{{ rail.items.length }} 部</span>
            </div>
            <div class="tv__rail">
              <button
                v-for="item in rail.items"
                :key="item.id + item.sourceId"
                class="tv-poster"
                @click="openItem(item)"
              >
                <div class="tv-poster__pic">
                  <img v-if="item.pic" :src="item.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
                  <span v-else class="tv-poster__ph">{{ item.name.slice(0, 2) }}</span>
                  <span v-if="item.remarks" class="tv-poster__badge">{{ item.remarks }}</span>
                </div>
                <span class="tv-poster__name">{{ item.name }}</span>
                <span class="tv-poster__meta">{{ metaOf(item) }}</span>
              </button>
            </div>
          </section>
        </template>

        <section v-else class="tv__section">
          <div class="tv__section-head">
            <h2 class="tv__section-title">{{ activeCat }}</h2>
            <span class="tv__section-from">{{ activeGrid.length }} 部</span>
          </div>
          <div class="tv__grid">
            <button
              v-for="item in activeGrid"
              :key="item.id + item.sourceId"
              class="tv-poster"
              @click="openItem(item)"
            >
              <div class="tv-poster__pic">
                <img v-if="item.pic" :src="item.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
                <span v-else class="tv-poster__ph">{{ item.name.slice(0, 2) }}</span>
                <span v-if="item.remarks" class="tv-poster__badge">{{ item.remarks }}</span>
              </div>
              <span class="tv-poster__name">{{ item.name }}</span>
              <span class="tv-poster__meta">{{ metaOf(item) }}</span>
            </button>
          </div>
        </section>

        <div v-if="loading" class="tv__rail">
          <span v-for="n in 6" :key="n" class="tv-skeleton" />
        </div>

        <p v-else-if="error" class="tv__rail-error" @click="reload()">{{ error }}，点此重试</p>

        <section class="tv__source-row">
          <span class="tv__source-dot" />
          <span class="tv__source-text">
            {{ store.enabledSources.length }} / {{ store.sources.length }} 个源已启用
          </span>
          <button class="tv__source-link" @click="goSources">源管理</button>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.tv {
  background: var(--bg-page);
}

.tv__top {
  padding: calc(10px + var(--safe-top)) 16px 6px;
}
.tv__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 44px band like the shelf's title row, so switching tabs does not shift the
     content origin. */
  min-height: 44px;
  margin-top: 4px;
}
.tv__title {
  margin: 0;
  /* Matches 书架 (20px / 600 / --text-title). */
  font-size: calc(20px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text-title);
}
.tv__manage {
  display: flex;
  align-items: center;
  height: 44px;
  border: 0;
  padding: 0 2px 0 8px;
  background: transparent;
  color: var(--text);
  font-size: calc(15px * var(--app-font-scale));
  font-family: inherit;
}
.tv__manage:active {
  opacity: 0.6;
}

.tv__search {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: 22px;
  background: var(--bg);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
}
.tv__search:active {
  opacity: 0.75;
}
.tv__search-text {
  font-size: 13px;
}

.tv__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 0 calc(20px + var(--safe-bottom));
}

.tv__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14vh 24px 0;
  text-align: center;
}
.tv__empty-icon {
  color: var(--text-secondary);
  opacity: 0.55;
}
.tv__empty-title {
  margin: 16px 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.tv__empty-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.tv__empty-btn {
  margin-top: 20px;
  min-height: 44px;
  border: 0;
  border-radius: 20px;
  padding: 9px 22px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-family: inherit;
}
.tv__empty-btn:active {
  background: var(--accent-press);
}

.tv__section {
  margin-top: 18px;
}
.tv__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 16px;
  margin-bottom: 10px;
}
.tv__section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.tv__section-more,
.tv__section-from {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}

/* 频道 chips：横滑一排，选中态用填充色，和搜索页的标签同源。 */
.tv__chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding: 14px 16px 2px;
  scrollbar-width: none;
}
.tv__chips::-webkit-scrollbar {
  display: none;
}
.tv-chip {
  flex: 0 0 auto;
  border: 0;
  border-radius: 15px;
  padding: 6px 14px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.tv-chip--on {
  background: var(--accent);
  color: var(--on-accent);
}
.tv-chip:active {
  opacity: 0.7;
}

.tv__rail {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 16px 4px;
  scrollbar-width: none;
}
.tv__rail::-webkit-scrollbar {
  display: none;
}

.tv__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px 10px;
  padding: 0 16px 4px;
}

.tv-continue {
  flex: 0 0 auto;
  width: 128px;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
.tv-continue:active {
  opacity: 0.75;
}
.tv-continue__pic {
  position: relative;
  width: 128px;
  height: 76px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tv-continue__pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tv-continue__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 18px;
  color: var(--text-secondary);
}
.tv-continue__play {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  backdrop-filter: blur(2px);
}
.tv-continue__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.25);
}
.tv-continue__bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}
.tv-continue__name {
  display: block;
  margin-top: 7px;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-continue__sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-poster {
  flex: 0 0 auto;
  width: 104px;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
.tv__grid .tv-poster {
  width: 100%;
}
.tv-poster:active {
  opacity: 0.75;
}
.tv-poster__pic {
  position: relative;
  width: 100%;
  aspect-ratio: 104 / 146;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tv-poster__pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tv-poster__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 19px;
  color: var(--text-secondary);
}
.tv-poster__badge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 6px 4px;
  font-size: 10.5px;
  color: #fff;
  text-align: right;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.72));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-poster__name {
  display: block;
  margin-top: 7px;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-poster__meta {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-skeleton {
  flex: 0 0 auto;
  width: 104px;
  height: 146px;
  border-radius: 8px;
  background: var(--bg-secondary);
  animation: tvPulse 1.2s ease-in-out infinite;
}
@keyframes tvPulse {
  50% {
    opacity: 0.55;
  }
}

.tv__rail-error {
  margin: 6px 16px 0;
  padding: 14px 12px;
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.tv__source-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 22px 16px 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-secondary);
}
.tv__source-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.tv__source-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.tv__source-link {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-family: inherit;
}
</style>
