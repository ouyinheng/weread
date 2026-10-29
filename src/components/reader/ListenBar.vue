<script setup lang="ts">
/**
 * 收起后的迷你听书控件。
 *
 * 只保留左侧封面图标、暂停/继续、关闭三个元素，整体可以拖动。
 * 点图标回到全屏听书页；拖动时只移动位置，不触发返回。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import MorphIcon from '@/components/MorphIcon.vue'
import type { ListenStatus } from '@/audio/player'

const props = defineProps<{
  status: ListenStatus
  cover?: string | null
  timerLeft: number
}>()

const emit = defineEmits<{
  toggle: []
  expand: []
  close: []
}>()

const POS_KEY = 'weread.listenMiniPos'
const EDGE = 8
const TOP_MIN = 56

const root = ref<HTMLElement>()
const x = ref(16)
const y = ref(320)
const ready = ref(false)
const size = { w: 0, h: 0 }

let dragId: number | null = null
let startX = 0
let startY = 0
let baseX = 0
let baseY = 0
let moved = false
let suppressClick = false

const playing = computed(() => props.status === 'playing')
const buffering = computed(() => props.status === 'buffering')
const unavailable = computed(() => props.status === 'unavailable')

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max))
}

function savePos(): void {
  const maxX = window.innerWidth - size.w
  const maxY = window.innerHeight - size.h
  try {
    localStorage.setItem(
      POS_KEY,
      JSON.stringify({
        xr: maxX > 0 ? x.value / maxX : 0,
        yr: maxY > 0 ? y.value / maxY : 0,
      }),
    )
  } catch {
    // 位置记忆失败不影响播放。
  }
}

function readPos(): { xr: number; yr: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { xr?: number; yr?: number }
    if (typeof p.xr !== 'number' || typeof p.yr !== 'number') return null
    return { xr: p.xr, yr: p.yr }
  } catch {
    return null
  }
}

/** 拖出屏幕或转屏后，把控件拉回可见范围。 */
function clampPos(): void {
  x.value = clamp(x.value, EDGE, window.innerWidth - size.w - EDGE)
  y.value = clamp(y.value, TOP_MIN, window.innerHeight - size.h - EDGE)
}

function place(): void {
  const el = root.value
  if (!el) return
  size.w = el.offsetWidth
  size.h = el.offsetHeight

  const saved = readPos()
  if (saved) {
    x.value = clamp(
      saved.xr * Math.max(0, window.innerWidth - size.w),
      EDGE,
      window.innerWidth - size.w - EDGE,
    )
    y.value = clamp(
      saved.yr * Math.max(0, window.innerHeight - size.h),
      TOP_MIN,
      window.innerHeight - size.h - EDGE,
    )
  } else {
    // 默认悬浮在右下、离底部留出一段距离，不压住正文末行。
    const gap = Math.max(96, Math.round(window.innerHeight * 0.16))
    x.value = Math.min(EDGE + 8, Math.max(EDGE, window.innerWidth - size.w - EDGE))
    y.value = Math.max(TOP_MIN, window.innerHeight - size.h - gap)
  }
  ready.value = true
}

onMounted(async () => {
  await nextTick()
  place()
  window.addEventListener('resize', clampPos)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', clampPos)
})

function onPointerDown(e: PointerEvent): void {
  // 按钮保持点击；其余区域都能拖。
  if ((e.target as HTMLElement).closest('.mini__btn')) return
  dragId = e.pointerId
  startX = e.clientX
  startY = e.clientY
  baseX = x.value
  baseY = y.value
  moved = false
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (dragId !== e.pointerId) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  if (!moved && Math.hypot(dx, dy) < 5) return
  moved = true
  x.value = clamp(baseX + dx, EDGE, window.innerWidth - size.w - EDGE)
  y.value = clamp(baseY + dy, TOP_MIN, window.innerHeight - size.h - EDGE)
}

function onPointerUp(e: PointerEvent): void {
  if (dragId !== e.pointerId) return
  const wasMoved = moved
  dragId = null
  moved = false
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // 指针已经失效时忽略。
  }

  // 按下时捕获了指针，浏览器会把 click 重定向到根节点，按钮上的 click 不会触发。
  // 所以「点一下返回听书页」必须在这里直接处理，不能只依赖 click。
  suppressClick = true
  if (wasMoved) savePos()
  else emit('expand')
  // 兜底复位，别把下一次点击吃掉。
  window.setTimeout(() => {
    suppressClick = false
  }, 350)
}

function onPointerCancel(e: PointerEvent): void {
  if (dragId !== e.pointerId) return
  dragId = null
  moved = false
  suppressClick = true
  window.setTimeout(() => {
    suppressClick = false
  }, 350)
}

function onBodyClick(): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  emit('expand')
}

function onCoverError(e: Event): void {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

/* ---- 模板事件 ---- */
function handleToggle(): void {
  emit('toggle')
}

function handleClose(): void {
  emit('close')
}
</script>

<template>
  <div
    ref="root"
    class="mini"
    :class="{ 'mini--ready': ready }"
    :style="{ left: x + 'px', top: y + 'px' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @click.stop
  >
    <button class="mini__body" aria-label="展开听书界面" @click="onBodyClick">
      <span class="mini__cover">
        <img v-if="cover" :src="cover" alt="" @error="onCoverError" />
        <Icon v-else name="headphones" :size="15" />
        <span v-if="timerLeft" class="mini__timer-dot" aria-label="定时关闭中">
          <Icon name="timer" :size="8" :width="2.2" />
        </span>
      </span>
      <span class="mini__label">听书</span>
    </button>

    <button
      class="mini__btn"
      :aria-label="buffering ? '取消准备' : playing ? '暂停' : '播放'"
      :disabled="unavailable"
      @click="handleToggle"
    >
      <span v-if="buffering" class="mini__spinner" aria-hidden="true" />
      <MorphIcon v-else :name="playing ? 'pause' : 'play'" :size="18" :width="1.9" />
    </button>
    <button class="mini__btn" aria-label="退出听书" @click="handleClose">
      <Icon name="close" :size="16" :width="1.9" />
    </button>
  </div>
</template>

<style scoped>
.mini {
  position: fixed;
  z-index: 56;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 22px;
  background: rgba(38, 42, 32, 0.92);
  color: #f3f4ea;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  opacity: 0;
  touch-action: none;
}

.mini--ready {
  opacity: 1;
  transition: opacity 160ms ease-out;
}

.mini__body {
  flex: 1;
  min-width: 74px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 0 4px;
  color: inherit;
  cursor: grab;
  white-space: nowrap;
}

.mini__label {
  font-size: calc(12px * var(--app-font-scale));
  color: rgba(243, 244, 234, 0.78);
}

.mini__body:active {
  cursor: grabbing;
}

.mini__cover {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.7);
}

.mini__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mini__timer-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e9e4cb;
  color: #333a2b;
}

.mini__btn {
  flex-shrink: 0;
  width: 28px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #f3f4ea;
}

.mini__btn:active {
  background: rgba(255, 255, 255, 0.12);
}

/* 在线音色准备本章音频时，播放键位置转圈（和全屏页同一个状态）。 */
.mini__spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.6px solid rgba(243, 244, 234, 0.22);
  border-top-color: #f3f4ea;
  animation: miniSpin 720ms linear infinite;
}

@keyframes miniSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mini__spinner {
    animation-duration: 2s;
  }
}

.mini__btn:disabled {
  opacity: 0.35;
}
</style>
