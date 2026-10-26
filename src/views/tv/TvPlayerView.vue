<script setup lang="ts">
/**
 * 播放页。
 *
 * 布局按长视频 App 的详情态来：顶部是 16:9 播放器，下面依次是当前集信息、
 * 「下一集」和整块选集。返回和全屏都放在顶部导航里，点击目标稳定、不需要先
 * 点出控制栏。
 *
 * 交互对齐爱奇艺/腾讯视频的播放习惯，全部铺在画面的透明手势层上：
 *   单击        呼出/收起控制栏
 *   双击中间    播放/暂停；双击左右 1/3  快退/快进 10 秒
 *   左右滑动    拖进度，居中显示目标时间
 *   上下滑动    左半屏调亮度，右半屏调音量
 *   长按        2 倍速播放，松手还原
 * 手势层盖在画面上、垫在 artplayer 控制栏下面，所以进度条和按钮照常可点。
 *
 * 全屏态给一套独立控制层：标题栏（退出/剧名/倍速/选集/锁屏），锁住后只剩
 * 解锁按钮；选集走右侧抽屉，线路也能在里面切。横屏自动进全屏，退出还原。
 *
 * artplayer + hls.js：CMS 源给出的播放地址九成是 m3u8，少数是 mp4。播放失败
 * 时给「重试 / 换线路」，而不是丢一句提示让人猜。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Artplayer from 'artplayer'
import Hls from 'hls.js'
import Icon from '@/components/Icon.vue'
import MorphIcon from '@/components/MorphIcon.vue'
import { useTvStore } from '@/stores/tv'
import { fetchDetail } from '@/utils/tv/cms'
import { isNativeShell } from '@/utils/native'
import type { TvDetail } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const sourceId = String(route.query.source || '')
const vodId = String(route.query.id || '')

const NEXT_SECONDS = 5
const SEEK_STEP = 10
const TAP_GAP = 280
const LONG_PRESS_MS = 550
const SPEED_KEY = 'weread.tv.speed'
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const detail = ref<TvDetail>()
const loading = ref(true)
const error = ref('')
const fatal = ref('')
const tip = ref('')
const countdown = ref(0)
const reversed = ref(false)
const pseudoFull = ref(false)
const isFull = ref(false)
const controlsVisible = ref(true)
const locked = ref(false)
const drawerOpen = ref(false)
const sheetOpen = ref(false)
const speed = ref(readSpeed())

const groupIndex = ref(Number(route.query.g || 0))
const epIndex = ref(Number(route.query.e || 0))

const screen = ref<HTMLElement>()
const playerEl = ref<HTMLDivElement>()

let player: Artplayer | null = null
let hls: Hls | null = null
let lastSave = 0
let countTimer = 0
let startTimer = 0
let tipTimer = 0
let started = false
let netRetries = 0
let mediaRetries = 0

const group = computed(() => detail.value?.groups[groupIndex.value])
const episode = computed(() => group.value?.episodes[epIndex.value])
const hasNext = computed(() => !!group.value && epIndex.value + 1 < group.value.episodes.length)
const nextEpisode = computed(() => group.value?.episodes[epIndex.value + 1])
const otherGroups = computed(() => (detail.value?.groups.length || 0) > 1)

/** 倒序只改展示顺序，点击时仍用原始下标。 */
const orderedEps = computed(() => {
  const list = (group.value?.episodes || []).map((ep, index) => ({ ep, index }))
  return reversed.value ? list.reverse() : list
})

function readSpeed(): number {
  const n = Number(localStorage.getItem(SPEED_KEY))
  return SPEEDS.includes(n) ? n : 1
}

function showTip(text: string, ms = 1500): void {
  tip.value = text
  clearTimeout(tipTimer)
  if (ms > 0) tipTimer = window.setTimeout(() => (tip.value = ''), ms)
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  watchOrientation()
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

function goBack(): void {
  const state = window.history.state as { back?: string | null } | null
  if (state?.back) {
    router.back()
    return
  }
  // 直接打开播放页（分享链接/冷启动）时没有上一页，回到详情。
  router.replace({ name: 'tvDetail', query: { source: sourceId, id: vodId } })
}

function isM3u8(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url)
}

