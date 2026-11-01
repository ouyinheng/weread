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

/**
 * 有成对字形（描边 / 实心）的图标，用在选中↔未选中。
 *
 * morphicons 的价值就在这种「同一个形状换一种画法」：切 tab 时图标不是闪一下，
 * 而是从描边长成实心。Remix 的 line/fill 是同一轮廓的两种画法，正好一组。
 */
export type MorphPairName = 'shelf' | 'tv' | 'me' | 'search' | 'note' | 'discover'

const PAIRS: Record<MorphPairName, { line: string; fill: string }> = {
  /* remixicon/Document/book-line + book-fill */
  shelf: {
    line: 'M3 18.5V5C3 3.34315 4.34315 2 6 2H20C20.5523 2 21 2.44772 21 3V21C21 21.5523 20.5523 22 20 22H6.5C4.567 22 3 20.433 3 18.5ZM19 20V17H6.5C5.67157 17 5 17.6716 5 18.5C5 19.3284 5.67157 20 6.5 20H19ZM5 15.3368C5.45463 15.1208 5.9632 15 6.5 15H19V4H6C5.44772 4 5 4.44772 5 5V15.3368Z',
    fill: 'M20 22H6.5C4.567 22 3 20.433 3 18.5V5C3 3.34315 4.34315 2 6 2H20C20.5523 2 21 2.44772 21 3V21C21 21.5523 20.5523 22 20 22ZM19 20V17H6.5C5.67157 17 5 17.6716 5 18.5C5 19.3284 5.67157 20 6.5 20H19Z',
  },
  /* remixicon/Media/video-on-line + video-on-fill */
  tv: {
    line: 'M17 9.2L22.2133 5.55071C22.4395 5.39235 22.7513 5.44737 22.9096 5.6736C22.9684 5.75764 23 5.85774 23 5.96033V18.0397C23 18.3158 22.7761 18.5397 22.5 18.5397C22.3974 18.5397 22.2973 18.5081 22.2133 18.4493L17 14.8V19C17 19.5523 16.5523 20 16 20H2C1.44772 20 1 19.5523 1 19V5C1 4.44772 1.44772 4 2 4H16C16.5523 4 17 4.44772 17 5V9.2ZM17 12.3587L21 15.1587V8.84131L17 11.6413V12.3587ZM3 6V18H15V6H3Z',
    fill: 'M17 9.2L22.2133 5.55071C22.4395 5.39235 22.7513 5.44737 22.9096 5.6736C22.9684 5.75764 23 5.85774 23 5.96033V18.0397C23 18.3158 22.7761 18.5397 22.5 18.5397C22.3974 18.5397 22.2973 18.5081 22.2133 18.4493L17 14.8V19C17 19.5523 16.5523 20 16 20H2C1.44772 20 1 19.5523 1 19V5C1 4.44772 1.44772 4 2 4H16C16.5523 4 17 4.44772 17 5V9.2Z',
  },
  /* remixicon/User & Faces/user-3-line + user-3-fill */
  me: {
    line: 'M20 22H18V20C18 18.3431 16.6569 17 15 17H9C7.34315 17 6 18.3431 6 20V22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13ZM12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z',
    fill: 'M20 22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13Z',
  },
  /* remixicon/System/search-line + search-fill */
  search: {
    line: 'M18.031 16.6168L22.3137 20.8995L20.8995 22.3137L16.6168 18.031C15.0769 19.263 13.124 20 11 20C6.032 20 2 15.968 2 11C2 6.032 6.032 2 11 2C15.968 2 20 6.032 20 11C20 13.124 19.263 15.0769 18.031 16.6168ZM16.0247 15.8748C17.2475 14.6146 18 12.8956 18 11C18 7.1325 14.8675 4 11 4C7.1325 4 4 7.1325 4 11C4 14.8675 7.1325 18 11 18C12.8956 18 14.6146 17.2475 15.8748 16.0247L16.0247 15.8748Z',
    fill: 'M18.031 16.6168L22.3137 20.8995L20.8995 22.3137L16.6168 18.031C15.0769 19.263 13.124 20 11 20C6.032 20 2 15.968 2 11C2 6.032 6.032 2 11 2C15.968 2 20 6.032 20 11C20 13.124 19.263 15.0769 18.031 16.6168Z',
  },
  /* remixicon/Document/file-text-line + file-text-fill */
  note: {
    line: 'M21 8V20.9932C21 21.5501 20.5552 22 20.0066 22H3.9934C3.44495 22 3 21.556 3 21.0082V2.9918C3 2.45531 3.4487 2 3.9918 2H15V8H21ZM13 4V7H8V9H13V10H8V12H16V15H8V17H18V9H13V4Z',
    fill: 'M21 8V20.9932C21 21.5501 20.5552 22 20.0066 22H3.9934C3.44495 22 3 21.556 3 21.0082V2.9918C3 2.45531 3.4487 2 3.9918 2H15V8H21ZM13 4V7H8V9H13V10H8V12H16V15H8V17H18V9H13V4Z',
  },
  /* remixicon/Media/compass-3-line + compass-3-fill */
  discover: {
    line: 'M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM16.5 7.5L14 14L7.5 16.5L10 10L16.5 7.5ZM12 13C12.5523 13 13 12.5523 13 12C13 11.4477 12.5523 11 12 11C11.4477 11 11 11.4477 11 12C11 12.5523 11.4477 13 12 13Z',
    fill: 'M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM16.5 7.5L10 10L7.5 16.5L14 14L16.5 7.5Z',
  },
}

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
    /** 单个字形，或成对字形里的名字（带 `filled` 用）。 */
    name: MorphName | MorphPairName
    size?: number
    /** Stroke width; 1.7 is the app default, same as Icon. */
    width?: number
    /**
     * 成对图标里选实心那一版（选中态）。只对 `MorphPairName` 有效。
     * 切换时 morphicons 会把描边形状弹成实心形状，而不是闪一下换图。
     */
    filled?: boolean
  }>(),
  { size: 22, width: 1.7, filled: false },
)

const isPair = computed(() => (props.name as string) in PAIRS)

/**
 * 成对图标两端都用**填充轮廓**。
 *
 * Remix 的 line 版不是描边，而是「挖空的实心形状」；如果一边当描边画、一边当
 * 填充画，morphicons 的插值会找不到可视面（`icon has no visible surface`）。
 * 两版都按填充喂进去，形变就是「孔洞被填上」——正好是选中该有的样子。
 */
const icon = computed(() => {
  if (isPair.value) {
    const pair = PAIRS[props.name as MorphPairName]
    return [[
      'path',
      { d: props.filled ? pair.fill : pair.line, fill: 'currentColor', stroke: 'none' },
    ] as const]
  }
  return PATHS[props.name as MorphName]
})

/** 成对图标靠填充上色，描边宽度给 0；单字形仍按原样描边。 */
const strokeWidth = computed(() => (isPair.value ? 0 : props.width))
</script>

<template>
  <MorphSvg
    :icon="icon"
    :size="size"
    :stroke-width="strokeWidth"
    color="currentColor"
    reduced-motion="never"
  />
</template>
