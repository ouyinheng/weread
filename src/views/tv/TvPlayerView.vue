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
 * 播放内核是 artplayer（成熟开源库）+ hls.js。artplayer 自带的控制栏整个
 * 藏掉（CSS `display:none`），控制层由本页自绘，显隐跟着 artplayer 的
 * `control` 事件走——单击显隐、双击播放/暂停、左右拖动调进度（`gesture`）、
 * 长按 3 倍速（`fastForward`）、锁屏（`lock`）这些手势仍是它自带的。
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
import MorphIcon from '@/components/MorphIcon.vue'
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
const FAV_KEY = 'weread.tv.fav'

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

/* ---------- 自绘控制层状态 ---------- */
/** 跟 artplayer 的 `control` 事件：true = 控制层该显示。 */
const ctrlVisible = ref(true)
const playing = ref(false)
const curTime = ref(0)
const duration = ref(0)
const dragging = ref(false)
const dragRatio = ref(0)
/** 「倍速」浮层（竖屏控制条 / 全屏控制行共用）。 */
const rateOpen = ref(false)
const danmakuOn = ref(true)
const faved = ref(false)
/**
 * 锁屏：锁定后控制层全部收起，只留左边的开锁按钮；画面上的点击不再
 * 切换播放/调进度（artplayer 的 `lock` 状态也一并置上，它自带的长按快进、
 * 双击播放都会检查 `isLock`）。
 */
const locked = ref(false)

/**
 * 控制层是否露出（拖进度/开着浮层时别跟着自动隐藏一起消失）。
 * 锁定时一律收起——锁定按钮自己单独走 `lockVisible`。
 */
const uiShown = computed(() => !locked.value && (ctrlVisible.value || rateOpen.value || dragging.value))
/** 锁按钮：控制层露出时用来上锁；锁定后常驻用来开锁。 */
const lockVisible = computed(() => locked.value || uiShown.value)

const progress = computed(() => {
  if (dragging.value) return dragRatio.value
  return duration.value > 0 ? Math.min(1, curTime.value / duration.value) : 0
})

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

/**
 * 选集按钮上的短标签。
 *
 * CMS 给的集名五花八门：`第01集` / `HD国语版` / `正片`。命名里带数字就用数字
 * （参考图里的长视频 App 一律是编号方块），不带数字就退回「第几集」。
 */
