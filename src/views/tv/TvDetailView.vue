<script setup lang="ts">
/**
 * 影片详情：封面、简介、线路与剧集。
 *
 * 线路默认选「集数最多」的一条——采集站常见的情况是线路 2 才是全的，按顺序选
 * 第一条会让用户以为没更新。已经看过的话，对应剧集上标「续看」。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { fetchDetail } from '@/utils/tv/cms'
import type { TvDetail } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const sourceId = String(route.query.source || '')
const vodId = String(route.query.id || '')

const detail = ref<TvDetail>()
const loading = ref(true)
const error = ref('')
const groupIndex = ref(0)
const descOpen = ref(false)

const group = computed(() => detail.value?.groups[groupIndex.value])

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

function play(episodeIndex: number) {
  router.push({
    name: 'tvPlay',
    query: { source: sourceId, id: vodId, g: String(groupIndex.value), e: String(episodeIndex) },
  })
}

const last = computed(() => store.historyOf(sourceId, vodId))
</script>

<template>
  <div class="tv-detail">
    <header class="tv-detail__bar">
      <button class="tv-detail__back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <span class="tv-detail__bar-title">{{ detail?.name || '详情' }}</span>
    </header>

    <main class="tv-detail__body">
      <div v-if="loading" class="tv-detail__state">正在加载…</div>
      <div v-else-if="error" class="tv-detail__state tv-detail__state--error">{{ error }}</div>

      <template v-else-if="detail">
        <section class="tv-hero">
          <div class="tv-hero__cover">
            <img v-if="detail.pic" :src="detail.pic" alt="" referrerpolicy="no-referrer" />
            <span v-else class="tv-hero__ph">{{ detail.name.slice(0, 2) }}</span>
          </div>
          <div class="tv-hero__info">
            <h1 class="tv-hero__name">{{ detail.name }}</h1>
            <p class="tv-hero__meta">
              {{ [detail.year, detail.area, detail.typeName].filter(Boolean).join(' · ') }}
            </p>
            <p v-if="detail.remarks" class="tv-hero__remark">{{ detail.remarks }}</p>
            <p class="tv-hero__source">来源：{{ detail.source.name }}</p>
            <button
              v-if="last"
              class="tv-hero__resume"
              @click="play(last.episodeIndex)"
            >
              续看 {{ last.episodeName }}
            </button>
          </div>
        </section>

        <section v-if="detail.desc" class="tv-desc" :class="{ 'tv-desc--open': descOpen }">
          <p class="tv-desc__text">{{ detail.desc }}</p>
          <button class="tv-desc__toggle" @click="descOpen = !descOpen">
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
              @click="groupIndex = i"
            >
              {{ g.name }}（{{ g.episodes.length }}）
            </button>
          </div>

          <div class="tv-eps__grid">
            <button
              v-for="(ep, i) in group?.episodes || []"
              :key="ep.url"
              class="tv-eps__item"
              :class="{ 'tv-eps__item--last': last && last.groupIndex === groupIndex && last.episodeIndex === i }"
              @click="play(i)"
            >
              {{ ep.name }}
            </button>
          </div>
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
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(8px + var(--safe-top)) 10px 8px;
}
.tv-detail__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  background: transparent;
  color: var(--text);
}
.tv-detail__bar-title {
  font-size: 15px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 16px calc(24px + var(--safe-bottom));
}
.tv-detail__state {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}
.tv-detail__state--error { color: #d9534f; }

.tv-hero { display: flex; gap: 14px; padding: 6px 0 14px; }
.tv-hero__cover {
  flex: 0 0 auto;
  width: 104px;
  height: 146px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tv-hero__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tv-hero__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 22px;
  color: var(--text-secondary);
}
.tv-hero__info { flex: 1; min-width: 0; }
.tv-hero__name {
  margin: 2px 0 8px;
  font-size: 19px;
  line-height: 1.3;
  font-weight: 600;
  color: var(--text);
}
.tv-hero__meta,
.tv-hero__remark,
.tv-hero__source {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.tv-hero__resume {
  margin-top: 6px;
  border: 0;
  border-radius: 16px;
  padding: 6px 14px;
  background: var(--accent-soft-strong);
  color: var(--accent);
  font-size: 12px;
  font-family: inherit;
}

.tv-desc { position: relative; padding-bottom: 4px; }
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
.tv-desc--open .tv-desc__text { display: block; }
.tv-desc__toggle {
  margin-top: 4px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  padding: 2px 0;
}

.tv-eps { margin-top: 18px; }
.tv-eps__groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 10px;
  scrollbar-width: none;
}
.tv-eps__groups::-webkit-scrollbar { display: none; }
.tv-eps__group {
  flex: 0 0 auto;
  border: 1px solid var(--divider);
  border-radius: 14px;
  padding: 5px 12px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-eps__group--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.tv-eps__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.tv-eps__item {
  height: 36px;
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
.tv-eps__item:active { opacity: 0.7; }
.tv-eps__item--last {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
