<script setup lang="ts">
/**
 * 播放页。
 *
 * 播放器是 artplayer（成熟开源库）+ hls.js，控件全部用它的自带组件：
 * 单击显示控制栏、双击播放/暂停、左右拖动调进度（`gesture`）、长按 3 倍速
 * （`fastForward`）、锁屏（`lock`）、倍速与画面比例（`setting`）。
 *
 * 这里不再自己写触摸手势。手写那套（双击判定 + 左右滑进度 + 上下滑亮度/音量）
 * 和播放器自带的 click/touchmove 抢同一批事件：一次双击会被两边各算一次，
 * 亮度用 CSS filter 调还会连着视频以外的东西一起变暗。自带能力已经覆盖同样
 * 的操作，就别再平行实现一份。
 *
 * 页面只负责四件事：
 *   1. 16:9 舞台 + 全屏（见下面 enterFull）
 *   2. 剧集信息 / 选集 / 自动连播
 *   3. 进度落库
 *   4. 播放失败时的「重试 / 换线路」
 *
 * 全屏走的是平台 HTML5 全屏（`element.requestFullscreen()`），真正的实施在
 * 原生侧：`MainActivity.FullscreenChromeClient` 把全屏元素盖满窗口、藏掉系统
 * 栏、转成横屏。Capacitor 自带的 `BridgeWebChromeClient.onShowCustomView()`
 * 第一句就是 `callback.onCustomViewHidden()` —— 它把全屏取消了，所以之前
 * `requestFullscreen()` 一定静默失败，只能退回「CSS 铺满」，那既不是真全屏
 * 也挡不住状态栏。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Artplayer from 'artplayer'
import Hls from 'hls.js'
import Icon from '@/components/Icon.vue'
import CastSheet from '@/components/tv/CastSheet.vue'
import { castSupported, castStatus, castTo, stopCasting, type CastDevice } from '@/utils/cast'
import { useTvStore } from '@/stores/tv'
import { fetchDetail } from '@/utils/tv/cms'
import { refreshSafeArea } from '@/utils/native'
import type { TvDetail } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const sourceId = String(route.query.source || '')
const vodId = String(route.query.id || '')

const NEXT_SECONDS = 5
const SPEED_KEY = 'weread.tv.speed'

const detail = ref<TvDetail>()
const loading = ref(true)
const error = ref('')
const fatal = ref('')
const countdown = ref(0)
const reversed = ref(false)
const isFull = ref(false)
const drawerOpen = ref(false)
const rate = ref(readSpeed())

const groupIndex = ref(Number(route.query.g || 0))
const epIndex = ref(Number(route.query.e || 0))

const screen = ref<HTMLElement>()
const playerEl = ref<HTMLDivElement>()

let player: Artplayer | null = null
let hls: Hls | null = null
let lastSave = 0
let countTimer = 0
let startTimer = 0
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

const descOpen = ref(false)

/* ---------- 投屏 ---------- */
const showCast = castSupported()
const castOpen = ref(false)
const castSheet = ref<InstanceType<typeof CastSheet> | null>(null)
/** 正在投的设备；空表示本机播放。 */
const castTarget = ref<CastDevice | null>(null)
/** 界面上的「投屏到 XXX」。页面重建后只知道名字，所以和 castTarget 分开存。 */
const castName = ref('')

async function pickCast(d: CastDevice): Promise<void> {
  const ep = episode.value
  if (!ep) return
  try {
    await castTo(d, ep.url, `${detail.value?.name || ''} ${ep.name}`.trim())
    castTarget.value = d
    castName.value = d.name
    player?.pause()
    castOpen.value = false
    castSheet.value?.done()
    toast(`已投屏到 ${d.name}`)
  } catch {
    castSheet.value?.done()
    toast('投屏失败，换一台设备试试')
  }
}

async function stopCastHere(): Promise<void> {
  await stopCasting()
  castTarget.value = null
  castName.value = ''
  toast('已停止投屏')
}
/** 只有真的会被截断才给「展开」，否则那两个字就是噪声。 */
const canExpand = computed(() => (detail.value?.desc || '').length > 90)

