<script setup lang="ts">
/**
 * Reader top bar — WeRead's opened-menu bar: back on the left, the book-level
 * actions on the right (想法 / 分享 / 更多).
 *
 * Two entries the reference shows are deliberately absent:
 *  - 付费: there is no store behind local books;
 *  - 加入书架: every imported book *is* on the shelf, so the button would be a
 *    no-op. A dead affordance is worse than a missing one — see
 *    docs/一致性审计-2026-10-21.md §7.
 *
 * The book title is not shown here: WeRead puts it in the catalogue drawer, and
 * repeating it above the text just costs a line of reading space.
 */
import Icon from '@/components/Icon.vue'

defineProps<{
  /** Notes/想法 recorded for this book. */
  noteCount?: number
}>()

const emit = defineEmits<{
  back: []
  share: []
  more: []
  notes: []
  search: []
}>()

/* ---- 模板事件 ---- */
function handleBack(): void {
  emit('back')
}

function handleSearch(): void {
  emit('search')
}

function handleNotes(): void {
  emit('notes')
}

function handleShare(): void {
  emit('share')
}

function handleMore(): void {
  emit('more')
}
</script>

<template>
  <div class="topbar" @click.stop>
    <button class="topbar__btn" @click="handleBack" aria-label="返回">
      <Icon name="back" :size="24" :width="1.9" />
    </button>

    <div class="topbar__actions">
      <!-- 书内搜索：找正文里的一句话，而不只是章节名。 -->
      <button class="topbar__action" @click="handleSearch" aria-label="搜索本书">
        <Icon name="search" :size="21" :width="1.9" />
      </button>
      <!-- 想法: person glyph with the count set beside its shoulder. -->
      <button class="topbar__action" @click="handleNotes" aria-label="想法">
        <Icon name="person" :size="21" :width="1.8" />
        <span v-if="noteCount" class="topbar__count">{{ noteCount > 99 ? '99+' : noteCount }}</span>
      </button>
      <button class="topbar__action" @click="handleShare" aria-label="分享">
        <Icon name="share" :size="21" />
      </button>
      <button class="topbar__action" @click="handleMore" aria-label="更多">
        <Icon name="more" :size="21" :width="1.9" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(6px + var(--safe-top)) 8px 6px;
  background: var(--topbar-bg);
  /* WeRead separates the bar with a hairline, not a shadow. */
  border-bottom: 0.5px solid var(--divider);
  animation: dropDown 200ms var(--page-easing);
}

@keyframes dropDown {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

.topbar__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  color: var(--text);
  border-radius: 50%;
  flex-shrink: 0;
}

.topbar__actions {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

.topbar__action {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 38px;
  color: var(--text);
  border-radius: 8px;
}

/*
 * WeRead sets the idea count as small grey text at the icon's top right — not
 * the filled pill used for unread badges.
 */
.topbar__count {
  position: absolute;
  top: 4px;
  right: 2px;
  font-size: calc(9px * var(--app-font-scale));
  line-height: 1;
  color: var(--text-secondary);
  letter-spacing: -0.2px;
}
</style>
