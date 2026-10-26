<script setup lang="ts">
/**
 * 播放页。
 *
 * artplayer + hls.js：CMS 源给出的播放地址九成是 m3u8，少数是 mp4，交给
 * artplayer 按扩展名判断。进度存在本地库（settings 行里），下次从同一集同一
 * 秒数继续。
 *
 * 失败提示按真实原因给：m3u8 拉不下来常见于源站限制 Referer 或 CDN 不给 CORS，
 * 这时换线路/换源才是解法，重试没有意义。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Artplayer from 'artplayer'
import Hls from 'hls.js'
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
const tip = ref('')
const sheet = ref(false)

const groupIndex = ref(Number(route.query.g || 0))
const epIndex = ref(Number(route.query.e || 0))

const playerEl = ref<HTMLDivElement>()

let player: Artplayer | null = null
let hls: Hls | null = null
let lastSave = 0

const group = computed(() => detail.value?.groups[groupIndex.value])
const episode = computed(() => group.value?.episodes[epIndex.value])
const hasNext = computed(() => !!group.value && epIndex.value + 1 < group.value.episodes.length)

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
    if (!detail.value.groups[groupIndex.value]) groupIndex.value = 0
    const eps = group.value?.episodes || []
    if (!eps[epIndex.value]) epIndex.value = 0
    if (!eps.length) {
      error.value = '这个源没有可播放地址'
      loading.value = false
      return
    }
  } catch (e) {
    error.value = (e as Error)?.message || '加载失败'
    loading.value = false
    return
  }

  loading.value = false
  await nextTick()
  mount()
})

function isM3u8(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url)
}

function playM3u8(video: HTMLVideoElement, url: string): void {
  // 换集时 artplayer 会再次调用同一个 customType，旧实例必须先销毁。
  hls?.destroy()
  hls = null

  if (Hls.isSupported()) {
    const instance = new Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 15000 })
    hls = instance
    instance.loadSource(url)
    instance.attachMedia(video)
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        instance.startLoad()
        return
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        instance.recoverMediaError()
        return
      }
      tip.value = '播放失败：源站拒绝或跨域限制，换线路或换源试试'
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
  } else {
    tip.value = '当前设备不支持 HLS 播放'
  }
}

function mount(): void {
  destroyPlayer()
  const ep = episode.value
  if (!ep || !playerEl.value) return

  const history = store.historyOf(sourceId, vodId)
  const resumeAt = history && history.groupIndex === groupIndex.value && history.episodeIndex === epIndex.value
    ? history.position
    : 0

  player = new Artplayer({
    container: playerEl.value,
    url: ep.url,
    type: isM3u8(ep.url) ? 'm3u8' : '',
    autoplay: true,
    playsInline: true,
    fullscreen: true,
    fullscreenWeb: false,
    setting: false,
    pip: true,
    miniProgressBar: true,
    theme: '#1b88ee',
    customType: { m3u8: playM3u8 },
  })

  player.on('ready', () => {
    if (resumeAt > 3 && player) player.currentTime = resumeAt
  })
  player.on('video:timeupdate', onTimeUpdate)
  player.on('video:ended', next)
}

function onTimeUpdate(): void {
  const now = Date.now()
  if (now - lastSave < 10000) return
  lastSave = now
  saveProgress()
}

function saveProgress(): void {
  const ep = episode.value
  if (!ep || !detail.value || !player) return
  store.recordHistory({
    key: `${sourceId}:${vodId}`,
    sourceId,
    sourceName: detail.value.source.name,
    vodId,
    name: detail.value.name,
    pic: detail.value.pic,
    groupIndex: groupIndex.value,
    episodeIndex: epIndex.value,
    episodeName: ep.name,
    position: player.currentTime || 0,
    duration: player.duration || 0,
    updatedAt: Date.now(),
  })
}

function destroyPlayer(): void {
  hls?.destroy()
  hls = null
  player?.destroy(false)
  player = null
}

watch([groupIndex, epIndex], async ([g, e]) => {
  saveProgress()
  router.replace({ name: 'tvPlay', query: { source: sourceId, id: vodId, g: String(g), e: String(e) } })
  await nextTick()
  mount()
})

function next(): void {
  if (!hasNext.value) {
    tip.value = '已经是最后一集'
    return
  }
  epIndex.value++
}

function pickEpisode(i: number): void {
  epIndex.value = i
  sheet.value = false
}

onBeforeUnmount(() => {
  saveProgress()
  destroyPlayer()
})
</script>

<template>
  <div class="tv-player">
    <div ref="playerEl" class="tv-player__stage" />

    <header class="tv-player__bar">
      <button class="tv-player__back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <div class="tv-player__titles">
        <span class="tv-player__name">{{ detail?.name || '播放' }}</span>
        <span v-if="episode" class="tv-player__ep">{{ episode.name }}</span>
      </div>
      <div v-if="!loading && !error" class="tv-player__head-actions">
        <button class="tv-player__head-btn" @click="sheet = true">选集</button>
        <button class="tv-player__head-btn" :disabled="!hasNext" @click="next">下一集</button>
      </div>
    </header>

    <div v-if="loading" class="tv-player__state">正在加载…</div>
    <div v-else-if="error" class="tv-player__state">{{ error }}</div>

    <div v-if="tip" class="tv-player__tip" @click="tip = ''">{{ tip }}</div>

    <div v-if="sheet" class="tv-sheet" @click.self="sheet = false">
      <div class="tv-sheet__panel">
        <div class="tv-sheet__head">
          <span class="tv-sheet__title">选集</span>
          <button class="tv-sheet__close" aria-label="关闭" @click="sheet = false">
            <Icon name="close" :size="20" />
          </button>
        </div>

        <div v-if="detail && detail.groups.length > 1" class="tv-sheet__groups">
          <button
            v-for="(g, i) in detail.groups"
            :key="g.name + i"
            class="tv-sheet__group"
            :class="{ 'tv-sheet__group--active': i === groupIndex }"
            @click="groupIndex = i; sheet = false"
          >
            {{ g.name }}（{{ g.episodes.length }}）
          </button>
        </div>

        <div class="tv-sheet__grid">
          <button
            v-for="(ep, i) in group?.episodes || []"
            :key="ep.url"
            class="tv-sheet__ep"
            :class="{ 'tv-sheet__ep--active': i === epIndex }"
            @click="pickEpisode(i)"
          >
            {{ ep.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tv-player {
  position: absolute;
  inset: 0;
  background: #0b0b0b;
  overflow: hidden;
}

.tv-player__stage {
  position: absolute;
  inset: 0;
  background: #000;
}

.tv-player__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: calc(6px + var(--safe-top)) 10px 18px;
  background: linear-gradient(rgba(0, 0, 0, 0.62), transparent);
  pointer-events: none;
  z-index: 2;
}
.tv-player__back {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  background: transparent;
  color: #fff;
}
.tv-player__titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tv-player__name {
  font-size: 14px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-player__ep { font-size: 11px; color: rgba(255, 255, 255, 0.65); }

.tv-player__state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  z-index: 1;
}

.tv-player__head-actions {
  pointer-events: auto;
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.tv-player__head-btn {
  border: 0;
  border-radius: 14px;
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 12px;
  font-family: inherit;
  backdrop-filter: blur(6px);
}
.tv-player__head-btn:disabled { opacity: 0.4; }

.tv-player__tip {
  position: absolute;
  left: 50%;
  top: 45%;
  transform: translate(-50%, -50%);
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  z-index: 3;
}

.tv-sheet {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
}
.tv-sheet__panel {
  width: 100%;
  max-height: 66%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-radius: 14px 14px 0 0;
  padding: 14px 16px calc(18px + var(--safe-bottom));
}
.tv-sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.tv-sheet__title { font-size: 15px; font-weight: 600; color: var(--text); }
.tv-sheet__close {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  display: flex;
}
.tv-sheet__groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 10px;
  scrollbar-width: none;
}
.tv-sheet__groups::-webkit-scrollbar { display: none; }
.tv-sheet__group {
  flex: 0 0 auto;
  border: 1px solid var(--divider);
  border-radius: 14px;
  padding: 5px 12px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-sheet__group--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.tv-sheet__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.tv-sheet__ep {
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
.tv-sheet__ep--active {
  background: var(--accent);
  color: var(--text-inverse);
}
</style>
