<script setup lang="ts">
/**
 * 播放页（竖屏播放页 + 横屏全屏播放器）。
 *
 * 界面按 `docs/evidence/视频播放/` 的两张芒果 TV 参考图还原：
 *   - 竖屏：视频满宽 16:9 顶到状态栏，返回压在左上，右上「投屏 / 更多」；
 *     控制条是单行「暂停 · 当前时间 · 进度 · 总长 · 全屏」；下方信息层是
 *     标题 + 详情 ›、标签胶囊、操作行（分享 / 收藏）、选集格子条、简介。
 *   - 横屏全屏：顶栏「返回 + 剧名 + 集名」+ 分享；进度条两端贴时间；
 *     控制行「暂停 · 下一集 · 弹幕开关 · 弹幕设置 · 发弹幕框 · 倍速 · 投屏 · 选集」。
 *
 * 参考图里的广告横幅、VIP 徽章与横幅、「会员福利 / 领会员」「只看TA」、
 * 「讨论 / 一起聊」标签、评论 / 下载按钮、「高能看点 / 看点」、「精彩短片」
 * 一概不做——要么是广告会员位，要么没有后端数据，摆上去就是点了没反应的假按钮。
 * 弹幕开关 / 设置 / 输入框按参考图画出来（控制行的弹幕三件套是播放器的
 * 视觉组成），但采集源没有弹幕服务器，真实弹幕发不了，点击只给「暂未开放」。
 *
 * 播放内核换成 xgplayer（字节开源）+ xgplayer-hls.js，替换掉原来的 artplayer：
 * artplayer 的手势层在 WebView 里偏弱（没有长按加速的力度反馈、没有缓冲态
 * 过渡），xgplayer 的移动端预设是国内长视频打磨过的，手势、缓冲、错误兜底
 * 都更接近芒果/腾讯那种观感。
 *
 * 控制栏仍然由本页自绘（`controls: false`），所以视觉上还是照着参考图来的
 * 那一套；xgplayer 只负责解码、缓冲、HLS 和手势（单击显隐由本页接管，
 * 双击播放/暂停、长按 2 倍速、左右拖进度是它自带）。
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
import Player from 'xgplayer'
import HlsJsPlugin from 'xgplayer-hls.js'
import 'xgplayer/dist/index.min.css'
import Icon from '@/components/Icon.vue'
import CastSheet from '@/components/tv/CastSheet.vue'
import { castSupported, castStatus, castTo, stopCasting, type CastDevice } from '@/utils/cast'
import { useTvStore } from '@/stores/tv'
import { fetchDetail } from '@/utils/tv/cms'
import { localEpisodes } from '@/utils/tv/local'
import { refreshSafeArea, applyStatusBarBackground, applyStatusBarStyle } from '@/utils/native'
import type { TvDetail } from '@/utils/tv/types'

const route = useRoute()
const router = useRouter()
const store = useTvStore()

const sourceId = String(route.query.source || '')
const vodId = String(route.query.id || '')

/**
 * 本地模式：从影视首页的「本地视频」入口进来（`?local=1`）。
 *
 * 不另开一个播放页，是因为播放核心（artplayer + hls、手势、锁屏、全屏、
 * 倍速、自动连播）全部与「片源从哪来」无关。这里只把本地文件拼成一份
 * 和 CMS 详情同形状的 `TvDetail`（一个线路 = 本次选的全部文件），
 * 下面的流程一行都不用分叉，两套界面也不会各自走偏。
 */
const localMode = String(route.query.local || '') === '1'
const LOCAL_ID = 'local'

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

let player: Player | null = null
let lastSave = 0
let countTimer = 0
let startTimer = 0
let started = false

/* ---------- 控制层状态 ---------- */
/** 顶栏/锁屏按钮是否露出，跟 xgplayer 的 `xgplayer-inactive` 走。 */
const ctrlVisible = ref(true)
const playing = ref(false)
const curTime = ref(0)
const duration = ref(0)
/**
 * 锁屏：锁定后控制层全部收起，只留左边的开锁按钮；画面上的点击不再
 * 切换播放/调进度（artplayer 的 `lock` 状态也一并置上，它自带的长按快进、
 * 双击播放都会检查 `isLock`）。
 */
const locked = ref(false)

/**
 * 顶栏是否露出。控制栏由 xgplayer 自己管，这里只跟着它的
 * `xgplayer-inactive`（见 `watchControls`）走。
 */
const uiShown = computed(() => !locked.value && ctrlVisible.value)
/** 锁按钮：控制层露出时用来上锁；锁定后常驻用来开锁。投屏时没有可锁的画面。 */
const lockVisible = computed(() => !castName.value && (locked.value || uiShown.value))