/** 副信息：来源 · 年份 · 地区 · 类型，空的字段不占位。 */
const subLine = computed(() => {
  const d = detail.value
  if (!d) return ''
  return [d.source.name, d.year, d.area, d.typeName].filter(Boolean).join(' · ')
})

/**
 * 选集按钮上的短标签。
 *
 * CMS 给的集名五花八门：`第01集` / `HD国语版` / `正片`。命名里带数字就用数字
 * （参考图里的长视频 App 一律是编号方块），不带数字就退回「第几集」。
 */
function epLabel(name: string, index: number): string {
  const m = String(name || '').match(/(\d{1,4})/)
  return m ? String(Number(m[1])) : String(index + 1)
}

function goDetail(): void {
  void router.push({ name: 'tvDetail', query: { source: sourceId, id: vodId } })
}

/** 切换分组：选中该分组并回到正序。 */
function pickGroup(i: number): void {
  groupIndex.value = i
  reversed.value = false
}

function toggleOrder(): void {
  reversed.value = !reversed.value
}

function toggleDesc(): void {
  descOpen.value = !descOpen.value
}

function closeDrawer(): void {
  drawerOpen.value = false
}

function readSpeed(): number {
  const n = Number(localStorage.getItem(SPEED_KEY))
  return Number.isFinite(n) && n > 0 ? n : 1
}

