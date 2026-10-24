<script setup lang="ts">
/**
 * 全屏听书界面。
 *
 * 参考图里是「智能朗读」页：顶部收起、当前句大字预览、一排操作、
 * 进度条 + 传输控制、底部音色/边听边读卡片。这里只保留这台设备
 * 真能做到的事：进度条按「句」跳（安卓语音引擎没有 seek，做时间轴是假的）。
 */
import { computed, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import type { ListenStatus } from '@/audio/player'
import { voiceLabel, type TtsVoice } from '@/audio/tts'

const props = defineProps<{
  status: ListenStatus
  rate: number
  /** 正在朗读的句子。 */
  sentence: string
  index: number
  total: number
  chapterTitle: string
  bookTitle: string
  cover?: string | null
  follow: boolean
  autoNext: boolean
  voice: string
  /** 剩余时长估算（按当前语速）。 */
  remainText: string
  /** 定时剩余秒数，0 表示没开。 */
  timerLeft: number
  /** Why it cannot play, when status is 'unavailable'. */
  reason?: string
  loadVoices: () => Promise<TtsVoice[]>
}>()

const emit = defineEmits<{
  toggle: []
  prev: []
  next: []
  seek: [number]
  rate: [number]
  voice: [string]
  follow: []
  autoNext: []
  timer: [number]
  catalog: []
  /** 收藏当前句为「金句」。 */
  favorite: []
  collapse: []
  close: []
}>()

type Sheet = 'rate' | 'voice' | 'timer' | 'more' | null

const sheet = ref<Sheet>(null)
const voices = ref<TtsVoice[]>([])
const voicesLoading = ref(false)
const voicesError = ref('')

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const TIMERS = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '60 分钟' },
]

const playing = computed(() => props.status === 'playing')
const unavailable = computed(() => props.status === 'unavailable')
const ended = computed(() => props.status === 'ended')
const rateText = computed(() => `${Number(props.rate.toFixed(2))}x`)
const percent = computed(() => (props.total > 1 ? props.index / (props.total - 1) : 0))

const offlineVoices = computed(() => voices.value.filter(v => v.local))
const emotionalVoices = computed(() => voices.value.filter(v => v.provider === 'edge'))
const onlineVoices = computed(() =>
  voices.value.filter(v => !v.local && v.provider !== 'edge')
)

const selectedVoiceLabel = computed(() => {
  if (!props.voice) return '跟随系统默认'
  return voiceLabel(props.voice)
})

