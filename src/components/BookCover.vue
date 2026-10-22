<script setup lang="ts">
import { computed } from 'vue'
import type { Book } from '@/types'

const props = defineProps<{
  book: Book
  /**
   * Thumbnail mode: show only the initial. The full title is rendered next to
   * the thumb in list rows, so repeating it inside the cover duplicates text.
   */
  compact?: boolean
}>()

const hash = computed(() => {
  let h = 0
  for (let i = 0; i < props.book.title.length; i++) {
    h = (h * 31 + props.book.title.charCodeAt(i)) | 0
  }
  return Math.abs(h)
})

const colorPairs = [
  ['#5B7FA6', '#3D5A80'], ['#A6745B', '#7A4E3B'], ['#6B8E5A', '#4A6B3E'],
  ['#8E5A6B', '#6B3E4E'], ['#5A7B8E', '#3E5A6B'], ['#7A6B5A', '#5A4E3E'],
  ['#6B5A8E', '#4E3E6B'], ['#8E7A5A', '#6B5A3E'],
]

const colors = computed(() => {
  const idx = hash.value % colorPairs.length
  return { bg: colorPairs[idx][0], fg: colorPairs[idx][1] }
})

const firstChar = computed(() => props.book.title.charAt(0) || '书')
</script>

<template>
  <div class="cover" :style="{ background: `linear-gradient(135deg, ${colors.bg}, ${colors.fg})` }">
    <img v-if="book.cover" :src="book.cover" class="cover__img" :alt="book.title" />
    <template v-else>
      <span class="cover__char" :class="{ 'cover__char--compact': compact }">{{ firstChar }}</span>
      <span v-if="!compact" class="cover__title">{{ book.title }}</span>
    </template>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  width: 100%;
  /* WeRead's shelf covers are 2:3; the shelf this component serves is measured
     against that grid, while list thumbnails override both width and height. */
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px var(--shadow);
}
.cover__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover__char--compact {
  font-size: 22px;
}

.cover__char {
  font-size: 36px;
  font-weight: 700;
  color: rgba(255,255,255,0.9);
  line-height: 1;
}
.cover__title {
  font-size: 11px;
  color: rgba(255,255,255,0.75);
  margin-top: 8px;
  padding: 0 8px;
  text-align: center;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
