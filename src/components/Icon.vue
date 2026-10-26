<script setup lang="ts">
/**
 * Single icon system for the whole app.
 *
 * All glyphs share one geometry so nothing looks borrowed from a different
 * family: 24×24 viewBox, 1.7 stroke, round caps and joins, no fills. Size and
 * colour come from CSS (`currentColor`), so an icon inherits the text colour of
 * whatever it sits in and scales with one prop.
 *
 * Why hand-rolled instead of an icon package: the set WeRead actually uses
 * (open-book tab icons, the half-moon theme chip, the segmented "字" marks in
 * the font bar) has no close match in the common open-source sets, and mixing
 * two families is what makes an icon row look uneven.
 */
import type { IconName } from './icon-names'

withDefaults(
  defineProps<{
    name: IconName
    size?: number
    /** Stroke width; 1.7 is the app default. */
    width?: number
  }>(),
  { size: 22, width: 1.7 }
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="width"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-if="name === 'back'" d="M15 18l-6-6 6-6" />
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6.6" />
      <path d="M16 16l4.2 4.2" />
    </template>
    <path v-else-if="name === 'plus'" d="M12 5.4v13.2M5.4 12h13.2" />
    <!-- 书架 bar: WeRead circled the pair of add/select glyphs. -->
    <template v-else-if="name === 'plus-circle'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </template>
    <path v-else-if="name === 'check'" d="M4.8 12.6l4.6 4.6 9.8-10.4" />
    <template v-else-if="name === 'check-circle'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M8.2 12.2l2.7 2.7 5-5.3" />
    </template>
    <path v-else-if="name === 'chevron-right'" d="M9.4 6.2l5.6 5.8-5.6 5.8" />
    <path v-else-if="name === 'chevron-down'" d="M6.2 9.4l5.8 5.6 5.8-5.6" />
    <path v-else-if="name === 'close'" d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" />
    <template v-else-if="name === 'more'">
      <circle cx="12" cy="5.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.6" r="1.5" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'share'">
      <path d="M12 15.4V3.8M8.2 7.4L12 3.6l3.8 3.8" />
      <path d="M4.6 13.4v5.2a1.4 1.4 0 001.4 1.4h12a1.4 1.4 0 001.4-1.4v-5.2" />
    </template>
    <!-- 目录: three rules, WeRead style -->
    <path v-else-if="name === 'catalog'" d="M4 7h16M4 12h16M4 17h10" />
    <!--
      笔记 (reader bottom bar): WeRead draws a pen nib inside a circle — a leaf
      shape with its slit — not a bookmark. Traced from the real bar.
    -->
    <template v-else-if="name === 'note'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M8.7 15.3c-1-3.5 1.7-6.9 5.4-7.6.7 3.6-1.9 7-5.4 7.6z" />
      <path d="M8.7 15.3l3.1-3.1" />
    </template>
    <!-- Bookmark: used where the action really is "save this position". -->
    <path v-else-if="name === 'bookmark'" d="M5.8 4.2h12.4a.8.8 0 01.8.8v15.4l-7-4.2-7 4.2V5a.8.8 0 01.8-.8z" />
    <!--
      进度 (reader bottom bar): WeRead's glyph is a knob on a track — a ring
      with a short dash either side, reading as "-O-".
    -->
    <template v-else-if="name === 'progress'">
      <circle cx="12" cy="12" r="5.1" />
      <path d="M3.1 12h3.6M17.3 12h3.6" />
    </template>
    <!-- 亮度: sun with eight rays -->
    <template v-else-if="name === 'brightness'">
      <circle cx="12" cy="12" r="3.7" />
      <path d="M12 2.9v2.2M12 18.9v2.2M2.9 12h2.2M18.9 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
    </template>
    <!-- 字体: serif A -->
    <path v-else-if="name === 'font'" d="M5.2 19.2L11.5 5.4h1L18.8 19.2M8 14.2h7.9" />
    <!-- 书架/阅读 tab: open book -->
    <template v-else-if="name === 'book-open'">
      <path d="M12 6.6C10.2 5.2 7.6 4.6 4.4 4.8v12.6c3.2-.2 5.8.4 7.6 1.8 1.8-1.4 4.4-2 7.6-1.8V4.8c-3.2-.2-5.8.4-7.6 1.8z" />
      <path d="M12 6.6v12.6" />
    </template>
    <!-- 书架 tab (alternative: closed books) -->
    <path v-else-if="name === 'book'" d="M4.4 4.8h6.2v14.4H4.4zM13.4 4.8h6.2v14.4h-6.2z" />
    <!-- 我 tab -->
    <template v-else-if="name === 'person'">
      <circle cx="12" cy="8.1" r="3.7" />
      <path d="M4.8 20.2c0-3.8 3.2-6.4 7.2-6.4s7.2 2.6 7.2 6.4" />
    </template>
    <!-- 设置 gear -->
    <template v-else-if="name === 'gear'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.8a1.6 1.6 0 00.3 1.8l.1.1a1.9 1.9 0 11-2.7 2.7l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5v.2a1.9 1.9 0 11-3.8 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a1.9 1.9 0 11-2.7-2.7l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1h-.2a1.9 1.9 0 110-3.8h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a1.9 1.9 0 112.7-2.7l.1.1a1.6 1.6 0 001.8.3h.1a1.6 1.6 0 001-1.5v-.2a1.9 1.9 0 113.8 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a1.9 1.9 0 112.7 2.7l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.2a1.9 1.9 0 110 3.8h-.1a1.6 1.6 0 00-1.5 1z" />
    </template>
    <!-- 夜间模式 moon (filled, used inside the dark theme chip) -->
    <path v-else-if="name === 'moon'" d="M20.4 12.9A8.6 8.6 0 1111.1 3.6a6.7 6.7 0 009.3 9.3z" fill="currentColor" stroke="none" />
    <template v-else-if="name === 'download'">
      <path d="M12 3.8v11.4M8.2 11.4L12 15.2l3.8-3.8" />
      <path d="M4.6 17v2.2a1.4 1.4 0 001.4 1.4h12a1.4 1.4 0 001.4-1.4V17" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4.8 6.8h14.4M9.4 6.8V4.6h5.2v2.2" />
      <path d="M6.6 6.8l.8 12.2a1.4 1.4 0 001.4 1.3h6.4a1.4 1.4 0 001.4-1.3l.8-12.2" />
    </template>
    <template v-else-if="name === 'person-add'">
      <circle cx="10" cy="8.1" r="3.7" />
      <path d="M3.4 20.2c0-3.8 3-6.4 6.6-6.4 1.4 0 2.7.4 3.7 1" />
      <path d="M17.6 14.2v5M15.1 16.7h5" />
    </template>
    <template v-else-if="name === 'message'">
      <path d="M20.4 11.6c0 4-3.8 7.2-8.4 7.2-1 0-2-.2-2.9-.5l-4.5 1.3 1.3-3.9a6.6 6.6 0 01-1.3-4.1c0-4 3.8-7.2 8.4-7.2s7.4 3.2 7.4 7.2z" />
    </template>
    <!-- 首行顶格 / 首行缩进 cards in the indent sheet -->
    <template v-else-if="name === 'align-left'">
      <path d="M4 6.5h16M4 11h11M4 15.5h16M4 20h11" />
    </template>
    <!-- Listen bar: stroke-only, same weight as the rest of the set. -->
    <path v-else-if="name === 'play'" d="M9 5.8 18.6 12 9 18.2Z" />
    <path v-else-if="name === 'pause'" d="M9.6 5.6v12.8M14.4 5.6v12.8" />
    <template v-else-if="name === 'skip-back'">
      <path d="M6.4 5.8v12.4" />
      <path d="M17.8 6.2 9.4 12l8.4 5.8Z" />
    </template>
    <template v-else-if="name === 'skip-forward'">
      <path d="M17.6 5.8v12.4" />
      <path d="M6.2 6.2 14.6 12l-8.4 5.8Z" />
    </template>
    <template v-else-if="name === 'subtitles'">
      <rect x="3.4" y="6" width="17.2" height="12" rx="2.4" />
      <path d="M7.2 11.4h4.2M13.6 11.4h3.2M7.2 14.6h8.4" />
    </template>
    <path v-else-if="name === 'sort-down'" d="M7 4.6v14.8M3.8 16l3.2 3.4 3.2-3.4M14 5.4h6.2M14 10.4h4.6M14 15.4h3" />
    <!-- 定时关闭: clock -->
    <template v-else-if="name === 'timer'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4v5.1l3.1 1.9" />
    </template>
    <!-- 听书标题 / 音色 -->
    <template v-else-if="name === 'headphones'">
      <path d="M4.4 13.4v-1.2a7.6 7.6 0 0115.2 0v1.2" />
      <path d="M4.4 13.4h2.4v5.2H6a1.6 1.6 0 01-1.6-1.6zM19.6 13.4h-2.4v5.2h.8a1.6 1.6 0 001.6-1.6z" />
    </template>
    <!-- 语速: gauge with a needle -->
    <template v-else-if="name === 'speed'">
      <path d="M4.6 16.8a8.4 8.4 0 1114.8 0" />
      <path d="M12 12.6l3.4-2.6" />
      <circle cx="12" cy="12.6" r="1.2" fill="currentColor" stroke="none" />
    </template>
    <!--
      Tab glyphs use solid `currentColor` fills for all three entries, so the
      bar reads as one family: an open book, a stack of books, and a person.
    -->
    <template v-else-if="name === 'tab-read'">
      <!-- Open book: two curved pages meeting at a V-shaped spine. -->
      <path d="M12 5.6C9.4 4.3 6.3 4.1 3.6 5.2v12.4c2.7-1.1 5.8-.9 8.4.4z" fill="currentColor" stroke="none" />
      <path d="M12 5.6c2.6-1.3 5.7-1.5 8.4-.4v12.4c-2.7-1.1-5.8-.9-8.4.4z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'tab-shelf'">
      <!-- Upper book: round spine on the left, fore-edge bitten in on the right. -->
      <path d="M6.7 2.7h10.8a4.2 4.2 0 000 8.4H6.7a4.2 4.2 0 010-8.4z" fill="currentColor" stroke="none" />
      <!-- Lower book: mirrored, so the pair reads as a stack seen from the side. -->
      <path d="M6.9 13.5h10.8a4.2 4.2 0 010 8.4H6.9a4.2 4.2 0 000-8.4z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'tab-tv'">
      <!-- Screen with a play cut-out; the knock-out uses the bar colour so the
           glyph reads on both the white and black tab bars. -->
      <path d="M4.6 4.4h14.8a2.2 2.2 0 012.2 2.2v10.8a2.2 2.2 0 01-2.2 2.2H4.6a2.2 2.2 0 01-2.2-2.2V6.6a2.2 2.2 0 012.2-2.2z" fill="currentColor" stroke="none" />
      <path d="M10.2 8.6l5.1 3.4-5.1 3.4z" fill="var(--bottom-bar-bg)" stroke="none" />
    </template>
    <template v-else-if="name === 'tab-audio'">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M10.4 8.9l5 3.1-5 3.1z" fill="currentColor" stroke="none" />
    </template>
    <path
      v-else-if="name === 'tab-me'"
      d="M9.8 11.5C8.5 10.8 7.6 9.2 7.6 7.3 7.6 4.9 9.5 3 12 3c2.5 0 4.4 1.9 4.4 4.3 0 1.9-.9 3.5-2.2 4.2 2.9.9 5 3.4 5 6.2 0 .9-.7 1.6-1.6 1.6H6.4c-.9 0-1.6-.7-1.6-1.6 0-2.8 2.1-5.3 5-6.2z"
      fill="currentColor"
      stroke="none"
    />

    <template v-else-if="name === 'import'">
      <path d="M3.4 7.4A1.6 1.6 0 015 5.8h4l2 2.1h8a1.6 1.6 0 011.6 1.6v9.1A1.6 1.6 0 0119 20.2H5a1.6 1.6 0 01-1.6-1.6z" />
    </template>
  </svg>
</template>
