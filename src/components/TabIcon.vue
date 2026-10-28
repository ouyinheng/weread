<script setup lang="ts">
/**
 * 底部 Tab 图标：Remix Icon 的 line / fill 成对版本。
 *
 * 为什么单独一个组件：`Icon.vue` 那套是 24×24 / 1.7 描边的手绘系统，而这六个
 * 字形是 Remix 用**填充路径**画的（line 版也是填充，只是中间挖空）。塞进
 * Icon.vue 会污染它的「无填充」约定，也让那条 v-if 链更难读。
 *
 * 没有引 `remixicon` 的 CSS 字体：那一份 woff2 一百多 KB，只为了六个字形不值当，
 * 还多一次字体加载和 FOUT。这里直接把 `node_modules/remixicon/icons/` 里
 * 对应 SVG 的 path 抄过来，颜色走 currentColor，尺寸跟随 size。
 *
 * 选中态用 fill 版、未选中用 line 版——这是移动端 tab 的通行做法（iOS/微信都是），
 * 比「同一字形换颜色」更容易一眼看出当前在哪。
 */
withDefaults(
  defineProps<{
    name: 'shelf' | 'tv' | 'me'
    active?: boolean
    size?: number
  }>(),
  { active: false, size: 25 }
)

/* node_modules/remixicon/icons/Document/book-line.svg */
const SHELF_LINE =
  'M3 18.5V5C3 3.34315 4.34315 2 6 2H20C20.5523 2 21 2.44772 21 3V21C21 21.5523 20.5523 22 20 22H6.5C4.567 22 3 20.433 3 18.5ZM19 20V17H6.5C5.67157 17 5 17.6716 5 18.5C5 19.3284 5.67157 20 6.5 20H19ZM5 15.3368C5.45463 15.1208 5.9632 15 6.5 15H19V4H6C5.44772 4 5 4.44772 5 5V15.3368Z'
/* node_modules/remixicon/icons/Document/book-fill.svg */
const SHELF_FILL =
  'M20 22H6.5C4.567 22 3 20.433 3 18.5V5C3 3.34315 4.34315 2 6 2H20C20.5523 2 21 2.44772 21 3V21C21 21.5523 20.5523 22 20 22ZM19 20V17H6.5C5.67157 17 5 17.6716 5 18.5C5 19.3284 5.67157 20 6.5 20H19Z'

/* node_modules/remixicon/icons/Media/video-on-line.svg */
const TV_LINE =
  'M17 9.2L22.2133 5.55071C22.4395 5.39235 22.7513 5.44737 22.9096 5.6736C22.9684 5.75764 23 5.85774 23 5.96033V18.0397C23 18.3158 22.7761 18.5397 22.5 18.5397C22.3974 18.5397 22.2973 18.5081 22.2133 18.4493L17 14.8V19C17 19.5523 16.5523 20 16 20H2C1.44772 20 1 19.5523 1 19V5C1 4.44772 1.44772 4 2 4H16C16.5523 4 17 4.44772 17 5V9.2ZM17 12.3587L21 15.1587V8.84131L17 11.6413V12.3587ZM3 6V18H15V6H3Z'
/* node_modules/remixicon/icons/Media/video-on-fill.svg */
const TV_FILL =
  'M17 9.2L22.2133 5.55071C22.4395 5.39235 22.7513 5.44737 22.9096 5.6736C22.9684 5.75764 23 5.85774 23 5.96033V18.0397C23 18.3158 22.7761 18.5397 22.5 18.5397C22.3974 18.5397 22.2973 18.5081 22.2133 18.4493L17 14.8V19C17 19.5523 16.5523 20 16 20H2C1.44772 20 1 19.5523 1 19V5C1 4.44772 1.44772 4 2 4H16C16.5523 4 17 4.44772 17 5V9.2Z'

/* node_modules/remixicon/icons/User & Faces/user-3-line.svg */
const ME_LINE =
  'M20 22H18V20C18 18.3431 16.6569 17 15 17H9C7.34315 17 6 18.3431 6 20V22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13ZM12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z'
/* node_modules/remixicon/icons/User & Faces/user-3-fill.svg */
const ME_FILL =
  'M20 22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13Z'

const PATHS = {
  shelf: { line: SHELF_LINE, fill: SHELF_FILL },
  tv: { line: TV_LINE, fill: TV_FILL },
  me: { line: ME_LINE, fill: ME_FILL },
} as const
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="active ? PATHS[name].fill : PATHS[name].line" />
  </svg>
</template>
