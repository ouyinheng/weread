<script setup lang="ts">
/**
 * 影片详情：背景、简介、线路与剧集。
 *
 * 参考长视频 App 的做法——封面当背景虚化，主按钮直接给「继续看 / 播放第一集」，
 * 剧集默认只露前 20 集，其余点「展开全部」，避免一屏几十个按钮把人压住。
 *
 * 线路默认选「集数最多」的一条：采集站常见的情况是线路 2 才是全的，按顺序选
 * 第一条会让用户以为没更新。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import MorphIcon from '@/components/MorphIcon.vue'
import { useTvStore } from '@/stores/tv'
import { fetchDetail } from '@/utils/tv/cms'
import type { TvDetail } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const sourceId = String(route.query.source || '')
const vodId = String(route.query.id || '')

const COLLAPSED = 20

const detail = ref<TvDetail>()
const loading = ref(true)
const error = ref('')
const groupIndex = ref(0)
const descOpen = ref(false)
const showAll = ref(false)
const reversed = ref(false)

const group = computed(() => detail.value?.groups[groupIndex.value])
const last = computed(() => store.historyOf(sourceId, vodId))
const episodeCount = computed(() => group.value?.episodes.length || 0)

const glowStyle = computed(() => (detail.value?.pic ? { backgroundImage: `url(${detail.value.pic})` } : {}))
/** 短简介不需要「展开」这个假按钮。 */
const descLong = computed(() => (detail.value?.desc?.length || 0) > 80)

/** 线路按正序/倒序展示，但点击时仍要拿原始下标。 */
const orderedEps = computed(() => {
  const eps = group.value?.episodes || []
  const list = eps.map((ep, index) => ({ ep, index }))
  return reversed.value ? list.reverse() : list
})
const visibleEps = computed(() =>
  showAll.value || orderedEps.value.length <= COLLAPSED
    ? orderedEps.value
    : orderedEps.value.slice(0, COLLAPSED),
)
const hiddenCount = computed(() => Math.max(0, orderedEps.value.length - COLLAPSED))

/** 秒 → m:ss / h:mm:ss */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

/** 主按钮：看过就续看，没看过就从第一集。 */
const primary = computed(() => {
  const l = last.value
  const resumeGroup = l ? detail.value?.groups[l.groupIndex] : undefined
  if (l && resumeGroup && l.episodeIndex < resumeGroup.episodes.length) {
    return { gi: l.groupIndex, ei: l.episodeIndex, label: '续看' }
  }
  return { gi: groupIndex.value, ei: 0, label: episodeCount.value ? '播放第 1 集' : '播放' }
})

onMounted(async () => {
  await store.load()
  const source = store.sources.find(s => s.id === sourceId)
  if (!source) {
    error.value = '源不存在，可能已被删除'
    loading.value = false
    return
  }
  try {
    detail.value = await fetchDetail(source, vodId)
    groupIndex.value = bestGroupIndex(detail.value)
  } catch (e) {
    error.value = (e as Error)?.message || '加载失败'
  } finally {
    loading.value = false
  }
})

/** 集数最多的线路，并列时取靠前的。 */
function bestGroupIndex(d: TvDetail): number {
  let best = 0
  d.groups.forEach((g, i) => {
    if (g.episodes.length > (d.groups[best]?.episodes.length || 0)) best = i
  })
  return best
}

function play(episodeIndex: number, gi = groupIndex.value) {
  router.push({
    name: 'tvPlay',
    query: { source: sourceId, id: vodId, g: String(gi), e: String(episodeIndex) },
  })
}

function metaText(): string {
  return [detail.value?.year, detail.value?.area, detail.value?.typeName].filter(Boolean).join(' · ')
}

/* ---- 模板事件 ---- */
function handleBack(): void {
  router.back()
}

function handlePlayPrimary(): void {
  play(primary.value.ei, primary.value.gi)
}

function handleToggleDesc(): void {
  descOpen.value = !descOpen.value
}

function handlePickGroup(i: number): void {
  groupIndex.value = i
  showAll.value = false
}

function handleToggleOrder(): void {
  reversed.value = !reversed.value
}

function handlePlayEpisode(row: { index: number }): void {
  play(row.index)
}

function handleToggleShowAll(): void {
  showAll.value = !showAll.value
}
</script>