/** 真全屏不可用（Android WebView）时退化成铺满视口的样式。 */
async function enterFull(): Promise<void> {
  const el = screen.value
  if (!el) return
  // Android 壳没实现 onShowCustomView，requestFullscreen 只会静默失败，
  // 原生环境直接用铺满视口的样式；浏览器里才走平台全屏。
  if (isNativeShell() || typeof el.requestFullscreen !== 'function') {
    pseudoFull.value = true
    isFull.value = true
    return
  }
  try {
    await el.requestFullscreen()
  } catch {
    // 平台拒绝时退到样式全屏。
  }
  if (!document.fullscreenElement) {
    pseudoFull.value = true
    isFull.value = true
  }
}

async function exitFull(): Promise<void> {
  autoFull = false
  pseudoFull.value = false
  isFull.value = false
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  unlockOrientation()
}

async function toggleFullscreen(): Promise<void> {
  if (isFull.value || document.fullscreenElement) await exitFull()
  else await enterFull()
}

function onFullscreenChange(): void {
  if (document.fullscreenElement) {
    isFull.value = true
    return
  }
  isFull.value = pseudoFull.value
}

/* ---------- 横屏自动全屏 ---------- */

const landscapeMq = window.matchMedia('(max-width: 1024px) and (orientation: landscape)')
let autoFull = false

function watchOrientation(): void {
  landscapeMq.addEventListener('change', onOrientation)
  onOrientation()
}

function onOrientation(): void {
  if (loading.value || error.value) return
  if (landscapeMq.matches && !isFull.value) {
    autoFull = true
    void enterFull()
    lockOrientation()
  } else if (!landscapeMq.matches && autoFull && isFull.value) {
    void exitFull()
  }
}

interface OrientationApi {
  lock?: (type: string) => Promise<void>
  unlock?: () => void
}

function orientationApi(): OrientationApi | undefined {
  return (window.screen as Screen & { orientation?: OrientationApi }).orientation
}

function lockOrientation(): void {
  orientationApi()?.lock?.('landscape')?.catch(() => {})
}

function unlockOrientation(): void {
  orientationApi()?.unlock?.()
}

/* ---------- 手势 ---------- */

type GestureMode = '' | 'seek' | 'bright' | 'vol'

const seekPreview = ref({ show: false, delta: 0, target: 0, duration: 0 })
const levelPreview = ref({ show: false, mode: 'bright' as 'bright' | 'vol', value: 0 })
const fastForwarding = ref(false)

let gMode: GestureMode = ''
let gStartX = 0
let gStartY = 0
let gStartTime = 0
let gStartVol = 1
let gStartBright = 1
let brightnessLevel = 1
let gTapTimer = 0
let gLongTimer = 0
let gLongFired = false
let gLastTap = 0
let gLastTouch = 0
let gHideTimer = 0

function videoEl(): HTMLVideoElement | null {
  return playerEl.value?.querySelector('video') || null
}

function setBrightness(value: number): void {
  brightnessLevel = Math.min(1, Math.max(0.15, value))
  const el = videoEl()
  if (el) el.style.filter = `brightness(${brightnessLevel.toFixed(2)})`
}