const timerText = computed(() => {
  if (!props.timerLeft) return '定时'
  const m = Math.floor(props.timerLeft / 60)
  const s = props.timerLeft % 60
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s} 秒`
})

function openSheet(name: Exclude<Sheet, null>): void {
  sheet.value = name
  if (name === 'voice') void loadVoiceList()
}

async function loadVoiceList(): Promise<void> {
  if (voicesLoading.value) return
  voicesLoading.value = true
  voicesError.value = ''
  try {
    voices.value = await props.loadVoices()
    if (!voices.value.length) {
      voicesError.value = '没有可用音色，可安装系统语音包或联网后重试。'
    }
  } catch {
    voicesError.value = '读取音色失败，请重试。'
  } finally {
    voicesLoading.value = false
  }
}

function pickRate(v: number): void {
  emit('rate', v)
  sheet.value = null
}

function pickVoice(v: string): void {
  emit('voice', v)
  sheet.value = null
}

function pickTimer(minutes: number): void {
  emit('timer', minutes)
  sheet.value = null
}

function pickTimerOff(): void {
  emit('timer', 0)
  sheet.value = null
}

function onSeek(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('seek', value)
}

function onCoverError(e: Event): void {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

// 重新打开同一张面板时也要刷新音色（用户可能刚装了语音包）。
watch(sheet, (v) => {
  if (v === 'voice') void loadVoiceList()
})
</script>

<template>
  <div class="lv" @click.stop>
    <div class="lv__glow" aria-hidden="true" />

    <header class="lv__head">
      <button class="lv__icon-btn" aria-label="收起" @click="emit('collapse')">
        <Icon name="chevron-down" :size="24" :width="2" />
      </button>
      <span class="lv__title">听书</span>
      <button class="lv__icon-btn" aria-label="更多" @click="openSheet('more')">
        <Icon name="more" :size="22" />
      </button>
    </header>

    <section class="lv__now">
      <div class="lv__cover">
        <img v-if="cover" :src="cover" alt="" @error="onCoverError" />
        <span v-else>听</span>
      </div>
      <div class="lv__meta">
        <span class="lv__chapter">{{ chapterTitle || '当前章节' }}</span>
        <span class="lv__book">{{ bookTitle }}</span>
      </div>
    </section>

    <article class="lv__text">
      <template v-if="unavailable">
        <p class="lv__warn">{{ reason || '这台设备没有可用的朗读引擎' }}</p>
      </template>
      <template v-else-if="ended">
        <p class="lv__warn">本章已经播完</p>
      </template>
      <template v-else>
        <p class="lv__sentence">{{ sentence || '…' }}</p>
        <p class="lv__source">{{ chapterTitle }}</p>
      </template>
    </article>

    <nav class="lv__actions">
      <button class="lv__action" @click="openSheet('rate')">
        <span class="lv__action-icon"><Icon name="speed" :size="22" /></span>
        <span class="lv__action-text">{{ rateText }}</span>
      </button>
      <button class="lv__action" @click="emit('favorite')">
        <span class="lv__action-icon"><Icon name="bookmark" :size="22" /></span>
        <span class="lv__action-text">金句</span>
      </button>
      <button class="lv__action" @click="openSheet('voice')">
        <span class="lv__action-icon"><Icon name="headphones" :size="22" /></span>
        <span class="lv__action-text">音色</span>
      </button>
      <button class="lv__action" @click="openSheet('timer')">
        <span class="lv__action-icon" :class="{ 'lv__action-icon--on': timerLeft > 0 }">
          <Icon name="timer" :size="22" />
        </span>
        <span class="lv__action-text" :class="{ 'lv__action-text--on': timerLeft > 0 }">{{ timerText }}</span>
      </button>
      <button class="lv__action" @click="openSheet('more')">
        <span class="lv__action-icon"><Icon name="more" :size="22" /></span>
        <span class="lv__action-text">更多</span>
      </button>
    </nav>

    <section class="lv__progress">
      <div class="lv__progress-label">
        <span>{{ total ? `第 ${index + 1} / ${total} 句` : '暂无内容' }}</span>
        <span>{{ remainText }}</span>
      </div>
      <input
        class="lv__range"
        type="range"
        min="0"
        :max="Math.max(0, total - 1)"
        step="1"
        :value="index"
        :disabled="unavailable || total < 2"
        :style="{ '--p': `${percent * 100}%` }"
        aria-label="朗读进度"
        @change="onSeek"
      />
    </section>

    <section class="lv__transport">
      <button class="lv__side" @click="emit('catalog')">
        <Icon name="catalog" :size="20" />
        <span>目录</span>
      </button>
      <button class="lv__step" aria-label="上一句" :disabled="unavailable" @click="emit('prev')">
        <Icon name="skip-back" :size="26" :width="1.8" />
      </button>
      <button
        class="lv__main"
        :aria-label="playing ? '暂停' : '播放'"
        :disabled="unavailable"
        @click="emit('toggle')"
      >
        <Icon :name="playing ? 'pause' : 'play'" :size="30" :width="1.9" />
      </button>
      <button class="lv__step" aria-label="下一句" :disabled="unavailable" @click="emit('next')">
        <Icon name="skip-forward" :size="26" :width="1.8" />
      </button>
      <button class="lv__side" :class="{ 'lv__side--on': timerLeft > 0 }" @click="openSheet('timer')">
        <Icon name="timer" :size="20" />
        <span>{{ timerLeft ? timerText : '定时' }}</span>
      </button>
    </section>

    <section class="lv__cards">
      <button class="lv__card" @click="openSheet('voice')">
        <span class="lv__card-title">音色设置</span>
        <span class="lv__card-sub">{{ selectedVoiceLabel }}</span>
        <Icon class="lv__card-arrow" name="chevron-right" :size="18" />
      </button>
      <button class="lv__card" @click="emit('collapse')">
        <span class="lv__card-title">边听边读</span>
        <span class="lv__card-sub">收起后继续播放，回到正文</span>
        <Icon class="lv__card-arrow" name="chevron-right" :size="18" />
      </button>
    </section>

    <!-- 面板 -->
    <div v-if="sheet" class="lv-sheet-mask" @click.self="sheet = null">
      <div class="lv-sheet">
        <div class="lv-sheet__head">
          <span class="lv-sheet__title">
            {{ sheet === 'rate' ? '朗读语速' : sheet === 'voice' ? '声音设置' : sheet === 'timer' ? '定时关闭' : '更多设置' }}
          </span>
          <button class="lv-sheet__close" aria-label="关闭" @click="sheet = null">
            <Icon name="close" :size="18" :width="2" />
          </button>
        </div>

        <template v-if="sheet === 'rate'">
          <div class="lv-sheet__grid">
            <button
              v-for="r in RATES"
              :key="r"
              class="lv-option"
              :class="{ 'lv-option--on': Math.abs(rate - r) < 0.001 }"
              @click="pickRate(r)"
            >
              {{ Number(r.toFixed(2)) }}x
            </button>
          </div>
          <p class="lv-sheet__hint">1.0x 为默认语速，在线与离线音色都按这个语速朗读。</p>
        </template>

        <template v-if="sheet === 'voice'">
          <p class="lv-sheet__hint">
            在线音色联网合成，语气更自然、能听出情绪；离线音色不耗流量。
          </p>
          <div v-if="voicesLoading" class="lv-sheet__status">正在读取音色…</div>
          <p v-else-if="voicesError" class="lv-sheet__error">{{ voicesError }}</p>
          <div v-else class="lv-sheet__scroll">
            <button
              class="lv-voice"
              :class="{ 'lv-voice--on': !voice }"
              @click="pickVoice('')"
            >
              <span class="lv-voice__name">跟随系统默认</span>
              <span class="lv-voice__meta">由系统自动选择中文音色</span>
              <Icon v-if="!voice" name="check" :size="18" class="lv-voice__check" />
            </button>

            <template v-if="emotionalVoices.length">
              <p class="lv-sheet__group">在线情感音色</p>
              <button
                v-for="v in emotionalVoices"
                :key="v.name"
                class="lv-voice"
                :class="{ 'lv-voice--on': voice === v.name }"
                @click="pickVoice(v.name)"
              >
                <span class="lv-voice__name">{{ v.label || v.name }}</span>
                <span class="lv-voice__meta">{{ v.desc }} · 联网</span>
                <Icon v-if="voice === v.name" name="check" :size="18" class="lv-voice__check" />
              </button>
            </template>

            <template v-if="offlineVoices.length">
              <p class="lv-sheet__group">离线音色</p>
              <button
                v-for="v in offlineVoices"
                :key="v.name"
                class="lv-voice"
                :class="{ 'lv-voice--on': voice === v.name }"
                @click="pickVoice(v.name)"
              >
                <span class="lv-voice__name">{{ v.name }}</span>
                <span class="lv-voice__meta">{{ v.lang }} · 离线</span>
                <Icon v-if="voice === v.name" name="check" :size="18" class="lv-voice__check" />
              </button>
            </template>

            <template v-if="onlineVoices.length">
              <p class="lv-sheet__group">在线音色</p>
              <button
                v-for="v in onlineVoices"
                :key="v.name"
                class="lv-voice"
                :class="{ 'lv-voice--on': voice === v.name }"
                @click="pickVoice(v.name)"
              >
                <span class="lv-voice__name">{{ v.name }}</span>
                <span class="lv-voice__meta">{{ v.lang }} · 在线</span>
                <Icon v-if="voice === v.name" name="check" :size="18" class="lv-voice__check" />
              </button>
            </template>
          </div>
        </template>

        <template v-if="sheet === 'timer'">
          <div class="lv-sheet__list">
            <button
              v-for="t in TIMERS"
              :key="t.minutes"
              class="lv-option lv-option--row"
              @click="pickTimer(t.minutes)"
            >
              {{ t.label }}
            </button>
            <button class="lv-option lv-option--row" @click="pickTimerOff">关闭定时</button>
          </div>
          <p class="lv-sheet__hint">
            {{ timerLeft ? `还剩 ${timerText}，到时自动暂停。` : '到点后会自动暂停朗读，不退出听书。' }}
          </p>
        </template>

        <template v-if="sheet === 'more'">
          <div class="lv-sheet__list">
            <button class="lv-row" role="switch" :aria-checked="follow" @click="emit('follow')">
              <span class="lv-row__text">
                <span class="lv-row__title">跟随高亮</span>
                <span class="lv-row__sub">朗读时正文自动滚到当前句</span>
              </span>
              <span class="toggle" :class="{ on: follow }"><span class="toggle__dot" /></span>
            </button>
            <button class="lv-row" role="switch" :aria-checked="autoNext" @click="emit('autoNext')">
              <span class="lv-row__text">
                <span class="lv-row__title">章末自动续播</span>
                <span class="lv-row__sub">读完自动进入下一章</span>
              </span>
              <span class="toggle" :class="{ on: autoNext }"><span class="toggle__dot" /></span>
            </button>
          </div>
          <p class="lv-sheet__hint">
            锁屏或切到后台时，部分系统会暂停朗读；回到应用后会自动继续。本机不启用后台媒体服务。
          </p>
          <button class="lv-sheet__danger" @click="emit('close')">退出听书</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 这一页有自己的一套深色配色，不跟随阅读器主题：参考图里朗读页就是深色的。 */
.lv {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: flex;
  flex-direction: column;
  padding: calc(8px + var(--safe-top)) 22px calc(16px + var(--safe-bottom));
  background: linear-gradient(180deg, #454e3a 0%, #353c2d 52%, #272c21 100%);
  color: #f3f4ea;
  overflow: hidden;
  animation: lvIn 220ms ease-out;
}

@keyframes lvIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.lv__glow {
  position: absolute;
  top: -20%;
  left: 50%;
  width: 120%;
  height: 60%;
  transform: translateX(-50%);
  background: radial-gradient(ellipse at center, rgba(233, 228, 203, 0.14), transparent 70%);
  pointer-events: none;
}

.lv__head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.lv__title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.86;
}

.lv__icon-btn {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  opacity: 0.85;
}

.lv__now {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 0 4px;
  flex-shrink: 0;
}

.lv__cover {
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: rgba(255, 255, 255, 0.75);
}

.lv__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.lv__meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lv__chapter {
  font-size: calc(14px * var(--app-font-scale));
  font-weight: 600;
  color: #f4f5ec;
}

.lv__book {
  font-size: calc(12px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv__text {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 16px 6px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 10%, #000 78%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0, #000 10%, #000 78%, transparent 100%);
}

.lv__sentence {
  display: -webkit-box;
  -webkit-line-clamp: 7;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: calc(22px * var(--app-font-scale));
  line-height: 1.7;
  letter-spacing: 0.01em;
  color: rgba(243, 244, 234, 0.92);
}

.lv__source {
  margin-top: 14px;
  font-size: calc(12px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.42);
}

.lv__warn {
  font-size: calc(16px * var(--app-font-scale));
  line-height: 1.6;
  color: rgba(243, 244, 234, 0.7);
}

.lv__actions {
  display: flex;
  justify-content: space-between;
  padding: 4px 2px 10px;
  flex-shrink: 0;
}

.lv__action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 52px;
  color: rgba(243, 244, 234, 0.86);
}

.lv__action-icon {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
}

.lv__action-icon--on {
  background: rgba(233, 228, 203, 0.25);
  color: #fdf8e6;
}

.lv__action-text {
  font-size: calc(11px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.62);
  font-variant-numeric: tabular-nums;
}

.lv__action-text--on {
  color: #fdf8e6;
}

.lv__progress {
  flex-shrink: 0;
  padding: 4px 2px 0;
}

.lv__progress-label {
  display: flex;
  justify-content: space-between;
  font-size: calc(11px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.55);
  font-variant-numeric: tabular-nums;
  margin-bottom: 6px;
}

.lv__range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 24px;
  background: transparent;
}

.lv__range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(244, 240, 220, 0.9) var(--p), rgba(255, 255, 255, 0.18) var(--p));
}

.lv__range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5.5px;
  border-radius: 50%;
  background: #f7f4e6;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.lv__range::-moz-range-track {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
}

.lv__range::-moz-range-progress {
  height: 3px;
  background: rgba(244, 240, 220, 0.9);
}

.lv__range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: #f7f4e6;
}

.lv__range:disabled {
  opacity: 0.4;
}

.lv__transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 12px;
  flex-shrink: 0;
}

.lv__side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 46px;
  font-size: calc(10px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.6);
  font-variant-numeric: tabular-nums;
}

.lv__side--on {
  color: #fdf8e6;
}

.lv__step {
  width: 46px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #f3f4ea;
}

.lv__step:disabled,
.lv__main:disabled {
  opacity: 0.35;
}

.lv__main {
  width: 62px;
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(243, 244, 234, 0.92);
  color: #333a2b;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
}

.lv__cards {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.lv__card {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 12px 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  text-align: left;
  color: #f3f4ea;
}

.lv__card-title {
  font-size: calc(13px * var(--app-font-scale));
  font-weight: 600;
}

.lv__card-sub {
  font-size: calc(10px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.55);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 16px;
}

.lv__card-arrow {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: rgba(243, 244, 234, 0.35);
}

/* ---------- 底部面板（浅色，和参考图的设置面板一致） ---------- */
.lv-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
}

.lv-sheet {
  width: 100%;
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 16px calc(16px + var(--safe-bottom));
  border-radius: 16px 16px 0 0;
  background: #f6f5f1;
  color: #1f1f1d;
  animation: lvSheetUp 200ms ease-out;
}

@keyframes lvSheetUp {
  from { transform: translateY(24px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

.lv-sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.lv-sheet__title {
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 600;
}

.lv-sheet__close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6d6d68;
}

.lv-sheet__hint {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: #7a7a74;
}

.lv-sheet__error {
  font-size: calc(12px * var(--app-font-scale));
  color: #b4463f;
}

.lv-sheet__status {
  padding: 20px 0;
  text-align: center;
  font-size: calc(13px * var(--app-font-scale));
  color: #7a7a74;
}

.lv-sheet__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.lv-option {
  height: 44px;
  border-radius: 10px;
  background: #ebe9e2;
  font-size: calc(14px * var(--app-font-scale));
  color: #33332f;
}

.lv-option--on {
  background: #f6e2c4;
  color: #7a4b1c;
  box-shadow: inset 0 0 0 1px #e2c294;
  font-weight: 600;
}

.lv-option--row {
  width: 100%;
  text-align: left;
  padding: 0 14px;
}

.lv-sheet__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lv-sheet__scroll {
  max-height: 46vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lv-sheet__group {
  margin: 8px 2px 0;
  font-size: calc(11px * var(--app-font-scale));
  color: #8a8a82;
}

.lv-voice {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 40px 12px 14px;
  border-radius: 10px;
  background: #ebe9e2;
  text-align: left;
}

.lv-voice--on {
  background: #f6e2c4;
  box-shadow: inset 0 0 0 1px #e2c294;
}

.lv-voice__name {
  font-size: calc(14px * var(--app-font-scale));
  color: #262622;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv-voice__meta {
  font-size: calc(11px * var(--app-font-scale));
  color: #7a7a74;
}

.lv-voice__check {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: #a2621e;
}

.lv-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 54px;
  padding: 8px 14px;
  border-radius: 10px;
  background: #ebe9e2;
  text-align: left;
}

.lv-row__text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.lv-row__title {
  font-size: calc(14px * var(--app-font-scale));
  color: #262622;
}

.lv-row__sub {
  font-size: calc(11px * var(--app-font-scale));
  color: #7a7a74;
}

.lv-sheet__danger {
  height: 48px;
  border-radius: 10px;
  background: #fff;
  font-size: calc(14px * var(--app-font-scale));
  color: #b4463f;
}

/* 开关复刻书源页的样式，面板是浅色所以这里单独给色值。 */
.toggle {
  position: relative;
  width: 46px;
  height: 22px;
  border-radius: 11px;
  background: rgba(120, 120, 128, 0.22);
  transition: background-color 200ms ease-out;
  flex-shrink: 0;
}

.toggle.on {
  background: #c58a3d;
}

.toggle__dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  transition: transform 200ms ease-out;
}

.toggle.on .toggle__dot {
  transform: translateX(24px);
}
</style>