<template>
  <div class="tv-detail">
    <header class="tv-detail__bar">
      <button class="tv-detail__back" aria-label="返回" @click="handleBack">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <span class="tv-detail__bar-title">{{ detail?.name || '详情' }}</span>
    </header>

    <main class="tv-detail__body">
      <div v-if="loading" class="tv-detail__state">正在加载…</div>
      <div v-else-if="error" class="tv-detail__state tv-detail__state--error">{{ error }}</div>

      <template v-else-if="detail">
        <section class="tv-hero">
          <div class="tv-hero__glow" :style="glowStyle" />
          <div class="tv-hero__inner">
            <div class="tv-hero__cover">
              <img v-if="detail.pic" :src="detail.pic" alt="" referrerpolicy="no-referrer" />
              <span v-else class="tv-hero__ph">{{ detail.name.slice(0, 2) }}</span>
            </div>
            <div class="tv-hero__info">
              <h1 class="tv-hero__name">{{ detail.name }}</h1>
              <p v-if="metaText()" class="tv-hero__meta">{{ metaText() }}</p>
              <div class="tv-hero__tags">
                <span v-if="detail.remarks" class="tv-hero__tag tv-hero__tag--accent">{{
                  detail.remarks
                }}</span>
                <span v-if="episodeCount" class="tv-hero__tag">全 {{ episodeCount }} 集</span>
                <span class="tv-hero__tag">{{ detail.source.name }}</span>
              </div>
            </div>
          </div>
        </section>

        <div class="tv-actions">
          <button class="tv-actions__primary" @click="handlePlayPrimary">
            <Icon name="play" :size="16" :width="2" />
            <span>{{ primary.label }}</span>
          </button>
          <!-- 一句话说清「看的是哪一集、看到哪」；按钮只写动作，
               不重复剧集名（原来按钮和这里是同一句话）。 -->
          <span v-if="last" class="tv-actions__hint">
            {{ last.episodeName }} · 上次看到 {{ mmss(last.position) }}
          </span>
        </div>

        <section v-if="detail.desc" class="tv-desc" :class="{ 'tv-desc--open': descOpen }">
          <p class="tv-desc__text">{{ detail.desc }}</p>
          <button v-if="descLong" class="tv-desc__toggle" @click="handleToggleDesc">
            {{ descOpen ? '收起' : '展开' }}
          </button>
        </section>

        <section v-if="detail.groups.length" class="tv-eps">
          <div v-if="detail.groups.length > 1" class="tv-eps__groups">
            <button
              v-for="(g, i) in detail.groups"
              :key="g.name + i"
              class="tv-eps__group"
              :class="{ 'tv-eps__group--active': i === groupIndex }"
              @click="handlePickGroup(i)"
            >
              {{ g.name }}（{{ g.episodes.length }}）
            </button>
          </div>

          <div class="tv-eps__head">
            <span class="tv-eps__title">选集</span>
            <span class="tv-eps__count">{{ episodeCount }} 集</span>
            <button class="tv-eps__order" @click="handleToggleOrder">
              {{ reversed ? '倒序' : '正序' }}
            </button>
          </div>

          <div class="tv-eps__grid">
            <button
              v-for="row in visibleEps"
              :key="row.ep.url"
              class="tv-eps__item"
              :class="{
                'tv-eps__item--last':
                  last && last.groupIndex === groupIndex && last.episodeIndex === row.index,
              }"
              @click="handlePlayEpisode(row)"
            >
              {{ row.ep.name }}
            </button>
          </div>

          <button v-if="hiddenCount" class="tv-eps__more" @click="handleToggleShowAll">
            {{ showAll ? '收起剧集' : `展开全部 ${episodeCount} 集` }}
            <MorphIcon :name="showAll ? 'chevron-down' : 'chevron-right'" :size="14" />
          </button>
        </section>

        <div v-else class="tv-detail__state">这个源没有返回可播放地址，换一个源试试</div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.tv-detail {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.tv-detail__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(8px + var(--safe-top)) 10px 8px;
  background: linear-gradient(rgba(0, 0, 0, 0.35), transparent);
}
.tv-detail__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  background: transparent;
  color: #fff;
}
.tv-detail__bar-title {
  font-size: 15px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 0 calc(24px + var(--safe-bottom));
}
.tv-detail__state {
  padding: 40px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}
.tv-detail__state--error {
  color: #d9534f;
}

.tv-hero {
  position: relative;
  padding: calc(52px + var(--safe-top)) 16px 14px;
  overflow: hidden;
}
.tv-hero__glow {
  position: absolute;
  inset: -20% -10% -10%;
  background-size: cover;
  background-position: center;
  filter: blur(26px) saturate(1.2);
  opacity: 0.4;
  transform: scale(1.1);
  pointer-events: none;
}
.tv-hero__glow::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(var(--bg) 12%, rgba(0, 0, 0, 0.25) 55%, var(--bg) 96%);
}
.tv-hero__inner {
  position: relative;
  display: flex;
  gap: 14px;
  align-items: flex-end;
}
.tv-hero__cover {
  flex: 0 0 auto;
  width: 104px;
  height: 146px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
}
.tv-hero__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tv-hero__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 22px;
  color: var(--text-secondary);
}
.tv-hero__info {
  flex: 1;
  min-width: 0;
  padding-bottom: 2px;
}
.tv-hero__name {
  margin: 0 0 6px;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tv-hero__meta {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.tv-hero__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tv-hero__tag {
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 10.5px;
  line-height: 1.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-hero__tag--accent {
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.tv-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 16px 2px;
}
.tv-actions__primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1;
  height: 42px;
  border: 0;
  border-radius: 21px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
}
.tv-actions__primary:active {
  background: var(--accent-press);
}
.tv-actions__hint {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-secondary);
}

.tv-desc {
  position: relative;
  padding: 16px 16px 0;
}
.tv-desc__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tv-desc--open .tv-desc__text {
  display: block;
}
.tv-desc__toggle {
  margin-top: 4px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  padding: 2px 0;
}

.tv-eps {
  margin-top: 18px;
  padding: 0 16px;
}
.tv-eps__groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 12px;
  scrollbar-width: none;
}
.tv-eps__groups::-webkit-scrollbar {
  display: none;
}
.tv-eps__group {
  flex: 0 0 auto;
  border: 1px solid var(--divider);
  border-radius: 15px;
  padding: 5px 12px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-eps__group--active {
  border-color: var(--accent-on-soft);
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.tv-eps__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.tv-eps__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tv-eps__count {
  flex: 1;
  font-size: 11px;
  color: var(--text-secondary);
}
.tv-eps__order {
  border: 1px solid var(--divider);
  border-radius: 12px;
  padding: 3px 10px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
}

.tv-eps__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tv-eps__item {
  height: 38px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
}
.tv-eps__item:active {
  opacity: 0.7;
}
.tv-eps__item--last {
  background: var(--accent-soft);
  color: var(--accent-on-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.tv-eps__more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  margin-top: 12px;
  border: 0;
  border-radius: 8px;
  height: 38px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
</style>