function toggleControls(): void {
  const c = (player as unknown as { controls?: { toggle: () => void } } | null)?.controls
  c?.toggle()
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function onTouchStart(e: TouchEvent): void {
  if (locked.value || !player || e.touches.length !== 1) return
  gLastTouch = Date.now()
  const t = e.touches[0]
  gStartX = t.clientX
  gStartY = t.clientY
  gStartTime = player.currentTime
  gStartVol = player.volume ?? 1
  gMode = ''
  gLongFired = false
  clearTimeout(gLongTimer)
  gLongTimer = window.setTimeout(() => {
    // 长按倍速：只在正常播放时有意义，暂停中长按给个提示就好。
    if (gMode || !player) return
    if (!player.playing) {
      showTip('暂停中，双击播放')
      return
    }
    gLongFired = true
    fastForwarding.value = true
    player.playbackRate = 2
  }, LONG_PRESS_MS)
}

function onTouchMove(e: TouchEvent): void {
  if (locked.value || !player || e.touches.length !== 1) return
  const t = e.touches[0]
  const dx = t.clientX - gStartX
  const dy = t.clientY - gStartY
  const rect = screen.value?.getBoundingClientRect()
  if (!rect) return

  if (!gMode) {
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return
    clearTimeout(gLongTimer)
    gMode = Math.abs(dx) > Math.abs(dy) ? 'seek' : t.clientX - rect.left < rect.width / 2 ? 'bright' : 'vol'
    // 以手势起点为基准，后续位移全部相对它算增量。
    gStartX = t.clientX
    gStartY = t.clientY
    if (gMode === 'bright') gStartBright = brightnessLevel
  }
  e.preventDefault()

  if (gMode === 'seek') {
    const duration = player.duration || 0
    if (!duration) return
    const ratio = (t.clientX - gStartX) / rect.width
    const target = Math.min(duration, Math.max(0, gStartTime + ratio * duration * 0.5))
    seekPreview.value = {
      show: true,
      delta: Math.round(target - gStartTime),
      target,
      duration,
    }
  } else if (gMode === 'vol') {
    const v = Math.min(1, Math.max(0, gStartVol + (gStartY - t.clientY) / rect.height))
    player.volume = v
    levelPreview.value = { show: true, mode: 'vol', value: Math.round(v * 100) }
  } else if (gMode === 'bright') {
    const v = Math.min(1, Math.max(0.15, gStartBright + (gStartY - t.clientY) / rect.height))
    setBrightness(v)
    levelPreview.value = { show: true, mode: 'bright', value: Math.round(v * 100) }
  }
}

function onTouchEnd(e: TouchEvent): void {
  gLastTouch = Date.now()
  clearTimeout(gLongTimer)
  if (locked.value || !player) return

  if (gLongFired) {
    gLongFired = false
    fastForwarding.value = false
    player.playbackRate = speed.value
    return
  }

  if (gMode === 'seek') {
    player.seek = seekPreview.value.target
    gHideTimer = window.setTimeout(() => (seekPreview.value.show = false), 500)
  } else if (gMode) {
    gHideTimer = window.setTimeout(() => (levelPreview.value.show = false), 500)
  } else {
    handleTap(e.changedTouches[0]?.clientX || 0)
  }
  gMode = ''
}

/** 单击呼出控制栏，双击按区域快进快退或播放/暂停（280ms 内等第二次点击）。 */
function handleTap(clientX: number): void {
  const now = Date.now()
  const rect = screen.value?.getBoundingClientRect()
  if (now - gLastTap < TAP_GAP) {
    clearTimeout(gTapTimer)
    gLastTap = 0
    const x = rect ? clientX - rect.left : 0
    const w = rect?.width || 1
    if (x < w / 3 && player) {
      player.currentTime = Math.max(0, player.currentTime - SEEK_STEP)
      showTip(`快退 ${SEEK_STEP} 秒`)
    } else if (x > (w * 2) / 3 && player) {
      player.currentTime = Math.min(player.duration || 0, player.currentTime + SEEK_STEP)
      showTip(`快进 ${SEEK_STEP} 秒`)
    } else {
      player?.toggle()
    }
    return
  }
  gLastTap = now
  gTapTimer = window.setTimeout(toggleControls, TAP_GAP)
}

/** 桌面/鼠标兜底：触屏上合成 click 会被这层忽略。 */
function onClick(): void {
  if (Date.now() - gLastTouch < 700) return
  toggleControls()
}

function onDblClick(): void {
  if (Date.now() - gLastTouch < 700) return
  player?.toggle()
}

/* ---------- 倍速 ---------- */

function pickSpeed(v: number): void {
  speed.value = v
  localStorage.setItem(SPEED_KEY, String(v))
  if (player) player.playbackRate = v
  sheetOpen.value = false
  showTip(`倍速 ${v}x`)
}

/* ---------- 播放核心 ---------- */

function playM3u8(video: HTMLVideoElement, url: string): void {
  // 换集时 artplayer 会再次调用同一个 customType，旧实例必须先销毁。
  hls?.destroy()
  hls = null
  netRetries = 0
  mediaRetries = 0

  if (Hls.isSupported()) {
    const instance = new Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 15000 })
    hls = instance
    instance.loadSource(url)
    instance.attachMedia(video)
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      // 源站/CDN 抖动是常态，多给自己几次机会；真播不出来再让用户换线路。
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 3) {
        netRetries++
        instance.startLoad()
        return
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
        mediaRetries++
        instance.recoverMediaError()
        return
      }
      fatal.value = '播放失败：源站拒绝或网络不通'
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
  } else {
    fatal.value = '当前设备不支持 HLS 播放'
  }
}

