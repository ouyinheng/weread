<script setup lang="ts">
/**
 * 影视首页（tab）。
 *
 * 布局对齐长视频 App 的信息层级：搜索入口在最上，接着频道 chips 和海报墙。
 * 列表数据缓存 24 小时（内存 + localStorage，跨启动也有效）：返回本页或在
 * tab 之间来回切都不重新打接口；想立刻看新的就下拉刷新。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { peekLatest, saveLatest } from '@/utils/tv/cache'
import { latestFrom } from '@/utils/tv/cms'
import type { TvItem } from '@/utils/tv/types'

// 组件名对上 App.vue 的 keep-alive include，tab 页面才不会一返回就整页重建。
defineOptions({ name: 'tv' })

const router = useRouter()
const store = useTvStore()

const items = ref<TvItem[]>([])
const loading = ref(false)
const error = ref('')
const activeCat = ref('全部')
/** 缓存时间戳，用来在标题行显示「更新于 …」。 */
const updatedAt = ref(0)

/* ---------- 下拉刷新 ---------- */
const PULL_TRIGGER = 56
const PULL_MAX = 72
const pull = ref(0)
const refreshing = ref(false)
let pullStartY = 0
const dragging = ref(false)

function onTouchStart(e: TouchEvent): void {
  if (refreshing.value) return
  const el = e.currentTarget as HTMLElement
  // 只有在顶部才接管，否则会和正常滚动打架
  if (el.scrollTop > 0) return
  pullStartY = e.touches[0].clientY
  dragging.value = true
}

function onTouchMove(e: TouchEvent): void {
  if (!dragging.value || refreshing.value) return
  const dy = e.touches[0].clientY - pullStartY
  if (dy <= 0) {
    pull.value = 0
    return
  }
  // 阻尼：手指走 2px，指示器走 1px，阻尼感接近原生
  pull.value = Math.min(PULL_MAX, dy * 0.5)
  if (pull.value > 4) e.preventDefault()
}

async function onTouchEnd(): Promise<void> {
  if (!dragging.value) return
  dragging.value = false
  if (pull.value < PULL_TRIGGER) {
    pull.value = 0
    return
  }
  pull.value = PULL_TRIGGER
  refreshing.value = true
  // silent：旧内容留着，只让指示器转，不闪一层骨架
  await reload({ silent: items.value.length > 0 })
  refreshing.value = false
  pull.value = 0
}

/** 缓存时间 → 「12:04 更新」/「昨天 22:10 更新」。 */
const updatedText = computed(() => {
  if (!updatedAt.value) return ''
  const d = new Date(updatedAt.value)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? `${hm} 更新` : `${d.getMonth() + 1}/${d.getDate()} ${hm} 更新`
})

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

const hasSources = computed(() => store.sources.length > 0)

/** 频道：只在片库里真有内容的频道才出 chip，点了空频道不会有空墙。 */
const cats = computed(() => CATEGORY_ORDER.filter(cat => items.value.some(i => categoryOf(i) === cat)))

const chips = computed(() => ['全部', ...cats.value])

/**
 * 每个频道（含「全部」）都用同一套海报墙。
 *
 * 之前「全部」是多条横滑带（刚刚上架 + 每个频道一条），其它频道是网格，
 * 点一下 chip 版式就换一种，读起来像两个页面。现在统一成网格。
 */
const activeGrid = computed(() =>
  activeCat.value === '全部' ? items.value : items.value.filter(i => categoryOf(i) === activeCat.value),
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
    updatedAt.value = cached.at
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
    updatedAt.value = Date.now()
    // 静默换新后选中的频道可能没了，退回「全部」，不留空海报墙。
    if (activeCat.value !== '全部' && !chips.value.includes(activeCat.value)) activeCat.value = '全部'
  } else if (!items.value.length) {
    error.value = '最近更新暂时拉不到，去「我 → 视频源管理」测一下源'
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
    </header>

    <main
      class="tv__body"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
      <!-- 下拉刷新指示器：高度跟着手指走，松手过阈值才真刷新 -->
      <div
        class="tv__pull"
        :style="{
          height: (refreshing ? PULL_TRIGGER : pull) + 'px',
          transition: dragging ? 'none' : '',
        }"
        :class="{ 'tv__pull--ready': pull >= PULL_TRIGGER && !refreshing }"
        aria-hidden="true"
      >
        <span class="tv__pull-spin" :class="{ 'tv__pull-spin--on': refreshing }" />
        <span class="tv__pull-text">
          {{ refreshing ? '正在刷新…' : pull >= PULL_TRIGGER ? '松开刷新' : '下拉刷新' }}
        </span>
      </div>

      <div v-if="!hasSources" class="tv__empty">
        <div class="tv__empty-icon">
          <Icon name="media" :size="48" :width="0.95" />
        </div>
        <p class="tv__empty-title">还没有视频源</p>
        <p class="tv__empty-desc">添加苹果 CMS 接口地址后即可搜索播放</p>
        <button class="tv__empty-btn" @click="goSources">添加视频源</button>
      </div>

      <template v-else>
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

        <section class="tv__section">
          <div class="tv__section-head">
            <h2 class="tv__section-title">{{ activeCat }}</h2>
            <span class="tv__section-from">
              {{ activeGrid.length }} 部<template v-if="updatedText"> · {{ updatedText }}</template>
            </span>
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
  /* 下拉手势自己处理，别让 WebView 再加一层回弹 */
  overscroll-behavior-y: contain;
  /* 列表页不该横向滚动；万一某个子元素算宽了，裁掉而不是整页跟着滑 */
  overflow-x: hidden;
  /* 列表页不该横向滚动；万一某个子元素算宽了，裁掉而不是整页跟着滑 */
  overflow-x: hidden;
  padding: 4px 0 calc(20px + var(--safe-bottom));
}

.tv__pull {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: calc(12px * var(--app-font-scale));
  transition: height 160ms var(--ease-standard);
}

.tv__pull--ready {
  color: var(--accent);
}

.tv__pull-spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.6px solid var(--divider);
  border-top-color: var(--accent);
  /* 静止时停在 0 度，刷新时转起来 */
}

.tv__pull-spin--on {
  animation: tv-spin 700ms linear infinite;
}

@keyframes tv-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .tv__pull-spin--on { animation-duration: 2s; }
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

/*
 * 列数跟屏幕走：窄屏 3 列，平板/横屏自动加列，不再死写 3 列。
 * 另外 grid item 默认 min-width:auto，会被标题的 min-content 撑大
 * （标题是 nowrap + ellipsis，但 min-content 仍是整行文字），一撑就把
 * 整个网格顶出屏幕——这就是之前能左右滑的原因。下面那条 min-width:0 是
 * 关键，不能删。
 */
.tv__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 14px 10px;
  padding: 0 16px 4px;
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
  min-width: 0;
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
</style>