function toast(text: string): void {
  if (player) player.notice.show = text
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  // 从别处回到播放页：插件还记着投的是哪台，界面要跟上。
  if (showCast) {
    void castStatus().then((st) => {
      if (st.casting && !castName.value) castName.value = st.name || '电视'
    })
  }
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
  // 全屏时返回键先退全屏，别让人直接从横屏跳走。
  if (isFull.value) {
    void exitFull()
    return
  }
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

/* ---------- 全屏 ---------- */

/**
 * 让整个舞台（`.tv-play__screen`）进平台全屏。
 *
 * 不直接把 `fullscreen: true` 交给 artplayer，是因为它只会把 `.art-video-player`
 * 递上去：「即将播放下一集」「播放失败」这些卡片是播放器的兄弟节点，进全屏就
 * 一起被裁掉了。把整个舞台递上去，浮层还在，视觉上和原生播放器一样。
 *
 * 状态栏和横屏都不在这里管 —— `MainActivity.FullscreenChromeClient` 收到
 * onShowCustomView 后隐藏系统栏、把 Activity 转成横屏；退出时再还回去。
 */
async function enterFull(): Promise<void> {
  const el = screen.value
  if (!el || typeof el.requestFullscreen !== 'function') {
    isFull.value = true
    return
  }
  try {
    await el.requestFullscreen()
  } catch {
    // 平台拒绝（没有用户手势 / iOS Safari）：至少把画面铺满，别让按钮变死键。
    isFull.value = true
  }
}

async function exitFull(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  isFull.value = false
}

async function toggleFullscreen(): Promise<void> {
  if (isFull.value) await exitFull()
  else await enterFull()
}

/** 平台全屏状态是唯一事实来源：Esc、系统手势退出时页面要跟上。 */
function onFullscreenChange(): void {
  const active = !!document.fullscreenElement
  isFull.value = active
  if (active) return
  // 系统栏是异步回来的，晚一点再读 inset，否则会把全屏期间的 0 写进 CSS。
  window.setTimeout(refreshSafeArea, 320)
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
  const resumeAt =
    history && history.groupIndex === groupIndex.value && history.episodeIndex === epIndex.value
      ? history.position
      : 0

  player = new Artplayer({
    container: playerEl.value,
    url: ep.url,
    type: isM3u8(ep.url) ? 'm3u8' : '',
    poster: detail.value?.pic || '',
    autoplay: true,
    playsInline: true,
    lang: 'zh-cn',
    theme: '#1b88ee',
    // 自带能力：不自己写触摸逻辑，见文件头注释。
    gesture: true,
    fastForward: true,
    lock: true,
    setting: true,
    playbackRate: true,
    // 全屏由页面接管：播放器自带的那个在 WebView 里点了没反应，也不转屏。
    fullscreen: false,
    fullscreenWeb: false,
    // WebView 里的画中画没有系统入口，留着只会占一格控制栏。
    // 音量同理：手机上调音量是硬件键的事，控制栏里那个喇叭在大屏上才有意义。
    pip: false,
    miniProgressBar: true,
    hotkey: true,
    customType: { m3u8: playM3u8 },
  })

  player.playbackRate = rate.value
  // 控制栏里的喇叭在触屏上没有意义（音量走硬件键），建好后直接摘掉。
  try {
    player.controls.remove('volume')
  } catch {
    /* 版本差异，没有就算了 */
  }
  player.on('ready', () => {
    started = true
    clearTimeout(startTimer)
    // 慢源有时先超时后出画面，错误卡片必须跟着撤掉。
    fatal.value = ''
    if (resumeAt > 3 && player) player.currentTime = resumeAt
  })
  player.on('video:timeupdate', onTimeUpdate)
  player.on('video:ratechange', onRateChange)
  player.on('video:ended', onEnded)
  player.on('video:error', () => {
    // hls.js 会自己上报可恢复/不可恢复的错误；这里只兜底直链 mp4。
    if (!isM3u8(ep.url)) fatal.value = '视频加载失败，请重试'
  })
  // 换集/换源会重建播放器，控件状态跟着重置。
  nextControlAdded = false
  addControls()

  // 正在投屏时换集：电视上也要跟着换，否则手机在放第 2 集、电视还是第 1 集。
  if (castTarget.value) {
    void castTo(castTarget.value, ep.url, `${detail.value?.name || ''} ${ep.name}`.trim()).catch(() => {
      castTarget.value = null
      castName.value = ''
    })
  }

  // 坏源经常既不报错也不出画面：30 秒没 ready 就当失败，别让人一直看转圈。
  started = false
  clearTimeout(startTimer)
  startTimer = window.setTimeout(() => {
    if (!started) fatal.value = '长时间没有画面，请重试'
  }, 30000)
}

/**
 * 往播放器自带控制栏里加两个按钮。
 *
 * 用 `controls.add` 而不是在画面上盖一层 div：这样按钮跟着控制栏一起显隐、
 * 跟着全屏移动，也不用再算 z-index。
 */
function addControls(): void {
  if (!player) return
  // index 沿用 artplayer 自己右侧控件的排位：设置 30 / 画中画 40 / 全屏 70，
  // 这样「选集」落在设置右边、全屏留在最右侧，和常见播放器一致。
  player.controls.add({
    name: 'episodes',
    position: 'right',
    index: 40,
    html: '<span style="font-size:12px;line-height:1">选集</span>',
    click: () => openDrawer(),
  })
  renderNextControl()
  renderCastControl()
  renderFullscreenControl()
}

/**
 * 投屏按钮。放在「选集」和全屏之间——参考里爱奇艺/腾讯都是这一排。
 * 没有原生插件的环境（浏览器预览）不加这个按钮，免得点了没反应。
 */
function renderCastControl(): void {
  if (!player || !showCast) return
  player.controls.update({
    name: 'cast',
    position: 'right',
    index: 50,
    html:
      // 必须带 style="fill:none"：artplayer 的样式表里有 `svg { fill: 文字色 }`，
      // 它的优先级高于 fill 属性，不加就会把屏幕填成一块白色方块。
      '<svg width="20" height="20" viewBox="0 0 24 24" style="fill:none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="5" width="18" height="13" rx="2.4"/>' +
      '<path d="M7.2 14.6a3.2 3.2 0 013.2 3.2M7.2 11a6.8 6.8 0 016.8 6.8"/>' +
      '<circle cx="7.4" cy="17.6" r="0.9" fill="currentColor" stroke="none"/></svg>',
    click: () => { castOpen.value = true },
  })
}

/**
 * 「下一集」放进控制栏，只在真的有下一集时出现。
 *
 * 原来它在页面下方那一行里，单集电影也摆一个灰按钮；而全屏时整行都不在，
 * 想跳下一集只能退出全屏。
 */
let nextControlAdded = false

function renderNextControl(): void {
  if (!player) return
  if (!hasNext.value) {
    // remove 对不存在的控件会抛，靠自己的标记判断而不是 controls.has（没有这个 API）
    if (nextControlAdded) {
      try {
        player.controls.remove('next')
      } catch {
        /* 已经没了 */
      }
      nextControlAdded = false
    }
    return
  }
  player.controls.update({
    name: 'next',
    position: 'right',
    index: 35,
    html: '<span style="font-size:12px;line-height:1">下一集</span>',
    click: () => next(),
  })
  nextControlAdded = true
}

watch(hasNext, renderNextControl)

/**
 * 全屏按钮的图标要跟着状态换。
 *
 * 用 `controls.update` 而不是 `remove` + `add`：组件不存在时 `remove` 会抛
 * "Can't find [name]"，而 `update` 对「有就替换、没有就新增」两种情况都成立。
 */
function renderFullscreenControl(): void {
  if (!player) return
  player.controls.update({
    name: 'pageFullscreen',
    position: 'right',
    index: 70,
    html: isFull.value ? player.icons.fullscreenOff : player.icons.fullscreenOn,
    click: () => void toggleFullscreen(),
  })
}

watch(isFull, renderFullscreenControl)

function onTimeUpdate(): void {
  // 进度在走就说明画面是好的，之前的超时/错误提示已经过期。
  if (fatal.value) fatal.value = ''
  const now = Date.now()
  if (now - lastSave < 10000) return
  lastSave = now
  saveProgress()
}

function onRateChange(): void {
  if (!player) return
  const v = player.playbackRate
  if (v === rate.value) return
  rate.value = v
  localStorage.setItem(SPEED_KEY, String(v))
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
    toast('已经是最后一集')
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
    toast('已经是最后一集')
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
  saveProgress()
  cancelCountdown()
  // 路由切走时必须退掉全屏：那层全屏 view 是盖在窗口上的，
  // 不退就会悬在书架/详情页上面，方向也留在横屏。
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
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
    </header>

    <div
      ref="screen"
      class="tv-play__screen"
      :class="{ 'tv-play__screen--full': isFull, 'tv-play__screen--fatal': !!fatal }"
    >
      <div ref="playerEl" class="tv-play__stage" />

      <div v-if="loading" class="tv-play__state">正在加载…</div>
      <div v-else-if="error" class="tv-play__state tv-play__state--error">{{ error }}</div>

      <div v-if="fatal" class="tv-play__fatal">
        <p class="tv-play__fatal-text">{{ fatal }}</p>
        <div class="tv-play__fatal-actions">
          <button class="tv-play__fatal-btn" @click="retry">重试</button>
          <button
            v-if="otherGroups"
            class="tv-play__fatal-btn tv-play__fatal-btn--primary"
            @click="switchGroup"
          >
            换线路
          </button>
        </div>
      </div>

      <!-- 自动连播卡片：倒计时条就是剩余时间。 -->
      <!-- 投屏中：本机不再放画面，用一层说明代替，避免「两个地方都在播」 -->
      <div v-if="castName" class="tv-play__casting">
        <svg class="tv-play__casting-icon" width="34" height="34" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="13" rx="2.4" />
          <path d="M7.2 14.6a3.2 3.2 0 013.2 3.2M7.2 11a6.8 6.8 0 016.8 6.8" />
          <circle cx="7.4" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
        </svg>
        <p class="tv-play__casting-text">正在投屏到 {{ castName }}</p>
        <button class="tv-play__casting-stop" @click="stopCastHere">停止投屏</button>
      </div>

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
    </div>

    <main class="tv-play__body">
      <div v-if="loading" class="tv-play__placeholder">正在加载…</div>
      <div v-else-if="error" class="tv-play__placeholder tv-play__placeholder--error">{{ error }}</div>

      <template v-else-if="detail">
        <!--
         信息层：和参考里的长视频 App 一致——当前集 + 详情入口、一行元信息、
         选集横向条、简介。原来这里是「倍速 / 下一集」两个按钮加一个四列网格，
         按钮和控制栏重复，网格用的是「HD国语版」这种长名字，一列只能放四个。
        -->
        <div class="tv-play__head">
          <div class="tv-play__head-main">
            <span class="tv-play__ep">{{ episode?.name }}</span>
            <span class="tv-play__rate" v-if="rate !== 1">{{ rate }}x</span>
          </div>
          <button class="tv-play__detail" @click="goDetail">
            详情
            <Icon name="chevron-right" :size="14" :width="2" />
          </button>
        </div>

        <p class="tv-play__sub">{{ subLine }}</p>

        <section v-if="orderedEps.length > 1 || detail.groups.length > 1" class="tv-play__eps">
          <div v-if="detail.groups.length > 1" class="tv-play__groups">
            <button
              v-for="(g, i) in detail.groups"
              :key="g.name + i"
              class="tv-play__group"
              :class="{ 'tv-play__group--active': i === groupIndex }"
              @click="pickGroup(i)"
            >
              {{ g.name }}（{{ g.episodes.length }}）
            </button>
          </div>

          <div class="tv-play__eps-head">
            <span class="tv-play__eps-title">选集</span>
            <span class="tv-play__eps-count">共 {{ orderedEps.length }} 集</span>
            <button class="tv-play__eps-order" @click="toggleOrder">
              {{ reversed ? '倒序' : '正序' }}
            </button>
          </div>

          <div class="tv-play__eps-strip">
            <button
              v-for="row in orderedEps"
              :key="row.ep.url"
              class="tv-play__ep-btn"
              :class="{ 'tv-play__ep-btn--active': row.index === epIndex }"
              :aria-label="row.ep.name"
              @click="pickEpisode(row.index)"
            >
              {{ epLabel(row.ep.name, row.index) }}
            </button>
          </div>
        </section>

        <section v-if="detail.desc" class="tv-play__desc" :class="{ 'tv-play__desc--open': descOpen }">
          <p class="tv-play__desc-text">{{ detail.desc }}</p>
          <button v-if="canExpand" class="tv-play__desc-toggle" @click="toggleDesc">
            {{ descOpen ? '收起' : '展开' }}
          </button>
        </section>
      </template>
    </main>

    <CastSheet
      ref="castSheet"
      :open="castOpen"
      @close="castOpen = false"
      @cast="pickCast"
    />

    <!-- 全屏选集抽屉：线路切换 + 剧集列表 -->
    <div v-if="drawerOpen" class="tv-play__mask" @click="closeDrawer">
      <aside class="tv-play__drawer" @click.stop>
        <div class="tv-play__drawer-head">
          <span class="tv-play__drawer-title">选集</span>
          <button class="tv-play__drawer-close" aria-label="关闭" @click="closeDrawer">
            <Icon name="close" :size="18" />
          </button>
        </div>
        <div v-if="detail && detail.groups.length > 1" class="tv-play__drawer-groups">
          <button
            v-for="(g, i) in detail.groups"
            :key="g.name + i"
            class="tv-play__group"
            :class="{ 'tv-play__group--active': i === groupIndex }"
            @click="pickGroup(i)"
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
.tv-play__nav-back {
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
.tv-play__nav-back:active {
  opacity: 0.55;
}
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

/* 投屏浮层：盖住画面，说明「现在电视在放」 */
.tv-play__casting {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  text-align: center;
  padding: 0 24px;
}

.tv-play__casting-icon { opacity: 0.9; }

.tv-play__casting-text {
  font-size: calc(14px * var(--app-font-scale));
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-play__casting-stop {
  min-height: 40px;
  padding: 0 18px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #fff;
  font-size: calc(13px * var(--app-font-scale));
}

/* 播放失败时 artplayer 的加载圈还转着，会和错误卡片叠在一起。 */
.tv-play__screen--fatal :deep(.art-loading) {
  display: none;
}

/*
 * 锁图标只在全屏里出现。
 *
 * artplayer 只要控制栏可见就把左侧那个锁挂出来（`art-control-show .art-layer-lock`），
 * 竖屏页面里它压在画面上、又没有对应的解锁上下文，看着像卡住了。
 */
.tv-play__screen:not(.tv-play__screen--full) :deep(.art-layer-lock) {
  display: none;
}

/*
 * 全屏（横屏）时控制栏贴着物理边缘，刘海/挖孔在侧边就会压住第一个和最后一个
 * 按钮。artplayer 自己的 --art-padding 是 10px，这里补上安全区。
 */
.tv-play__screen--full :deep(.art-bottom) {
  padding-left: calc(10px + var(--safe-left));
  padding-right: calc(10px + var(--safe-right));
}

/* 竖版海报放进 16:9 的框里会被左右留黑，按 cover 裁更像正常封面。 */
.tv-play__screen :deep(.art-poster) {
  object-fit: cover;
}

/* ---------- 状态与卡片 ---------- */

.tv-play__state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
  z-index: 1;
}
.tv-play__state--error {
  color: rgba(255, 160, 160, 0.9);
}

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
.tv-play__fatal-actions {
  display: flex;
  gap: 10px;
}
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
  color: var(--on-accent);
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
.tv-play__next-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
}
.tv-play__next-name {
  font-size: 13px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__next-actions {
  display: flex;
  gap: 8px;
}
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
  color: var(--on-accent);
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
.tv-play__placeholder--error {
  color: #d9534f;
}

.tv-play__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 4px;
}
.tv-play__head-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 当前集名，比正文重一档；长名字截断，不要把「详情」挤走。 */

.tv-play__detail {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: calc(13px * var(--app-font-scale));
}

/* 来源 · 年份 · 地区 · 类型 */
.tv-play__sub {
  margin: 2px 0 14px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__ep {
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__rate {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-on-soft);
  font-size: calc(12px * var(--app-font-scale));
}

.tv-play__eps {
  padding-top: 14px;
}
.tv-play__groups {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 12px;
  scrollbar-width: none;
}
.tv-play__groups::-webkit-scrollbar {
  display: none;
}
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
  border-color: var(--accent-on-soft);
  background: var(--accent-soft);
  color: var(--accent-on-soft);
}

.tv-play__eps-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.tv-play__eps-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tv-play__eps-count {
  flex: 1;
  font-size: 11px;
  color: var(--text-secondary);
}
.tv-play__eps-order {
  border: 1px solid var(--divider);
  border-radius: 12px;
  padding: 3px 10px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
}

/* 简介：默认三行，够长才给「展开」。 */
.tv-play__desc {
  margin-top: 18px;
}

.tv-play__desc-text {
  margin: 0;
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.7;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tv-play__desc--open .tv-play__desc-text {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}

.tv-play__desc-toggle {
  margin-top: 2px;
  height: 32px;
  padding: 0;
  color: var(--accent);
  font-size: calc(13px * var(--app-font-scale));
}

.tv-play__eps-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}

.tv-play__eps-strip::-webkit-scrollbar {
  display: none;
}

/*
 * 编号方块：参考图里爱奇艺 / 芒果都是用方块网格选集的，长名字（HD国语版）
 * 塞不进一行，而且一屏只能放四个。
 */
.tv-play__ep-btn {
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: calc(15px * var(--app-font-scale));
  font-variant-numeric: tabular-nums;
}

.tv-play__ep-btn--active {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 500;
}
/* ---------- 选集抽屉 ---------- */

.tv-play__mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.tv-play__drawer {
  position: absolute;
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
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
.tv-play__drawer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
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
.tv-play__drawer-groups::-webkit-scrollbar {
  display: none;
}
.tv-play__drawer-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* 行高交给内容：不写 start 的话行会被容器高度拉伸，几集之间空出大片间隙。 */
  align-content: start;
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
  color: var(--accent-on-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
