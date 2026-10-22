<script setup lang="ts">
/**
 * The reader's own selection menu — WeRead draws one rather than letting the
 * platform bar speak for it, because 划线 and 想法 are not things the system
 * knows about. The native ActionMode is suppressed in MainActivity so this is
 * the only bar over a selection.
 *
 * Two rows, three actions each: the platform's own 复制 / 分享 / 全选, plus
 * 网页搜索, and the two that belong to a reading app — 划线 and 想法.
 * 想法 opens a small sheet rather than `window.prompt`, which some WebViews
 * block and none can style.
 */
import { nextTick, ref } from 'vue'

defineProps<{
  /** Selection midpoint in viewport px; the bar is centred on it. */
  x: number
  /** Selection top in viewport px; the bar sits above it. */
  y: number
  /** Whole chapter body is selected, so 全选 has nothing more to do. */
  allSelected?: boolean
}>()

const emit = defineEmits<{
  copy: []
  share: []
  selectAll: []
  webSearch: []
  highlight: []
  /** Save a highlight carrying this note. */
  note: [string]
  close: []
}>()

const noteOpen = ref(false)
const noteText = ref('')
const noteInput = ref<HTMLTextAreaElement>()

function openNote() {
  noteOpen.value = true
  noteText.value = ''
  nextTick(() => noteInput.value?.focus())
}

function saveNote() {
  const t = noteText.value.trim()
  if (!t) {
    emit('close')
    return
  }
  emit('note', t)
}
</script>

<template>
  <div class="sel-bar" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
    <div class="sel-row">
      <button class="sel-item" @click="emit('copy')">复制</button>
      <button class="sel-item" @click="emit('share')">分享</button>
      <button class="sel-item" :disabled="allSelected" @click="emit('selectAll')">全选</button>
    </div>
    <div class="sel-row">
      <button class="sel-item sel-item--primary" @click="emit('highlight')">划线</button>
      <button class="sel-item sel-item--primary" @click="openNote">想法</button>
      <button class="sel-item" @click="emit('webSearch')">网页搜索</button>
    </div>
  </div>

  <div v-if="noteOpen" class="sel-note-mask" @click.self="emit('close')">
    <div class="sel-note">
      <div class="sel-note__head">
        <button class="sel-note__cancel" @click="emit('close')">取消</button>
        <span class="sel-note__title">写想法</span>
        <button class="sel-note__save" @click="saveNote">保存</button>
      </div>
      <textarea
        ref="noteInput"
        v-model="noteText"
        class="sel-note__input"
        rows="4"
        placeholder="写下你的想法…"
      />
    </div>
  </div>
</template>

<style scoped>
.sel-bar {
  position: fixed;
  z-index: 200;
  transform: translate(-50%, -100%);
  overflow: hidden;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
  animation: selIn 120ms ease-out;
}

@keyframes selIn {
  from { opacity: 0; transform: translate(-50%, calc(-100% + 4px)); }
  to { opacity: 1; transform: translate(-50%, -100%); }
}

.sel-row {
  display: flex;
}
.sel-row + .sel-row {
  border-top: 0.5px solid rgba(0, 0, 0, 0.08);
}

.sel-item {
  min-width: 72px;
  height: 46px;
  padding: 0 16px;
  font-size: calc(15px * var(--app-font-scale));
  color: #1f1f1f;
  white-space: nowrap;
  border-right: 0.5px solid rgba(0, 0, 0, 0.08);
}
.sel-item:last-child { border-right: none; }
.sel-item:disabled {
  color: rgba(0, 0, 0, 0.28);
}
/* 划线 / 想法 are the reader's own verbs — WeRead gives them the accent. */
.sel-item--primary {
  color: var(--accent);
}

.sel-note-mask {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.4);
}
.sel-note {
  width: 100%;
  background: var(--bg-panel);
  border-radius: 16px 16px 0 0;
  padding: 6px 16px calc(16px + var(--safe-bottom));
}
.sel-note__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
}
.sel-note__title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}
.sel-note__cancel {
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
}
.sel-note__save {
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
}
.sel-note__input {
  width: 100%;
  min-height: 96px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: calc(15px * var(--app-font-scale));
  line-height: 1.6;
  resize: none;
}
</style>