function mount(): void {
  destroyPlayer()
  fatal.value = ''
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
    // 全屏交给页面顶部的按钮：WebView 里 artplayer 自带的那个点了没反应。
    fullscreen: false,
    fullscreenWeb: false,
    setting: false,
    pip: true,
    miniProgressBar: true,
    theme: '#1b88ee',
    customType: { m3u8: playM3u8 },
  })

  player.playbackRate = speed.value

  player.on('ready', () => {
    started = true
    clearTimeout(startTimer)
    // 慢源有时先超时后出画面，错误卡片必须跟着撤掉。
    fatal.value = ''
    if (resumeAt > 3 && player) player.currentTime = resumeAt
  })
  player.on('video:timeupdate', onTimeUpdate)
  player.on('video:ended', onEnded)
  player.on('video:error', () => {
    // hls.js 会自己上报可恢复/不可恢复的错误；这里只兜底直链 mp4。
    if (!isM3u8(ep.url)) fatal.value = '视频加载失败，请重试'
  })
  // 控制栏显隐跟着 artplayer 走，全屏顶部栏与它同生共死。
  player.on('control', (state: boolean) => {
    controlsVisible.value = state
  })

  // 坏源经常既不报错也不出画面：30 秒没 ready 就当失败，别让人一直看转圈。
  started = false
  clearTimeout(startTimer)
  startTimer = window.setTimeout(() => {
    if (!started) fatal.value = '长时间没有画面，请重试'
  }, 30000)
}

function onTimeUpdate(): void {
  // 进度在走就说明画面是好的，之前的超时/错误提示已经过期。
  if (fatal.value) fatal.value = ''
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
  clearTimeout(startTimer)
}

function switchGroup(): void {
  const total = detail.value?.groups.length || 0
  if (!total) return
  for (let step = 1; step <= total; step++) {
    const i = (groupIndex.value + step) % total
    if (detail.value?.groups[i]?.episodes.length) {
      groupIndex.value = i
      epIndex.value = 0
      return
    }
  }
}

function retry(): void {
  mount()
}

function onEnded(): void {
  if (!hasNext.value) {
    showTip('已经是最后一集', 2500)
    return
  }
  startCountdown()
}

function startCountdown(): void {
  cancelCountdown()
  countdown.value = NEXT_SECONDS
  countTimer = window.setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) next()
  }, 1000)
}

function cancelCountdown(): void {
  clearInterval(countTimer)
  countTimer = 0
  countdown.value = 0
}

function next(): void {
  cancelCountdown()
  if (!hasNext.value) {
    showTip('已经是最后一集', 2500)
    return
  }
  epIndex.value++
}

function pickEpisode(i: number): void {
  cancelCountdown()
  drawerOpen.value = false
  if (i === epIndex.value) return
  epIndex.value = i
}

