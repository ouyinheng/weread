<script setup lang="ts">
/**
 * WeRead's slider: a thick rounded capsule with the value carried *inside* the
 * thumb, and optional labels pinned to the two ends.
 *
 * The native `<input type=range>` is kept underneath (fully transparent) so
 * dragging, keyboard and platform accessibility still work; the capsule and
 * thumb above it are pure presentation. Measured from the reference screenshot:
 * track and thumb are both 30px tall, the thumb is white with a soft shadow.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    min: number
    max: number
    step?: number
    value: number
    /** Small text pinned inside the capsule ends ("小"/"大", "紧"/"松"). */
    minLabel?: string
    maxLabel?: string
    /** Text shown inside the thumb ("19", "边距"); omit for a plain circle. */
    thumbLabel?: string
    /**
     * Keep the thumb this many px clear of each end, so the end slots (the
     * chapter-step buttons on the progress slider) stay clickable.
     */
    travelInset?: number
  }>(),
  { step: 1, travelInset: 0 },
)

const emit = defineEmits<{
  'update:value': [number]
  change: [number]
}>()

const thumbEl = ref<HTMLElement>()
const thumbW = ref(30)
let ro: ResizeObserver | null = null

function measure() {
  const w = thumbEl.value?.offsetWidth || 0
  if (w) thumbW.value = w
}

onMounted(() => {
  measure()
  ro = new ResizeObserver(measure)
  if (thumbEl.value) ro.observe(thumbEl.value)
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('resize', measure)
})

const pct = computed(() => {
  const span = props.max - props.min
  if (!span) return 0
  return Math.min(1, Math.max(0, (props.value - props.min) / span))
})

const thumbStyle = computed(() => {
  const inset = props.travelInset
  return { left: `calc(${inset}px + ${pct.value} * (100% - ${thumbW.value}px - ${inset * 2}px))` }
})

function onInput(e: Event) {
  emit('update:value', Number((e.target as HTMLInputElement).value))
}
function onChange(e: Event) {
  emit('change', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="capsule">
    <span class="capsule__end capsule__end--min">
      <slot name="min">{{ minLabel }}</slot>
    </span>
    <span class="capsule__end capsule__end--max">
      <slot name="max">{{ maxLabel }}</slot>
    </span>

    <div ref="thumbEl" class="capsule__thumb" :style="thumbStyle">
      <span v-if="thumbLabel" class="capsule__thumb-label">{{ thumbLabel }}</span>
    </div>

    <input
      class="capsule__input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      @input="onInput"
      @change="onChange"
    />
  </div>
</template>

<style scoped>
.capsule {
  position: relative;
  height: 30px;
  border-radius: 15px;
  /* WeRead's track is the grey the panels use for pressed/quiet surfaces. */
  background: rgba(120, 120, 128, 0.12);
  display: flex;
  align-items: center;
}

.capsule__end {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  color: var(--text-secondary);
  font-size: calc(12px * var(--app-font-scale));
  /* Labels are decoration; only interactive end slots (the page-step chevrons)
     opt back in below. */
  pointer-events: none;
  z-index: 2;
}
.capsule__end--min {
  left: 13px;
}
.capsule__end--max {
  right: 13px;
}
.capsule__end:empty {
  display: none;
}
/* Interactive end slots (chapter-step buttons) opt back into hit testing. */
.capsule__end :deep(button) {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.capsule__thumb {
  position: absolute;
  top: 0;
  height: 30px;
  min-width: 30px;
  padding: 0 7px;
  border-radius: 15px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 1;
}

.capsule__thumb-label {
  font-size: calc(12px * var(--app-font-scale));
  color: #333;
  white-space: nowrap;
  line-height: 1;
}

/* The transparent native slider does the actual dragging. */
.capsule__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 0;
}
</style>
