<script setup lang="ts">
/**
 * Progress panel — WeRead's layout: three stat columns split by hairlines, a
 * chapter-jump capsule with prev/next step buttons, the "上次读到这里" marker,
 * and two actions underneath.
 *
 * Both actions do real work offline: 阅读明细 expands a detail block from the
 * stored reading sessions, 开启自动翻页 turns pages on a timer (the timer lives
 * in the reader, which owns pagination).
 */
import { computed, ref } from 'vue'
import CapsuleSlider from '@/components/CapsuleSlider.vue'
import Icon from '@/components/Icon.vue'
import { durationSegments, formatDuration } from '@/utils/reading-time'

const props = defineProps<{
  percent: string
  remain: string
  /** Milliseconds of reading time for this book. */
  readingTimeMs: number
  currentChapter: number
  totalChapters: number
  /** Bookmarks/notes recorded for this book — never a hard-coded number. */
  noteCount: number
  autoPaging: boolean
}>()

const emit = defineEmits<{
  jump: [number]
  auto: []
  close: []
}>()

const dragging = ref(false)
const dragValue = ref(0)
const showDetail = ref(false)

const value = computed(() =>
  dragging.value ? dragValue.value : props.currentChapter
)

const timeSegments = computed(() => durationSegments(props.readingTimeMs))
const durationText = computed(() => formatDuration(props.readingTimeMs))

function onInput(v: number) {
  dragging.value = true
  dragValue.value = v
}

function onChange(v: number) {
  dragging.value = false
  emit('jump', v)
}

function step(delta: number) {
  const top = Math.max(0, props.totalChapters - 1)
  dragging.value = false
  emit('jump', Math.min(top, Math.max(0, value.value + delta)))
}
</script>

<template>
  <div class="progress-panel" @click.stop>
    <div class="pp-stats">
      <div class="pp-stat">
        <div class="pp-stat-value">
          <b>{{ percent.replace('%', '') }}</b><i>%</i>
        </div>
        <div class="pp-stat-label">{{ remain }}</div>
      </div>
      <div class="pp-stat-divider" />
      <div class="pp-stat">
        <div class="pp-stat-value">
          <template v-for="(seg, i) in timeSegments" :key="i">
            <b v-if="seg.strong">{{ seg.text }}</b><i v-else>{{ seg.text }}</i>
          </template>
        </div>
        <div class="pp-stat-label">阅读时长</div>
      </div>
      <div class="pp-stat-divider" />
      <div class="pp-stat">
        <div class="pp-stat-value"><b>{{ noteCount }}</b><i>条</i></div>
        <div class="pp-stat-label">笔记</div>
      </div>
    </div>

    <div class="pp-slider">
      <CapsuleSlider
        :min="0"
        :max="Math.max(0, totalChapters - 1)"
        :step="1"
        :value="value"
        :travel-inset="26"
        @update:value="onInput"
        @change="onChange"
      >
        <template #min>
          <button class="pp-step" aria-label="上一章" @click.stop="step(-1)">
            <Icon name="chevron-right" :size="14" :width="2.2" class="pp-step__flip" />
          </button>
        </template>
        <template #max>
          <button class="pp-step" aria-label="下一章" @click.stop="step(1)">
            <Icon name="chevron-right" :size="14" :width="2.2" />
          </button>
        </template>
      </CapsuleSlider>
    </div>

    <div class="pp-here">上次读到这里</div>

    <div class="pp-actions">
      <button
        class="pp-action"
        :class="{ 'pp-action--on': showDetail }"
        @click="showDetail = !showDetail"
      >阅读明细</button>
      <button
        class="pp-action"
        :class="{ 'pp-action--on': autoPaging }"
        @click="emit('auto')"
      >{{ autoPaging ? '关闭自动翻页' : '开启自动翻页' }}</button>
    </div>

    <div v-if="showDetail" class="pp-detail">
      <div class="pp-detail-row">
        <span>当前章节</span>
        <span>第 {{ currentChapter + 1 }} / {{ totalChapters }} 章</span>
      </div>
      <div class="pp-detail-row">
        <span>累计阅读</span>
        <span>{{ durationText }}</span>
      </div>
      <div class="pp-detail-row">
        <span>笔记</span>
        <span>{{ noteCount }} 条</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-panel {
  position: absolute;
  left: 0; right: 0; bottom: calc(52px + var(--safe-bottom));
  z-index: 55;
  padding: 16px 20px;
  background: var(--bg-panel);
  border-top: 1px solid var(--divider);
  animation: panelUp .18s ease;
}
@keyframes panelUp {
  from { transform: translateY(12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* Three columns with hairline separators, as in WeRead. */
.pp-stats {
  display: flex;
  align-items: stretch;
  margin-bottom: 18px;
}
.pp-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pp-stat-divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 0;
  background: var(--divider);
}
.pp-stat-value {
  display: flex;
  align-items: baseline;
  color: var(--text);
  line-height: 1.1;
}
.pp-stat-value b {
  font-size: calc(21px * var(--app-font-scale));
  font-weight: 600;
}
.pp-stat-value i {
  font-style: normal;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text);
}
.pp-stat-label {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  text-align: center;
}

.pp-slider {
  height: 34px;
}
.pp-slider :deep(.capsule) {
  height: 34px;
  border-radius: 17px;
}
.pp-slider :deep(.capsule__thumb) {
  height: 34px;
  border-radius: 17px;
}
.pp-slider :deep(.capsule__end) {
  padding: 0;
}

.pp-step {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-secondary);
}
.pp-step__flip {
  transform: scaleX(-1);
}

.pp-here {
  margin: 10px 0 14px;
  text-align: center;
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}

.pp-actions {
  display: flex;
  gap: 12px;
}
.pp-action {
  flex: 1;
  height: 40px;
  border-radius: 20px;
  background: rgba(120, 120, 128, 0.12);
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}
.pp-action--on {
  color: var(--accent-on-soft);
  background: var(--accent-soft);
}

.pp-detail {
  margin-top: 12px;
  padding: 4px 2px 0;
}
.pp-detail-row {
  display: flex;
  justify-content: space-between;
  padding: 7px 2px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}
.pp-detail-row span:last-child {
  color: var(--text);
}
</style>