function openDrawer(): void {
  drawerOpen.value = true
  void nextTick(() => {
    const active = document.querySelector('.tv-play__drawer-ep--active')
    active?.scrollIntoView({ block: 'center' })
  })
}

watch([groupIndex, epIndex], async ([g, e]) => {
  cancelCountdown()
  saveProgress()
  router.replace({ name: 'tvPlay', query: { source: sourceId, id: vodId, g: String(g), e: String(e) } })
  await nextTick()
  mount()
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  landscapeMq.removeEventListener('change', onOrientation)
  saveProgress()
  cancelCountdown()
  clearTimeout(gTapTimer)
  clearTimeout(gLongTimer)
  clearTimeout(gHideTimer)
  clearTimeout(tipTimer)
  unlockOrientation()
  destroyPlayer()
})
</script>

<template>
  <div class="tv-play">
    <header class="tv-play__nav">
      <button class="tv-play__nav-back" aria-label="返回" @click="goBack">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <span class="tv-play__nav-title">{{ detail?.name || '播放' }}</span>
      <button class="tv-play__nav-btn" :aria-label="isFull ? '退出全屏' : '全屏'" @click="toggleFullscreen">
        <MorphIcon :name="isFull ? 'compress' : 'expand'" :size="20" />
      </button>
    </header>

    <div
      ref="screen"
      class="tv-play__screen"
      :class="{ 'tv-play__screen--full': pseudoFull, 'tv-play__screen--fatal': !!fatal }"
    >
      <div ref="playerEl" class="tv-play__stage" />

      <!-- 手势层：盖住画面、垫在控制栏和浮层按钮下面。 -->
      <div
        v-show="!loading && !error && !fatal && !locked"
        class="tv-play__gestures"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
        @click="onClick"
        @dblclick="onDblClick"
      />

      <!-- 全屏顶部控制层，跟 artplayer 控制栏一起显隐。 -->
      <div v-if="isFull && !locked" class="tv-play__fsbar" :class="{ 'tv-play__fsbar--show': controlsVisible }">
        <button class="tv-play__fs-btn" aria-label="退出全屏" @click="exitFull">
          <Icon name="compress" :size="19" />
        </button>
        <div class="tv-play__fs-title">
          <span class="tv-play__fs-name">{{ detail?.name }}</span>
          <span class="tv-play__fs-ep">{{ episode?.name }}</span>
        </div>
        <button class="tv-play__fs-btn" @click="sheetOpen = true">{{ speed }}x</button>
        <button class="tv-play__fs-btn" aria-label="选集" @click="openDrawer">
          <Icon name="catalog" :size="19" />
        </button>
        <button class="tv-play__fs-btn" aria-label="锁定" @click="locked = true">
          <Icon name="lock" :size="19" />
        </button>
      </div>

      <!-- 锁定后整层隐藏，只留解锁。 -->
      <button v-if="isFull && locked" class="tv-play__unlock" aria-label="解锁" @click="locked = false">
        <Icon name="lock" :size="18" />
      </button>

      <div v-if="loading" class="tv-play__state">正在加载…</div>
      <div v-else-if="error" class="tv-play__state tv-play__state--error">{{ error }}</div>

      <div v-if="fatal" class="tv-play__fatal">
        <p class="tv-play__fatal-text">{{ fatal }}</p>
        <div class="tv-play__fatal-actions">
          <button class="tv-play__fatal-btn" @click="retry">重试</button>
          <button v-if="otherGroups" class="tv-play__fatal-btn tv-play__fatal-btn--primary" @click="switchGroup">
            换线路
          </button>
        </div>
      </div>

      <!-- 自动连播卡片：倒计时条就是剩余时间。 -->
      <div v-if="countdown" class="tv-play__next">
        <div class="tv-play__next-main">
          <span class="tv-play__next-label">即将播放</span>
          <span class="tv-play__next-name">{{ nextEpisode?.name || '下一集' }}</span>
        </div>
        <div class="tv-play__next-actions">
          <button class="tv-play__next-btn" @click="cancelCountdown">取消</button>
          <button class="tv-play__next-btn tv-play__next-btn--primary" @click="next">
            立即播放（{{ countdown }}s）
          </button>
        </div>
        <div class="tv-play__next-track">
          <span class="tv-play__next-bar" :style="{ width: (countdown / NEXT_SECONDS) * 100 + '%' }" />
        </div>
      </div>

      <div v-if="tip" class="tv-play__tip" @click="tip = ''">{{ tip }}</div>

      <!-- 手势反馈：拖进度、调亮度/音量、长按倍速。 -->
      <div v-if="seekPreview.show" class="tv-play__seek">
        <span class="tv-play__seek-delta">
          {{ seekPreview.delta >= 0 ? '+' : '' }}{{ seekPreview.delta }}s
        </span>
        <span class="tv-play__seek-time">
          {{ fmtTime(seekPreview.target) }} / {{ fmtTime(seekPreview.duration) }}
        </span>
      </div>
      <div v-if="levelPreview.show" class="tv-play__level" :class="`tv-play__level--${levelPreview.mode}`">
        <Icon :name="levelPreview.mode === 'bright' ? 'brightness' : 'headphones'" :size="16" />
        <span>{{ levelPreview.value }}%</span>
      </div>
      <div v-if="fastForwarding" class="tv-play__fast">2 倍速播放中</div>
    </div>

    <main class="tv-play__body">
      <div v-if="loading" class="tv-play__placeholder">正在加载…</div>
      <div v-else-if="error" class="tv-play__placeholder tv-play__placeholder--error">{{ error }}</div>

      <template v-else-if="detail">
        <div class="tv-play__meta">
          <div class="tv-play__meta-main">
            <span class="tv-play__ep">{{ episode?.name }}</span>
            <span class="tv-play__src">{{ detail.source.name }}</span>
          </div>
          <button class="tv-play__meta-btn" @click="sheetOpen = true">倍速 {{ speed }}x</button>
          <button class="tv-play__meta-btn" :disabled="!hasNext" @click="next">
            下一集
            <Icon name="chevron-right" :size="13" />
          </button>
        </div>

        <section class="tv-play__eps">
          <div v-if="detail.groups.length > 1" class="tv-play__groups">
            <button
              v-for="(g, i) in detail.groups"
              :key="g.name + i"
              class="tv-play__group"
              :class="{ 'tv-play__group--active': i === groupIndex }"
              @click="groupIndex = i; reversed = false"
            >
              {{ g.name }}（{{ g.episodes.length }}）
            </button>
          </div>

          <div class="tv-play__eps-head">
            <span class="tv-play__eps-title">选集</span>
            <span class="tv-play__eps-count">共 {{ orderedEps.length }} 集</span>
            <button class="tv-play__eps-order" @click="reversed = !reversed">
              {{ reversed ? '倒序' : '正序' }}
            </button>
          </div>

          <div class="tv-play__eps-grid">
            <button
              v-for="row in orderedEps"
              :key="row.ep.url"
              class="tv-play__ep"
              :class="{ 'tv-play__ep--active': row.index === epIndex }"
              @click="pickEpisode(row.index)"
            >
              {{ row.ep.name }}
            </button>
          </div>
        </section>
      </template>
    </main>

    <!-- 倍速面板 -->
    <div v-if="sheetOpen" class="tv-play__mask" @click="sheetOpen = false">
      <div class="tv-play__sheet" @click.stop>
        <div class="tv-play__sheet-title">倍速播放</div>
        <button
          v-for="v in SPEEDS"
          :key="v"
          class="tv-play__sheet-item"
          :class="{ 'tv-play__sheet-item--active': v === speed }"
          @click="pickSpeed(v)"
        >
          {{ v }}x
          <Icon v-if="v === speed" name="check" :size="15" />
        </button>
      </div>
    </div>

    <!-- 全屏选集抽屉：线路切换 + 剧集列表 -->
    <div v-if="drawerOpen" class="tv-play__mask" @click="drawerOpen = false">
      <aside class="tv-play__drawer" @click.stop>
        <div class="tv-play__drawer-head">
          <span class="tv-play__drawer-title">选集</span>
          <button class="tv-play__drawer-close" aria-label="关闭" @click="drawerOpen = false">
            <Icon name="close" :size="18" />
          </button>
        </div>
        <div v-if="detail && detail.groups.length > 1" class="tv-play__drawer-groups">
          <button
            v-for="(g, i) in detail.groups"
            :key="g.name + i"
            class="tv-play__group"
            :class="{ 'tv-play__group--active': i === groupIndex }"
            @click="groupIndex = i; reversed = false"
          >
            {{ g.name }}（{{ g.episodes.length }}）
          </button>
        </div>
        <div class="tv-play__drawer-list">
          <button
            v-for="row in orderedEps"
            :key="row.ep.url"
            class="tv-play__drawer-ep"
            :class="{ 'tv-play__drawer-ep--active': row.index === epIndex }"
            @click="pickEpisode(row.index)"
          >
            {{ row.ep.name }}
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.tv-play {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.tv-play__nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(6px + var(--safe-top)) 10px 6px;
  background: var(--bg);
}
.tv-play__nav-back,
.tv-play__nav-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  background: transparent;
  color: var(--text);
}
.tv-play__nav-back:active,
.tv-play__nav-btn:active { opacity: 0.55; }
.tv-play__nav-title {
  flex: 1;
  min-width: 0;
  padding: 0 4px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-play__screen {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  overflow: hidden;
}
.tv-play__screen:fullscreen {
  width: 100vw;
  height: 100vh;
  aspect-ratio: auto;
}
.tv-play__screen--full {
  position: fixed;
  inset: 0;
  z-index: 30;
  width: 100%;
  height: 100dvh;
  aspect-ratio: auto;
}
.tv-play__stage {
  position: absolute;
  inset: 0;
}

/* 手势层：画面之上、art 控件与浮层按钮（z-index 7+）之下。 */
.tv-play__gestures {
  position: absolute;
  inset: 0;
  z-index: 6;
  touch-action: none;
}

/* 播放失败时 artplayer 的加载圈还转着，会和错误卡片叠在一起。 */
.tv-play__screen--fatal :deep(.art-loading) { display: none; }

/* ---------- 全屏控制层 ---------- */

.tv-play__fsbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(6px + var(--safe-top)) 10px 14px;
  background: linear-gradient(rgba(0, 0, 0, 0.6), transparent);
  opacity: 0;
  transform: translateY(-8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.tv-play__fsbar--show {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.tv-play__fs-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 34px;
  padding: 0 7px;
  border: 0;
  border-radius: 17px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 12px;
  font-family: inherit;
}
.tv-play__fs-btn:active { opacity: 0.6; }
.tv-play__fs-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 8px;
}
.tv-play__fs-name {
  font-size: 14px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__fs-ep {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.tv-play__unlock {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 17px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}

/* ---------- 状态与卡片 ---------- */

.tv-play__state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.65);
  z-index: 1;
}
.tv-play__state--error { color: rgba(255, 160, 160, 0.9); }

.tv-play__fatal {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 5;
  width: min(78%, 300px);
  padding: 16px 14px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(38, 38, 41, 0.96);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  text-align: center;
}
.tv-play__fatal-text {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.85);
}
.tv-play__fatal-actions { display: flex; gap: 10px; }
.tv-play__fatal-btn {
  flex: 1;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 16px;
  background: transparent;
  color: #fff;
  font-size: 12px;
  font-family: inherit;
}
.tv-play__fatal-btn--primary {
  border-color: var(--accent);
  background: var(--accent);
}

