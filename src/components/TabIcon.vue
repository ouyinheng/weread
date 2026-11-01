<script setup lang="ts">
/**
 * 底部 Tab 图标：Remix Icon 的 line / fill 成对字形，交给 morphicons 做形变。
 *
 * 这一层只负责「把 tab 名和选中态翻译成 MorphIcon 的参数」。字形本身在
 * `MorphIcon.vue` 的 PAIRS 里（和 TabIcon 以前抄的那几条 path 一样），
 * 好处是切 tab 时图标从描边弹成实心，而不是硬切一张图。
 */
import MorphIcon from '@/components/MorphIcon.vue'

withDefaults(
  defineProps<{
    name: 'shelf' | 'tv' | 'me'
    active?: boolean
    size?: number
  }>(),
  { active: false, size: 25 },
)
</script>

<template>
  <MorphIcon :name="name" :size="size" :width="1.7" :filled="active" />
</template>
