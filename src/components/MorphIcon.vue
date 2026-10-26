<script lang="ts">
/**
 * 会形变的图标（morphicons）。
 *
 * 用在「同一颗按钮原地切换图标」的地方：播放↔暂停、全屏↔退出全屏、
 * 展开↔收起。换图标时用弹簧物理把旧形拉成新形，而不是闪一下换图。
 *
 * 图标数据是 `d` 字符串，与 Icon.vue 里同名图标的路径保持一致；
 * 尺寸与描边接口也和 Icon 对齐（`size` / `width`），可以当 Icon 的替代品用。
 */
import { MorphIcon as MorphSvg } from 'morphicons/vue'

type MorphName = 'play' | 'pause' | 'expand' | 'compress' | 'chevron-right' | 'chevron-down'

const PATHS: Record<MorphName, string> = {
  play: 'M9 5.8 18.6 12 9 18.2Z',
  pause: 'M9.6 5.6v12.8M14.4 5.6v12.8',
  expand: 'M4.8 9.2V4.8h4.4M19.2 9.2V4.8h-4.4M4.8 14.8v4.4h4.4M19.2 14.8v4.4h-4.4',
  compress: 'M9.2 4.8v4.4H4.8M14.8 4.8v4.4h4.4M9.2 19.2v-4.4H4.8M14.8 19.2v-4.4h4.4',
  'chevron-right': 'M9.4 6.2l5.6 5.8-5.6 5.8',
  'chevron-down': 'M6.2 9.4l5.8 5.6 5.8-5.6',
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: MorphName
    size?: number
    /** Stroke width; 1.7 is the app default, same as Icon. */
    width?: number
  }>(),
  { size: 22, width: 1.7 }
)

const icon = computed(() => PATHS[props.name])
</script>

<template>
  <MorphSvg :icon="icon" :size="size" :stroke-width="width" color="currentColor" />
</template>