function epLabel(name: string, index: number): string {
  // 本地文件名里的数字多半是日期（2024-03-01 之类），当集号没有意义。
  if (localMode) return String(index + 1)
  const m = String(name || '').match(/(\d{1,4})/)
  return m ? String(Number(m[1])) : String(index + 1)
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

function readFavs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toast(text: string): void {
  if (player) player.notice.show = text
}

/* ---------- 控制层交互 ---------- */

function togglePlay(): void {
  if (!player) return
  if (player.video.paused) void player.play()
  else player.pause()
}

function setRate(v: number): void {
  rate.value = v
  if (player) player.playbackRate = v
  localStorage.setItem(SPEED_KEY, String(v))
  rateOpen.value = false
}

/**
 * 锁屏开关。
 *
 * 状态存在两个地方：本页的 `locked` 管界面（控制层收起、只留开锁按钮），
 * artplayer 的 `isLock` 管手势（它检查这个标记跳过双击播放、长按快进、拖动）。
 * 解锁后把控制层重新叫出来，不然画面光秃秃的要点一下才看到按钮。
 */
function toggleLock(): void {
  locked.value = !locked.value
  if (!player) return
  setPlayerLock(locked.value)
  if (locked.value) {
    player.controls.show = false
  } else {
    player.controls.show = true
  }
}

/**
 * artplayer 的 `isLock` 决定它自带手势拦不拦截（单击/双击/长按快进/拖进度都查它）。
 * 类型声明里是 readonly，运行期就是普通属性；不写它锁屏就只是「把按钮藏起来」，
 * 双击照样会播/停。
 */
function setPlayerLock(on: boolean): void {
  if (!player) return
  ;(player as unknown as { isLock: boolean }).isLock = on
}

function toggleDanmaku(): void {
  danmakuOn.value = !danmakuOn.value
}

/** 弹幕设置 / 发弹幕：没有弹幕服务器，点了给一句说明而不是装死。 */
function danmakuStub(): void {
  toast('弹幕功能暂未开放')
}

/**
 * 收藏键：CMS 片子按「源 + 影片 id」，本地片子按文件名
 * （blob URL 每次都变，不能当身份用）。
 */
function favKeyOf(): string {
  return localMode ? `${LOCAL_ID}:${episode.value?.name || ''}` : `${sourceId}:${vodId}`
}

function toggleFav(): void {
  const key = favKeyOf()
  const list = readFavs()
  const at = list.indexOf(key)
  if (at >= 0) list.splice(at, 1)
  else list.push(key)
  localStorage.setItem(FAV_KEY, JSON.stringify(list))
  faved.value = at < 0
  toast(at < 0 ? '已收藏' : '已取消收藏')
}

async function share(): Promise<void> {
  const text = `${detail.value?.name || ''}${episode.value?.name ? ' ' + episode.value.name : ''}`.trim()
  const url = episode.value?.url || location.href
  try {
    if (navigator.share) {
      await navigator.share({ title: detail.value?.name || '微读影视', text, url })
      return
    }
    await navigator.clipboard.writeText(`${text}\n${url}`)
    toast('已复制分享文案')
  } catch {
    /* 用户取消分享面板 */
  }
}

/* ---------- 进度拖动 ---------- */

function ratioFromEvent(e: PointerEvent): number {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

function onSeekDown(e: PointerEvent): void {
  if (!player) return
  dragging.value = true
  dragRatio.value = ratioFromEvent(e)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onSeekMove(e: PointerEvent): void {
  if (!dragging.value) return
  dragRatio.value = ratioFromEvent(e)
}

function onSeekUp(e: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  if (player && duration.value > 0) player.currentTime = dragRatio.value * duration.value
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    /* 已经松开 */
  }
}

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

  // 本地模式下大标题就是当前文件名（CMS 模式下是片名，别动）。
  if (localMode && detail.value) detail.value.name = ep.name
  // 收藏态跟着「当前在放的那个」走：CMS 下首次进入也要读一次。
  faved.value = readFavs().includes(favKeyOf())

  const history = localMode ? undefined : store.historyOf(sourceId, vodId)
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
    theme: '#3e6bf0',
    // 自带能力：不自己写触摸逻辑，见文件头注释。
    gesture: true,
    fastForward: true,
    lock: true,
    // 控制栏整层藏掉由本页自绘；自带的设置/倍速/画中画按钮也就不用再摘。
    setting: false,
    playbackRate: false,
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
  // 换集会重建 player，锁的是「这个播放器」，新实例要重新挂上。
  setPlayerLock(locked.value)
  player.on('ready', () => {
    started = true
    clearTimeout(startTimer)
    // 慢源有时先超时后出画面，错误卡片必须跟着撤掉。
    fatal.value = ''
    if (resumeAt > 3 && player) player.currentTime = resumeAt
  })
  player.on('control', (show: boolean) => {
    ctrlVisible.value = show
    if (!show) rateOpen.value = false
  })
  // 播放状态跟 video 元素本身：artplayer 的 `play`/`pause` 事件只在它自己的
  // API 方法里发，外部直接 `video.pause()`（快捷键、系统打断）不会发，图标会停错。
  player.on('video:play', () => {
    playing.value = true
  })
  player.on('video:pause', () => {
    playing.value = false
  })
  // artplayer 在 play()/pause() 里会用 notice 闪一下「播放 / 暂停」文字，
  // 跟自绘控制层的图标重复。这两个事件总在写入 notice 之后发出，这里立刻抹掉；
  // 拖动进度的时间提示（notice 的另一个用途）不受影响。
  player.on('play', () => {
    if (player) player.notice.show = ''
  })
  player.on('pause', () => {
    if (player) player.notice.show = ''
  })
  player.on('video:timeupdate', onTimeUpdate)
  player.on('video:durationchange', syncClock)
  player.on('video:loadedmetadata', syncClock)
  player.on('video:ratechange', onRateChange)
  player.on('video:ended', onEnded)
  player.on('video:error', () => {
    // hls.js 会自己上报可恢复/不可恢复的错误；这里只兜底直链 mp4。
    // 本地文件最常见的失败是容器/编码不被 WebView 支持（mkv、avi 之类），
    // 说「加载失败请重试」会让人反复重试一个永远放不了的文件。
    if (!isM3u8(ep.url)) {
      fatal.value = localMode ? '这个文件播不了，可能是系统不支持它的封装格式' : '视频加载失败，请重试'
    }
  })
  syncClock()
  if (player.video) playing.value = !player.video.paused

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

/** 秒 → 00:08 / 1:02:03 */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`
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

function handleToggleRate(): void {
  rateOpen.value = !rateOpen.value
}

function handleNext(): void {
  next()
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
        </div>

        <!-- 竖屏控制条：暂停 · 当前时间 · 进度 · 总长 · 全屏（参考图的单行版式） -->
        <div
          v-if="!isFull"
          class="tv-play__bar tv-play__bar--mini"
          :class="{ 'tv-play__layer--off': !uiShown }"
        >
          <button class="tv-play__ico" :aria-label="playing ? '暂停' : '播放'" @click.stop="togglePlay">
            <MorphIcon :name="playing ? 'pause' : 'play'" :size="22" :width="2.1" />
          </button>
          <span class="tv-play__time">{{ clock(curTime) }}</span>
          <div
            class="tv-play__track"
            @pointerdown.stop="onSeekDown"
            @pointermove.stop="onSeekMove"
            @pointerup.stop="onSeekUp"
            @pointercancel.stop="onSeekUp"
          >
            <div class="tv-play__track-run">
              <div class="tv-play__track-played" :style="{ width: progress * 100 + '%' }" />
              <div class="tv-play__thumb" :style="{ left: progress * 100 + '%' }" />
            </div>
          </div>
          <span class="tv-play__time">{{ clock(duration) }}</span>
          <button class="tv-play__txt" @click.stop="handleToggleRate">倍速</button>
          <button class="tv-play__ico" aria-label="全屏" @click.stop="toggleFullscreen">
            <Icon name="expand" :size="20" />
          </button>
        </div>

        <!--
          全屏控制层：进度行（两端贴时间）+ 控制行。
          参考图控制行是「暂停 · 下一集 · 弹幕开关 · 弹幕设置 · 发弹幕框 ·
          只看TA · 倍速 · 1080P SDR · 选集」——「只看TA」是会员功能、「1080P SDR」
          是清晰度菜单（采集源一条线路一个地址，切不了清晰度），都不做。
          倍速 / 投屏 / 选集是真能用的，留在右端。
          注意这行必须紧跟着 v-if 的竖屏控制条（v-else 只认紧邻的上一个兄弟），
          中间插任何元素都会让整条全屏控制行失效。
        -->
        <div v-else class="tv-play__bar tv-play__bar--full" :class="{ 'tv-play__layer--off': !uiShown }">
          <div class="tv-play__progress-row">
            <span class="tv-play__time">{{ clock(curTime) }}</span>
            <div
              class="tv-play__track"
              @pointerdown.stop="onSeekDown"
              @pointermove.stop="onSeekMove"
              @pointerup.stop="onSeekUp"
              @pointercancel.stop="onSeekUp"
            >
              <div class="tv-play__track-run">
                <div class="tv-play__track-played" :style="{ width: progress * 100 + '%' }" />
                <div class="tv-play__thumb" :style="{ left: progress * 100 + '%' }" />
              </div>
            </div>
            <span class="tv-play__time">{{ clock(duration) }}</span>
          </div>

          <div class="tv-play__ctrl-row">
            <button class="tv-play__ico" :aria-label="playing ? '暂停' : '播放'" @click.stop="togglePlay">
              <MorphIcon :name="playing ? 'pause' : 'play'" :size="22" :width="2.1" />
            </button>
            <button v-if="hasNext" class="tv-play__ico" aria-label="下一集" @click.stop="handleNext">
              <Icon name="skip-forward" :size="21" />
            </button>

            <button
              class="tv-play__dm-btn"
              :class="{ 'tv-play__dm-btn--on': danmakuOn }"
              aria-label="弹幕开关"
              @click.stop="toggleDanmaku"
            >
              弹
              <span v-if="danmakuOn" class="tv-play__dm-badge">
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  stroke-width="3.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4.8 12.6l4.6 4.6 9.8-10.4" />
                </svg>
              </span>
            </button>
            <button class="tv-play__dm-btn" aria-label="弹幕设置" @click.stop="danmakuStub">
              弹
              <svg
                class="tv-play__dm-gear"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle cx="12" cy="12" r="3.2" />
                <path d="M12 3.4v2.2M12 18.4v2.2M3.4 12h2.2M18.4 12h2.2" />
              </svg>
            </button>
            <button class="tv-play__dm-input" @click.stop="danmakuStub">点我发弹幕~</button>

            <span class="tv-play__row-gap" />

            <button class="tv-play__txt" @click.stop="handleToggleRate">倍速</button>
            <button
              v-if="showCast && !localMode"
              class="tv-play__ico tv-play__ico--sm"
              aria-label="投屏"
              @click.stop="handleOpenCast"
            >
              <svg
                width="19"
                height="19"
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
            <button class="tv-play__txt" @click.stop="openDrawer">选集</button>
          </div>
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

        <!-- 倍速浮层：竖屏控制条 / 全屏控制行共用 -->
        <div v-if="rateOpen" class="tv-play__rates" @click.stop>
          <button
            v-for="r in [0.5, 0.75, 1, 1.25, 1.5, 2]"
            :key="r"
            class="tv-play__rate"
            :class="{ 'tv-play__rate--on': rate === r }"
            @click.stop="setRate(r)"
          >
            {{ r }}x
          </button>
        </div>

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

        <div class="tv-play__actions">
          <!-- 本地片没有可分享的链接，分享按钮只在点播模式出现。 -->
          <button v-if="!localMode" class="tv-play__action" @click="share">
            <Icon name="share" :size="24" />
            <span class="tv-play__action-label">分享</span>
          </button>
          <button class="tv-play__action" :class="{ 'tv-play__action--on': faved }" @click="toggleFav">
            <Icon name="heart" :size="24" />
            <span class="tv-play__action-label">{{ faved ? '已收藏' : '收藏' }}</span>
          </button>
        </div>

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
            <button class="tv-play__eps-all" @click="openDrawer">
              {{ orderedEps.length }} 集全
              <Icon name="chevron-right" :size="12" :width="2" />
            </button>
          </div>

          <div class="tv-play__eps-strip">
            <button
              v-for="row in orderedEps"
              :key="row.ep.url"
              class="tv-play__ep-btn"
              :class="{ 'tv-play__ep-btn--active': row.index === epIndex }"
              :aria-label="row.ep.name"
              :aria-current="row.index === epIndex ? 'true' : undefined"
              @click="handlePickEpisode(row)"
            >
              <!-- 正在播的那一格：参考图是三根橙红竖条（均衡器）压在浅粉底上 -->
              <span v-if="row.index === epIndex" class="tv-play__ep-eq" aria-hidden="true">
                <i /><i /><i />
              </span>
              <template v-else>{{ epLabel(row.ep.name, row.index) }}</template>
            </button>
          </div>
        </section>

        <section v-if="detail.desc" class="tv-play__desc" :class="{ 'tv-play__desc--open': descOpen }">
          <h2 class="tv-play__desc-title">简介</h2>
          <p class="tv-play__desc-text">{{ detail.desc }}</p>
          <button v-if="canExpand" class="tv-play__desc-toggle" @click="toggleDesc">
            {{ descOpen ? '收起' : '展开' }}
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
   * z 必须高于 artplayer 的 `.art-video`（10），否则弹幕飘在画面下面；
   * 又低于控制层（30）。artplayer 自己的 `.art-danmuku` 也是 30 这一档。
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
  /* 必须压过 artplayer 的 `.art-video`（z-index:10）：不写 z 的浮层会被画面
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
  z-index: 32;
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
  background: rgba(255, 255, 255, 0.22);
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
 * artplayer 自带的控制栏整层藏掉：控件排版由上面的自绘层负责，
 * 但手势（单击显隐 / 双击播放 / 拖动进度 / 长按快进）和锁屏层还是它的。
 */
.tv-play__screen :deep(.art-bottom) {
  display: none !important;
}

/*
 * artplayer 自带的左侧锁层整层不用：它的位置贴着屏幕边缘，横屏时会被挖孔
 * 摄像头挡住，而且跟自绘控制层的显隐节奏不同步。锁屏按钮由本页自绘
 * （`.tv-play__lock`），位置在安全区再往里 24px。
 */
.tv-play__screen :deep(.art-layer-lock) {
  display: none !important;
}

/* 竖版海报放进 16:9 的框里会被左右留黑，按 cover 裁更像正常封面。 */
.tv-play__screen :deep(.art-poster) {
  object-fit: cover;
}

/* 播放失败时 artplayer 的加载圈还转着，会和错误卡片叠在一起。 */
.tv-play__screen--fatal :deep(.art-loading) {
  display: none;
}

/*
 * 锁定时把画面中央的大播放键（artplayer 的 `.art-state`）也藏掉：它自带点击
 * 播放，artplayer 没给它加 isLock 检查，留着就是锁屏上的一个后门。
 */
.tv-play__screen--locked :deep(.art-mask) {
  display: none;
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
  /* 高于 `.art-video`（10）：出错/加载文字要压在画面之上 */
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
  /* 高于 `.art-video`（10）：错误卡片要盖住画面，而不是被画面盖住 */
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
  /* 高于 `.art-video`（10）：连播卡片要盖住画面（参考图的浮层都在画面之上） */
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

/* 操作行：参考图是「图标在上、文字在下」的等距一排。没有后端的评论/下载不画。 */
.tv-play__actions {
  display: flex;
  gap: 28px;
  margin-top: 16px;
}
.tv-play__action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 44px;
  color: var(--text);
}
.tv-play__action--on {
  color: var(--accent);
}
.tv-play__action-label {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

/* ---------- 选集 ---------- */

.tv-play__eps {
  padding-top: 18px;
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
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.tv-play__eps-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}
/* 「18 集全 ›」在参考图里是右侧的浅灰小字，点开完整选集 */
.tv-play__eps-all {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 32px;
  color: var(--text-secondary);
  font-size: calc(13px * var(--app-font-scale));
}

.tv-play__eps-strip {
  display: flex;
  gap: 9px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}

.tv-play__eps-strip::-webkit-scrollbar {
  display: none;
}

/*
 * 编号方块：参考图里芒果是用方块网格选集的（约 46×44、8 圆角、浅灰底），
 * 长名字（HD国语版）塞不进一行，就只显编号。
 */
.tv-play__ep-btn {
  flex: 0 0 auto;
  width: 46px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-secondary);
  border: 0;
  color: var(--text);
  font-size: calc(17px * var(--app-font-scale));
  font-variant-numeric: tabular-nums;
}

/*
 * 正在播的那一格：参考图是浅粉底 + 橙红均衡器三竖条。
 * 颜色跟着参考图走（不是品牌蓝）——这是「播放中」的状态标记。
 */
.tv-play__ep-btn--active {
  background: rgba(255, 92, 61, 0.12);
}

.tv-play__ep-eq {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 16px;
}

.tv-play__ep-eq i {
  width: 3.5px;
  border-radius: 1px;
  background: #ff5c3d;
}
.tv-play__ep-eq i:nth-child(1) {
  height: 11px;
}
.tv-play__ep-eq i:nth-child(2) {
  height: 16px;
}
.tv-play__ep-eq i:nth-child(3) {
  height: 8px;
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
