<script setup lang="ts">
/**
 * 影视首页（tab）。
 *
 * 微读的主线是「本地书库」，所以这个页面不堆推荐位：上方是搜索入口，下面
 * 只放「继续观看」和源状态。没有源时给一条明确的添加路径，而不是空白页。
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import type { TvHistoryEntry } from '@/utils/tv/types'

const router = useRouter()
const store = useTvStore()

onMounted(() => { void store.load() })

const recent = computed(() => store.history.slice(0, 12))
const hasSources = computed(() => store.sources.length > 0)

function goSearch() {
  router.push({ name: 'tvSearch' })
}

function goSources() {
  router.push({ name: 'tvSources' })
}

function resume(h: TvHistoryEntry) {
  router.push({
    name: 'tvPlay',
    query: { source: h.sourceId, id: h.vodId, g: String(h.groupIndex), e: String(h.episodeIndex) },
  })
}

function percentOf(h: TvHistoryEntry): number {
  if (!h.duration) return 0
  return Math.min(100, Math.max(0, Math.round((h.position / h.duration) * 100)))
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

    <div class="tv__bar">
      <span class="tv__title">影视</span>
    </div>

    <main class="tv__body">
      <div v-if="!hasSources" class="tv__empty">
        <div class="tv__empty-icon">
          <Icon name="tab-tv" :size="46" :width="1.2" />
        </div>
        <p class="tv__empty-title">还没有视频源</p>
        <p class="tv__empty-desc">添加苹果 CMS 接口地址后即可搜索播放</p>
        <button class="tv__empty-btn" @click="goSources">添加视频源</button>
      </div>

      <template v-else>
        <section v-if="recent.length" class="tv__section">
          <div class="tv__section-head">
            <h2 class="tv__section-title">继续观看</h2>
            <button class="tv__section-more" @click="router.push({ name: 'tvSearch' })">去找片</button>
          </div>
          <div class="tv__history">
            <button
              v-for="h in recent"
              :key="h.key"
              class="tv-history"
              @click="resume(h)"
            >
              <div class="tv-history__cover">
                <img v-if="h.pic" :src="h.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
                <span v-else class="tv-history__ph">{{ h.name.slice(0, 2) }}</span>
                <span class="tv-history__progress" :style="{ width: percentOf(h) + '%' }" />
              </div>
              <span class="tv-history__name">{{ h.name }}</span>
              <span class="tv-history__sub">{{ h.episodeName }}</span>
            </button>
          </div>
        </section>

        <section class="tv__section">
          <div class="tv__section-head">
            <h2 class="tv__section-title">源状态</h2>
          </div>
          <div class="tv__stats">
            <span class="tv__stats-num">{{ store.enabledSources.length }}</span>
            <span class="tv__stats-label">/ {{ store.sources.length }} 个源已启用</span>
          </div>
          <p class="tv__hint">
            搜索会同时请求所有已启用的源，结果按源分组。源站接口失效时，到「源管理」里测活或换源。
          </p>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.tv { background: var(--bg-page); }

.tv__top { padding: calc(8px + var(--safe-top)) 12px 4px; }
.tv__search {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
}
.tv__search:active { opacity: 0.75; }
.tv__search-text { font-size: 14px; }

.tv__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 6px;
}
.tv__title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.2px;
}
.tv__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 16px calc(20px + var(--safe-bottom));
}

.tv__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14vh 24px 0;
  text-align: center;
}
.tv__empty-icon { color: var(--text-secondary); opacity: 0.55; }
.tv__empty-title { margin: 16px 0 6px; font-size: 16px; font-weight: 600; color: var(--text); }
.tv__empty-desc { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.6; }
.tv__empty-btn {
  margin-top: 20px;
  border: 0;
  border-radius: 20px;
  padding: 9px 22px;
  background: var(--accent);
  color: var(--text-inverse);
  font-size: 14px;
  font-family: inherit;
}
.tv__empty-btn:active { background: var(--accent-press); }

.tv__section { margin-top: 18px; }
.tv__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}
.tv__section-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.tv__section-more {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}

.tv__history {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 4px;
  scrollbar-width: none;
}
.tv__history::-webkit-scrollbar { display: none; }

.tv-history {
  flex: 0 0 auto;
  width: 96px;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
.tv-history:active { opacity: 0.7; }
.tv-history__cover {
  position: relative;
  width: 96px;
  height: 134px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tv-history__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tv-history__ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 20px;
  color: var(--text-secondary);
}
.tv-history__progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
}
.tv-history__name {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-history__sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv__stats { display: flex; align-items: baseline; gap: 6px; }
.tv__stats-num { font-size: 26px; font-weight: 600; color: var(--accent); }
.tv__stats-label { font-size: 13px; color: var(--text-secondary); }
.tv__hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}
</style>