/** 竖屏选集先铺这么多格，余下的收在「展开全部」里（参考图也是这样）。 */
const EPS_PREVIEW = 12
const epsOpen = ref(false)

/** 「01集」——集号补两位，网格里对齐才整齐。 */
function epNum(index: number): string {
  return `${String(index + 1).padStart(2, '0')}集`
}

const group = computed(() => detail.value?.groups[groupIndex.value])
const episode = computed(() => group.value?.episodes[epIndex.value])
const hasNext = computed(() => !!group.value && epIndex.value + 1 < group.value.episodes.length)
const nextEpisode = computed(() => group.value?.episodes[epIndex.value + 1])
const otherGroups = computed(() => (detail.value?.groups.length || 0) > 1)

/** 倒序只改展示顺序，点击时仍用原始下标。 */
const visibleEps = computed(() =>
  epsOpen.value ? orderedEps.value : orderedEps.value.slice(0, EPS_PREVIEW),
)

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

/**
 * 标签行：类型 / 年份 / 地区 / 状态。
 *
 * 参考图那一行还有「7.1 亿次播放」和演员名——我们没有播放量数据，也没有演员字段，
 * 就不编造，只放详情里真实有的。来源名放到「详情」页，那里已经有完整信息块。
 */
const tags = computed(() => {
  const d = detail.value
  if (!d) return [] as string[]
  return [d.typeName, d.year, d.area, d.remarks].filter((x): x is string => !!x)
})

/* ---------- 控制层交互 ---------- */

/**
 * 锁屏开关。
 *
 * 锁定后整个舞台不接收指针事件（`.tv-play__stage--locked`）：xgplayer 的
 * 单击/双击/长按/拖动监听都挂在舞台里，这一下就全失效了，不用去改它的内部
 * 状态。界面上只留右下角的开锁按钮。
 */
function toggleLock(): void {
  locked.value = !locked.value
  if (locked.value) {
    player?.blur()
    setControlsHidden(true)
    ctrlVisible.value = false
  } else {
    setControlsHidden(false)
    player?.focus()
  }
}

/**
 * 把 xgplayer 的控制栏从 DOM 上藏掉/放回来。
 *
 * 只用 CSS 不可靠：全屏时插件的层级和选择器优先级都不由我们控制，实测锁屏后
 * 底层控制栏还能点。行内 `display:none` 优先级最高，解锁时清空即可恢复。
 */
function setControlsHidden(hidden: boolean): void {
  const root = player?.root as HTMLElement | undefined
  const bar = root?.querySelector('.xgplayer-controls') as HTMLElement | null
  if (bar) bar.style.display = hidden ? 'none' : ''
}

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

const toastText = ref('')
let toastTimer = 0

/** 一句 1.8 秒的提示，自己画一层（不借播放器的 notice）。 */
function toast(text: string): void {
  toastText.value = text
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastText.value = ''
  }, 1800)
}

/** 上次用过的语速。 */
function readSpeed(): number {
  const n = Number(localStorage.getItem(SPEED_KEY))
  return Number.isFinite(n) && n > 0 ? n : 1
}