.tv-play__next {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 7;
  width: min(72%, 280px);
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(18, 18, 18, 0.92);
}
.tv-play__next-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}
.tv-play__next-label { font-size: 10px; color: rgba(255, 255, 255, 0.55); }
.tv-play__next-name {
  font-size: 12.5px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__next-actions { display: flex; gap: 8px; }
.tv-play__next-btn {
  flex: 1;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 14px;
  background: transparent;
  color: #fff;
  font-size: 11px;
  font-family: inherit;
}
.tv-play__next-btn--primary {
  border-color: var(--accent);
  background: var(--accent);
}
.tv-play__next-track {
  margin-top: 8px;
  height: 2px;
  border-radius: 1px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}
.tv-play__next-bar {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 1s linear;
}

.tv-play__tip {
  position: absolute;
  left: 50%;
  top: 45%;
  transform: translate(-50%, -50%);
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  z-index: 7;
}

/* ---------- 手势反馈 ---------- */

.tv-play__seek {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.72);
}
.tv-play__seek-delta { font-size: 20px; font-weight: 600; color: #fff; }
.tv-play__seek-time { font-size: 11px; color: rgba(255, 255, 255, 0.75); }

.tv-play__level {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12px;
}
.tv-play__level--bright { left: 14px; }
.tv-play__level--vol { right: 14px; }

.tv-play__fast {
  position: absolute;
  left: 50%;
  top: 18%;
  transform: translateX(-50%);
  z-index: 4;
  padding: 6px 12px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12px;
}

/* ---------- 正文 ---------- */

.tv-play__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 16px calc(24px + var(--safe-bottom));
}
.tv-play__placeholder {
  padding: 24px 0;
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
}
.tv-play__placeholder--error { color: #d9534f; }

.tv-play__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--divider);
}
.tv-play__meta-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tv-play__ep { font-size: 14px; color: var(--text); }
.tv-play__src {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__meta-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--divider);
  border-radius: 14px;
  padding: 5px 10px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-play__meta-btn:disabled { opacity: 0.4; }

