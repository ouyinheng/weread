<script setup lang="ts">
/**
 * Small three-dot loading indicator.
 *
 * WeRead uses motion rather than a static "加载中…" string, and the same
 * component is reused wherever a page is waiting on IndexedDB or a parse.
 */
withDefaults(defineProps<{ label?: string; light?: boolean }>(), {
  label: '加载中',
  light: false,
})
</script>

<template>
  <span class="dots" :class="{ 'dots--light': light }" role="status" :aria-label="label">
    <span class="dots__dot" />
    <span class="dots__dot" />
    <span class="dots__dot" />
  </span>
</template>

<style scoped>
.dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 20px;
}

.dots__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: dotPulse 1.05s ease-in-out infinite;
}

.dots__dot:nth-child(2) {
  animation-delay: 0.14s;
}

.dots__dot:nth-child(3) {
  animation-delay: 0.28s;
}

.dots--light .dots__dot {
  background: #fff;
}

@keyframes dotPulse {
  0%,
  70%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  35% {
    transform: translateY(-5px);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dots__dot {
    animation: none;
    opacity: 0.7;
  }
}
</style>