/* ---------- 进页面 ---------- */

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  // 页面顶部是黑色视频舞台：状态栏跟它一体（白图标/黑底），离开页面时
  // App 的 route 监听会按新页面重新同步回去。
  applyStatusBarStyle({ dark: true })
  void applyStatusBarBackground('#000000')
  // 从别处回到播放页：插件还记着投的是哪台，界面要跟上。
  // 本地文件（blob URL）只能本机解，不参与投屏。
  if (showCast && !localMode) {
    void castStatus().then(st => {
      if (st.casting && !castName.value) castName.value = st.name || '电视'
    })
  }
  await store.load()

  if (localMode) {
    const eps = localEpisodes()
    if (!eps.length) {
      error.value = '本地视频已失效，请回影视页重新选择'
      loading.value = false
      return
    }
    // 一个线路 = 本次选中的全部文件，选集 / 连播就都是现成的。
    detail.value = {
      id: LOCAL_ID,
      name: eps[0].name,
      groups: [{ name: '本机', episodes: eps }],
      source: { id: LOCAL_ID, name: '本地视频', api: '', enabled: true, addedAt: 0 },
    }
    if (!eps[epIndex.value]) epIndex.value = 0
    loading.value = false
    await nextTick()
    mount()
    return
  }

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
  // 本地片没有详情页可回，直接回影视首页（getHistory 里没有 back 时也一样）。
  if (localMode) {
    router.replace({ name: 'tv' })
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
 * 退出平台全屏（返回键、系统手势、Esc 都走这里）。
 *
 * 进全屏由 xgplayer 的按钮发起，目标是我们整个舞台（见 `fullscreen.target`），
 * 所以「即将播放下一集」「播放失败」这些兄弟浮层在全屏里也还在。
 * 状态栏和横屏都不在这里管 —— `MainActivity.FullscreenChromeClient` 收到
 * onShowCustomView 后隐藏系统栏、把 Activity 转成横屏；退出时再还回去。
 */
async function exitFull(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  isFull.value = false
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

/**
 * 控制层的显隐交给 xgplayer。
 *
 * 它自己会在根节点上切 `xgplayer-inactive`（单击、播放中 3 秒无操作都会切），
 * 顶栏和锁屏按钮跟着这个 class 走，节奏就和播放条完全一致，不用自己算计时器。
 */
let classObserver: MutationObserver | null = null

function watchControls(): void {
  classObserver?.disconnect()
  classObserver = null
  const root = player?.root as HTMLElement | undefined
  if (!root) return
  /*
   * 只在「正在播 + xgplayer 自己收起了控制栏」时才跟着藏。
   * 它的初始状态就是 inactive，直接照抄的话顶栏和锁按钮一进页面就是隐形的。
   */
  const sync = (): void => {
    ctrlVisible.value = !root.classList.contains('xgplayer-inactive') || !playing.value
  }
  sync()
  classObserver = new MutationObserver(sync)
  classObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
}

/**
 * 打开插件自带的移动端手势。
 *
 * `MobilePlugin` 的默认配置里 `disablePress: true` —— 长按加速是关着的，
 * 得显式打开并把倍速定在 2x（芒果/腾讯都是这个力度）。上下滑调亮度、
 * 左右滑调进度、双击播放暂停默认就有，只是需要 mobile 预设被装上。
 */
function applyMobileGestures(): void {
  const mobile = (player as unknown as { plugins?: Record<string, { config?: Record<string, unknown> }> })
    ?.plugins?.mobile
  if (!mobile?.config) return
  mobile.config.disablePress = false
  mobile.config.pressRate = 2
  mobile.config.darkness = true
}

function mount(): void {
  destroyPlayer()
  fatal.value = ''
  const ep = episode.value
  if (!ep || !playerEl.value) return

  // 本地模式下大标题就是当前文件名（CMS 模式下是片名，别动）。
  if (localMode && detail.value) detail.value.name = ep.name

  const history = localMode ? undefined : store.historyOf(sourceId, vodId)
  const resumeAt =
    history && history.groupIndex === groupIndex.value && history.episodeIndex === epIndex.value
      ? history.position
      : 0

  player = new Player({
    el: playerEl.value,
    /*
     * 必须显式给百分比：xgplayer 的默认配置里写死了 600×337.5，不给就按这个
     * 尺寸铺在舞台左上角（竖屏 400 宽时画面比换行还宽，横屏也对不上）。
     */
    width: '100%',
    height: '100%',
    url: ep.url,
    poster: detail.value?.pic || '',
    autoplay: true,
    playsinline: true,
    // 控制栏用 xgplayer 自带的（进度条、倍速、清晰度、全屏都是它做好的）。
    controls: true,
    /**
     * 不要的几个：手机上调音量是硬件键的事，下载/截屏/画中画在这个 App 里
     * 没有去处。留着的都是真能用的（播放、进度、时间、倍速、清晰度、全屏）。
     */
    ignores: ['pip', 'download', 'screenShot', 'volume'],
    lang: 'zh-cn',
    /*
     * 手势力气全在 mobile 预设里（长按加速、左右滑调进度、上下滑调亮度/音量）。
     * 预设按 UA 判定，WebView 里有可能被判成 pc —— 直接钉死成 mobile，反正
     * 这个 App 只在手机上跑。
     */
    isMobileSimulateMode: 'mobile',
    plugins: [HlsJsPlugin],
    /*
     * 全屏按钮是 xgplayer 的，但目标必须是我们整个舞台：它默认只把自己的
     * 根节点递上去，「即将播放下一集」「播放失败」这些兄弟浮层就一起被裁掉了。
     */
    fullscreen: { target: screen.value || undefined },
  })

  started = false
  watchControls()
  applyMobileGestures()
  player.playbackRate = rate.value
  player.on('ready', () => {
    started = true
    clearTimeout(startTimer)
    // 慢源有时先超时后出画面，错误卡片必须跟着撤掉。
    fatal.value = ''
    if (resumeAt > 3 && player) player.currentTime = resumeAt
  })
  // 播放状态取 video 元素本身：xgplayer 代理了原生事件，所以快捷键、
  // 系统打断这类「不是它自己 API 发起的」暂停也能把图标改对。
  player.on('play', () => {
    playing.value = true
  })
  player.on('pause', () => {
    playing.value = false
    // 暂停时控制栏和顶栏都该在。
    ctrlVisible.value = true
  })
  player.on('timeupdate', onTimeUpdate)
  player.on('durationchange', syncClock)
  player.on('loadedmetadata', syncClock)
  player.on('ratechange', onRateChange)
  player.on('ended', onEnded)
  player.on('error', () => {
    /*
     * 本地文件最常见的失败是容器/编码不被 WebView 支持（mkv、avi 之类），
     * 说「加载失败请重试」会让人反复重试一个永远放不了的文件。
     * 在线源在还没出画面时的错误才是真的播不出来。
     */
    if (isM3u8(ep.url)) {
      if (!started) fatal.value = '播放失败：源站拒绝或网络不通'
      return
    }
    fatal.value = localMode ? '这个文件播不了，可能是系统不支持它的封装格式' : '视频加载失败，请重试'
  })
  syncClock()
  playing.value = !player.paused

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

function syncClock(): void {
  if (!player) return
  curTime.value = player.currentTime || 0
  duration.value = player.duration || 0
}

function onTimeUpdate(): void {
  // 进度在走就说明画面是好的，之前的超时/错误提示已经过期。
  if (fatal.value) fatal.value = ''
  syncClock()
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
  // 本地文件没有可续播的身份：blob URL 每次选择都不同，写进「观看记录」
  // 只会变成一条点开就黑的条目，索性不记。
  if (localMode) return
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
  classObserver?.disconnect()
  classObserver = null
  // xgplayer 的 destroy 会连 video 元素和 HLS 一起收掉，不用自己再拆一层。
  player?.destroy()
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
  // 本地模式只带集号：源和影片 id 都是空的，写回 ?source= 反而会让刷新时
  // 走成「源不存在」。
  const query: Record<string, string> = localMode
    ? { local: '1', e: String(e) }
    : { source: sourceId, id: vodId, g: String(g), e: String(e) }
  router.replace({ name: 'tvPlay', query })
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

/* ---- 模板事件 ---- */
function handleBackOrExit(): void {
  if (isFull.value) void exitFull()
  else goBack()
}

function handleOpenCast(): void {
  castOpen.value = true
}

function handleCloseCast(): void {
  castOpen.value = false
}

function handlePickEpisode(row: { index: number }): void {
  pickEpisode(row.index)
}
</script>

<template>
  <div class="tv-play">
    <div class="tv-play__stagewrap">
      <div
        ref="screen"
        class="tv-play__screen"
        :class="{
          'tv-play__screen--full': isFull,
          'tv-play__screen--fatal': !!fatal,
          'tv-play__screen--locked': locked,
        }"
      >
        <div ref="playerEl" class="tv-play__stage" />

        <!--
          弹幕层：参考图里弹幕是飘过画面的。采集源没有弹幕服务器，这里留一层空
          容器占位（浮动层本身是播放器视觉的一部分），开关与输入框在控制行里。
        -->
        <div class="tv-play__dm" aria-hidden="true" />

        <!-- 一句提示（弹幕未开放之类）。以前借播放器的 notice，现在自己画一层。 -->
        <p v-if="toastText" class="tv-play__toast">{{ toastText }}</p>

        <!--
          顶部层：左「返回」，右「投屏」（竖屏与全屏同一颗，功能就是投屏面板）。
          参考图右上是分享/更多/耳机/小窗——分享去信息行，耳机小窗没有后端。
          pointer-events: none 留给画面本身的点击（单击显隐控制层），只有按钮吃事件。
        -->
        <div class="tv-play__top" :class="{ 'tv-play__layer--off': !uiShown }">
          <button
            class="tv-play__ico"
            :aria-label="isFull ? '退出全屏' : '返回'"
            @click.stop="handleBackOrExit"
          >
            <Icon name="back" :size="22" :width="2" />
          </button>

          <span v-if="isFull" class="tv-play__fs-titles">
            <span class="tv-play__fs-name">{{ detail?.name }}</span>
            <span v-if="episode?.name" class="tv-play__fs-sub">{{ episode.name }}</span>
          </span>

          <span class="tv-play__top-gap" />

          <!-- 本地文件是 blob URL，电视端拿不到，投屏按钮只在点播模式出现。 -->
          <button v-if="!localMode" class="tv-play__ico" aria-label="投屏" @click.stop="handleOpenCast">
            <svg
              width="21"
              height="21"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="5" width="18" height="13" rx="2.4" />
              <path d="M7.2 14.6a3.2 3.2 0 013.2 3.2M7.2 11a6.8 6.8 0 016.8 6.8" />
              <circle cx="7.4" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <!--
            竖屏正文里已经有选集网格，这里只在全屏出现——全屏看不到正文，
            抽屉是唯一能换集的入口。
          -->
          <button
            v-if="isFull && detail && (orderedEps.length > 1 || detail.groups.length > 1)"
            class="tv-play__txt"
            @click.stop="openDrawer"
          >
            选集
          </button>
        </div>

        <!--
          锁屏按钮：控制层露出时它用来上锁，锁上后常驻（其他都收起）用来开锁。
          位置比 artplayer 默认的贴边锁更靠里（左 24px + 安全区）：
          横屏时挖孔摄像头常落在左边缘中部，贴边会被挡住。
        -->
        <button
          v-if="lockVisible"
          class="tv-play__lock"
          :class="{ 'tv-play__lock--on': locked }"
          :aria-label="locked ? '解锁' : '锁屏'"
          @click.stop="toggleLock"
        >
          <Icon :name="locked ? 'lock' : 'unlock'" :size="20" />
        </button>

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
          <svg
            class="tv-play__casting-icon"
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="5" width="18" height="13" rx="2.4" />
            <path d="M7.2 14.6a3.2 3.2 0 013.2 3.2M7.2 11a6.8 6.8 0 016.8 6.8" />
            <circle cx="7.4" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
          </svg>
          <p class="tv-play__casting-text">正在投屏到 {{ castName }}</p>
          <button class="tv-play__casting-stop" @click="stopCastHere">停止投屏</button>
        </div>

        <!-- 锁屏时收起自动连播卡片：锁的意义就是画面上不留任何可误触的按钮
             （自动连播本身照常走）。 -->
        <div v-if="countdown && !locked" class="tv-play__next">
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

        <!--
          投屏面板和选集抽屉挂在屏幕层里面：`:fullscreen` 只让全屏元素连同它的
          后代进顶层，放在外面的浮层会被整个盖住——全屏下打开选集/投屏看到的就是
          一块黑。竖屏时 `position:fixed` 仍按视口铺满整页（overflow:hidden 不裁
          fixed 后代），全屏时切成 absolute 盖住整个屏幕元素。
        -->
        <CastSheet ref="castSheet" :open="castOpen" @close="handleCloseCast" @cast="pickCast" />

        <!-- 选集抽屉：线路切换 + 剧集列表 -->
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
                @click="handlePickEpisode(row)"
              >
                {{ row.ep.name }}
              </button>
            </div>
            <button class="tv-play__drawer-order" @click="toggleOrder">
              {{ reversed ? '倒序' : '正序' }}
            </button>
          </aside>
        </div>
      </div>
    </div>

    <main class="tv-play__body">
      <div v-if="loading" class="tv-play__placeholder">正在加载…</div>
      <div v-else-if="error" class="tv-play__placeholder tv-play__placeholder--error">{{ error }}</div>

      <template v-else-if="detail">
        <!--
          信息层照竖屏参考图的版式：大标题 +「详情 ›」、标签胶囊、操作行、选集。
          参考图里「看点」、收藏的「24.9万」计数、评论 / 下载按钮、
          「视频 / 讨论 / 一起聊」分栏都没有后端数据，不画。
        -->
        <div class="tv-play__title-row">
          <h1 class="tv-play__name">{{ detail.name }}</h1>
          <!-- 我删掉了详情 -->
        </div>

        <div v-if="tags.length" class="tv-play__tags">
          <span v-for="t in tags" :key="t" class="tv-play__tag">{{ t }}</span>
        </div>

        <section v-if="detail.desc" class="tv-play__desc" :class="{ 'tv-play__desc--open': descOpen }">
          <h2 class="tv-play__desc-title">简介</h2>
          <p class="tv-play__desc-text">{{ detail.desc }}</p>
          <button v-if="canExpand" class="tv-play__desc-toggle" @click="toggleDesc">
            {{ descOpen ? '收起' : '展开' }}
          </button>
        </section>

        <!--
          选集照参考图：标题 + 集数 + 正序，网格先铺几行，余下的收在
          「展开全部 N 集」里。全屏那套抽屉不动（进全屏后由顶栏「选集」打开）。
        -->
        <section v-if="orderedEps.length > 1" class="tv-play__eps">
          <div class="tv-play__eps-head">
            <span class="tv-play__eps-title">选集</span>
            <span class="tv-play__eps-count">{{ orderedEps.length }} 集</span>
            <button class="tv-play__eps-order" @click="toggleOrder">
              {{ reversed ? '倒序' : '正序' }}
            </button>
          </div>
          <div class="tv-play__eps-grid">
            <button
              v-for="row in visibleEps"
              :key="row.ep.url"
              class="tv-play__ep"
              :class="{ 'tv-play__ep--on': row.index === epIndex }"
              @click="handlePickEpisode(row)"
            >
              {{ epNum(row.index) }}
            </button>
          </div>
          <button
            v-if="orderedEps.length > EPS_PREVIEW"
            class="tv-play__eps-more"
            @click="epsOpen = !epsOpen"
          >
            {{ epsOpen ? '收起' : `展开全部 ${orderedEps.length} 集` }}
            <Icon
              name="chevron-right"
              :size="12"
              :width="2"
              class="tv-play__eps-more-icon"
              :class="{ 'tv-play__eps-more-icon--open': epsOpen }"
            />
          </button>
        </section>

      </template>
    </main>
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

/* 视频区满宽顶到状态栏（参考图里视频是贴着屏幕顶的），状态栏压在黑色底上。 */
.tv-play__stagewrap {
  padding-top: var(--safe-top);
  background: #000;
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

/*
 * 弹幕层：参考图里弹幕从右往左飘过画面。没有弹幕服务器时这里是一层空容器，
 * 视觉占位 + 将来接弹幕源时直接往里塞轨道。
 */
.tv-play__dm {
  position: absolute;
  inset: 0 0 32% 0;
  /*
   * z 必须高于播放器根节点（画面），否则弹幕会飘在视频下面；又低于控制层。
   */
  z-index: 20;
  pointer-events: none;
  overflow: hidden;
}

/* 控制层按钮可以点，层本身不吃事件——点击空白处仍要能显隐控制层。 */
.tv-play__top,
.tv-play__bar {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  pointer-events: none;
  color: #fff;
  transition: opacity 0.18s ease;
}
.tv-play__layer--off {
  opacity: 0;
  pointer-events: none;
}
.tv-play__layer--off :deep(*) {
  pointer-events: none !important;
}

.tv-play__top {
  top: 0;
  gap: 2px;
  padding: calc(4px + var(--safe-top)) calc(10px + var(--safe-right)) 22px calc(6px + var(--safe-left));
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.45), transparent);
}
/*
 * 全屏时系统栏已经藏起来了，`--safe-top` 还在（值是状态栏高度），
 * 顶栏就离屏幕边缘老远。全屏统一收到 6px，视觉上和原生播放器一样贴着边。
 */
.tv-play__screen--full .tv-play__top,
.tv-play__screen:fullscreen .tv-play__top {
  padding-top: 6px;
}

/* 竖屏时视频已经在安全区下方，顶栏不用再叠一层安全区 */
.tv-play__screen:not(.tv-play__screen--full) .tv-play__top {
  padding-top: 4px;
  padding-left: calc(6px + var(--safe-left));
  padding-right: calc(10px + var(--safe-right));
}

.tv-play__top-gap {
  flex: 1;
}

.tv-play__fs-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-left: 2px;
  pointer-events: none;
}
.tv-play__fs-name {
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 600;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-play__fs-sub {
  font-size: calc(11px * var(--app-font-scale));
  color: rgba(255, 255, 255, 0.72);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-play__ico {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 0;
  background: transparent;
  color: #fff;
  pointer-events: auto;
}
.tv-play__ico--sm {
  width: 34px;
}
.tv-play__ico:active {
  opacity: 0.55;
}

/* ---------- 底部控制层 ---------- */

.tv-play__bar {
  bottom: 0;
  padding: 0 calc(10px + var(--safe-right)) 10px calc(10px + var(--safe-left));
}

/* 竖屏单行：暂停 · 00:04 —进度— 11:40 · 全屏 */
.tv-play__bar--mini {
  gap: 8px;
}
.tv-play__bar--mini .tv-play__time {
  flex: 0 0 auto;
}

/* 全屏：进度行（时间贴两端）+ 控制行 */
.tv-play__bar--full {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding-bottom: calc(8px + var(--safe-bottom));
}
.tv-play__progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tv-play__ctrl-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tv-play__row-gap {
  flex: 1;
}

.tv-play__time {
  font-size: 12px;
  line-height: 1;
  color: #fff;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

/* 进度条：细轨道 + 白色圆滑块。整条 22px 高是拖动热区，看得见的只有中间 3px。 */
.tv-play__track {
  flex: 1;
  min-width: 0;
  height: 22px;
  display: flex;
  align-items: center;
  pointer-events: auto;
  touch-action: none;
}
.tv-play__track-run {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: 1.5px;
  background: rgba(255, 255, 255, 0.32);
}
.tv-play__track-played {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 1.5px;
  background: #fff;
}
.tv-play__thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}

.tv-play__txt {
  flex: 0 0 auto;
  height: 38px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: #fff;
  font-size: 13px;
  font-family: inherit;
  pointer-events: auto;
}
.tv-play__txt:active {
  opacity: 0.55;
}

/* ---------- 弹幕三件套（开关 / 设置 / 输入框） ---------- */

.tv-play__dm-btn {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 3px;
  height: 38px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 15px;
  font-weight: 600;
  font-family: inherit;
  pointer-events: auto;
}
.tv-play__dm-btn--on {
  color: #fff;
}
/* 开关开着时右下角一枚红底白勾的小圆徽，照参考图 */
.tv-play__dm-badge {
  position: absolute;
  right: 2px;
  bottom: 5px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #ff3b30;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tv-play__dm-gear {
  opacity: 0.85;
}

.tv-play__dm-input {
  flex: 0 0 auto;
  width: 112px;
  height: 30px;
  margin-left: 4px;
  padding: 0 12px;
  border: 0;
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  pointer-events: auto;
}

/* ---------- 倍速浮层 / 菜单 ---------- */

.tv-play__rates {
  position: absolute;
  right: calc(10px + var(--safe-right));
  bottom: calc(52px + var(--safe-bottom));
  /* 必须压过播放器画面：不写 z 的浮层会被画面
     盖住——看不见选项，点击还穿到视频上变成切换播放。 */
  z-index: 33;
  display: flex;
  flex-direction: column;
  padding: 6px;
  border-radius: 10px;
  background: rgba(20, 20, 22, 0.92);
  pointer-events: auto;
}
.tv-play__rate {
  min-width: 64px;
  height: 34px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  font-family: inherit;
}
.tv-play__rate--on {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

/* 全屏控制行更高（进度行+控制行），浮层再往上抬，别压着按钮 */
.tv-play__screen--full .tv-play__rates {
  bottom: calc(88px + var(--safe-bottom));
}

/*
 * 锁屏按钮：竖屏/全屏都在画面左侧、垂直居中。
 * 比 artplayer 默认的贴边锁更靠里（左 24px + 安全区）：横屏时挖孔摄像头
 * 常落在左边缘中部，贴边放会被挡住。
 */
.tv-play__lock {
  position: absolute;
  /* 再往里 44px：挖孔摄像头在横屏时落在左边缘中部，贴边放会被挡住 */
  left: calc(44px + var(--safe-left));
  top: 50%;
  transform: translateY(-50%);
  /* 高于插件控制栏（10）和连播卡片（24）：锁上之后它是画面上唯一能点的东西 */
  z-index: 36;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 50%;
  background: rgba(20, 20, 22, 0.55);
  color: #fff;
  pointer-events: auto;
  transition: opacity 0.18s ease;
}
.tv-play__lock:active {
  opacity: 0.6;
}
/* 锁定态用实一点的底色，一眼能找出「唯一的按钮」 */
.tv-play__lock--on {
  /* 锁上之后控制栏全没了，这颗按钮必须一眼能找到：加深底色 + 描边 */
  background: rgba(0, 0, 0, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.42);
}

/*
 * 投屏浮层：盖住画面，说明「现在电视在放」。
 * 必须是实底 —— 半透明时底下停住的那一帧会透上来，字和画面叠在一起看不清。
 * z 压在播放器控制栏之上、顶栏（30）之下：投屏时不该还留着播放按钮，
 * 但「返回」必须点得到，否则用户只能靠系统返回键离开这一页。
 */
.tv-play__casting {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: #0e0e11;
  color: #fff;
  text-align: center;
  padding: 0 24px;
}

.tv-play__casting-icon {
  opacity: 0.9;
}

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

/*
 * xgplayer 这边是 `controls: false`，控制栏根本不渲染；下面的 `:deep` 只兜
 * 住它自己会插的那几层（海报、加载圈），免得和自绘层叠在一起。
 * 竖版海报放进 16:9 的框里会被左右留黑，按 cover 裁更像正常封面。
 */
.tv-play__screen :deep(.xgplayer-poster) {
  object-fit: cover;
  background-size: cover;
}

/* 加载圈用自绘卡片代替，别和「正在加载…」「播放失败」两层文字打架。 */
.tv-play__screen :deep(.xgplayer-loading),
.tv-play__screen :deep(xg-loading) {
  display: none;
}

/* 播放失败时播放器的加载圈还转着，会和错误卡片叠在一起。 */
.tv-play__screen--fatal :deep(.xgplayer-loading),
.tv-play__screen--fatal :deep(xg-loading) {
  display: none;
}

/*
 * 锁屏：整个舞台不接收指针事件。xgplayer 的单击/双击/长按/拖动监听全挂在
 * 舞台里，这一条等于一次性把它们关掉，不用去改它的内部状态。
 */
.tv-play__screen--locked .tv-play__stage {
  pointer-events: none;
}

/*
 * 控制栏不能只靠 `player.blur()` 收：xgplayer 在暂停、报错、播完这些时机
 * 会自己把控制栏弹回来。锁屏期间直接压住它，解锁后才恢复。
 */
.tv-play__screen--locked :deep(.xgplayer-controls) {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* 一句提示，位置和播放器的 prompt 一致：画面上方三分之一处。 */
.tv-play__toast {
  position: absolute;
  top: 38%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  margin: 0;
  padding: 7px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.72);
  font-size: 13px;
  color: #fff;
  pointer-events: none;
}

/*
 * 选集入口：一条可点的行，视觉上像列表项（标题 + 副标题 + 箭头），
 * 点开才是抽屉。原来这里还铺了一整行集数按钮，同一件事两个形态，去掉了。
 */
/* ---------- 状态与卡片 ---------- */

.tv-play__state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
  /* 高于播放器画面：出错/加载文字要压在画面之上 */
  z-index: 20;
}
.tv-play__state--error {
  color: rgba(255, 160, 160, 0.9);
}

.tv-play__fatal {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  /* 高于播放器画面：错误卡片要盖住画面，而不是被画面盖住 */
  z-index: 24;
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
  /* 抬到控制层上面：贴着底边会压住「倍速 / 选集」那一排。 */
  bottom: calc(58px + var(--safe-bottom));
  /* 高于播放器画面：连播卡片要盖住画面（参考图的浮层都在画面之上） */
  z-index: 24;
  width: min(72%, 280px);
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(18, 18, 18, 0.92);
}
.tv-play__screen--full .tv-play__next {
  bottom: calc(86px + var(--safe-bottom));
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

/* ---------- 信息层：标题 / 标签 / 操作行 ---------- */

.tv-play__title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.tv-play__name {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: calc(22px * var(--app-font-scale));
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tv-play__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

/* 参考里这一行是浅灰胶囊，字比正文小一号、比副标题略深 */
.tv-play__tag {
  padding: 5px 12px;
  border-radius: 15px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.3;
  white-space: nowrap;
}

/* ---------- 选集 ---------- */

.tv-play__eps {
  padding-top: 18px;
}
/* 抽屉里的线路切换按钮；页面正文里不再有这一排。 */
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
.tv-play__eps-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}
/* 集数在标题右侧，正序/倒序贴在行尾（参考图就是这一行三个元素）。 */
.tv-play__eps-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.tv-play__eps-count {
  flex: 1;
  min-width: 0;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}
.tv-play__eps-order {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--divider);
  border-radius: 14px;
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(12px * var(--app-font-scale));
  font-family: inherit;
}
.tv-play__eps-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.tv-play__ep {
  height: 44px;
  border: 0;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: calc(13px * var(--app-font-scale));
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
/*
 * 正在播的那一集：浅粉底 + 橙红字。颜色跟参考图一致（不是品牌蓝），
 * 和锁屏/连播那套「播放中」的标记色也统一。
 */
.tv-play__ep--on {
  background: rgba(255, 92, 61, 0.14);
  color: #ff5c3d;
}
.tv-play__eps-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  height: 40px;
  margin-top: 10px;
  border: 0;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: calc(13px * var(--app-font-scale));
  font-family: inherit;
}
.tv-play__eps-more:active {
  opacity: 0.75;
}
.tv-play__eps-more-icon {
  transition: transform 0.18s ease;
}
.tv-play__eps-more-icon--open {
  transform: rotate(90deg);
}

/* ---------- 简介 ---------- */

.tv-play__desc {
  margin-top: 20px;
}

.tv-play__desc-title {
  margin: 0 0 6px;
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
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

/* ---------- 选集抽屉 ---------- */

.tv-play__mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
/*
 * 浮层现在挂在屏幕层里面（见模板注释）：全屏时屏幕元素本身就是整个视口，
 * 用 absolute 盖满它；fixed 在全屏元素内部的参照会被浏览器收成全屏盒，
 * 尺寸计算上不可靠，这里写死 absolute 兜底。
 */
.tv-play__screen--full .tv-play__mask {
  position: absolute;
}
.tv-play__screen--full :deep(.cast-mask) {
  position: absolute;
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
  padding: 12px 14px 8px;
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
.tv-play__drawer-order {
  margin: 0 14px calc(12px + var(--safe-bottom));
  height: 32px;
  border: 1px solid var(--divider);
  border-radius: 16px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
}
</style>