.tv-play__eps { padding-top: 14px; }
.tv-play__groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 12px;
  scrollbar-width: none;
}
.tv-play__groups::-webkit-scrollbar { display: none; }
.tv-play__group {
  flex: 0 0 auto;
  border: 1px solid var(--divider);
  border-radius: 15px;
  padding: 5px 12px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
.tv-play__group--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.tv-play__eps-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.tv-play__eps-title { font-size: 15px; font-weight: 600; color: var(--text); }
.tv-play__eps-count { flex: 1; font-size: 11px; color: var(--text-secondary); }
.tv-play__eps-order {
  border: 1px solid var(--divider);
  border-radius: 12px;
  padding: 3px 10px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
}

.tv-play__eps-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.tv-play__ep {
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
.tv-play__ep:active { opacity: 0.7; }
.tv-play__ep--active {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

/* ---------- 倍速面板 / 选集抽屉 ---------- */

.tv-play__mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.tv-play__sheet {
  padding: 14px 16px calc(18px + var(--safe-bottom));
  border-radius: 14px 14px 0 0;
  background: var(--bg);
}
.tv-play__sheet-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  text-align: center;
}
.tv-play__sheet-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 42px;
  border: 0;
  border-radius: 8px;
  padding: 0 12px;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
}
.tv-play__sheet-item--active { color: var(--accent); font-weight: 600; }

.tv-play__drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(78%, 320px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.tv-play__drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(12px + var(--safe-top)) 14px 10px;
  border-bottom: 1px solid var(--divider);
}
.tv-play__drawer-title { font-size: 15px; font-weight: 600; color: var(--text); }
.tv-play__drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
}
.tv-play__drawer-groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 10px 14px 2px;
  scrollbar-width: none;
}
.tv-play__drawer-groups::-webkit-scrollbar { display: none; }
.tv-play__drawer-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 12px 14px calc(16px + var(--safe-bottom));
}
.tv-play__drawer-ep {
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
.tv-play__drawer-ep--active {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
