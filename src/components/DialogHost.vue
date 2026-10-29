<script setup lang="ts">
/**
 * Single host for app-owned confirm/alert cards.
 *
 * Mounted once in App.vue so every screen gets the same modal instead of the
 * platform's `window.confirm` sheet. Registers with the overlay registry, so
 * Android back closes the dialog before leaving the page.
 */
import { onBeforeUnmount, watch } from 'vue'
import { dialogState, resolveDialog } from '@/utils/dialog'
import { closeOverlay, openOverlay, uiState } from '@/utils/ui-state'

const OVERLAY_ID = 'dialog'
/** Overlay that was open underneath (e.g. the notes sheet), restored on close. */
let previousOverlay: { name: string; close: (() => void) | null } | null = null

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') resolveDialog(false)
}

watch(
  () => dialogState.open,
  open => {
    if (open) {
      previousOverlay = { name: uiState.overlay, close: uiState.closeOverlay }
      openOverlay(OVERLAY_ID, () => resolveDialog(false))
      window.addEventListener('keydown', onKeydown)
    } else {
      closeOverlay(OVERLAY_ID)
      window.removeEventListener('keydown', onKeydown)
      if (previousOverlay?.name && previousOverlay.close) {
        openOverlay(previousOverlay.name, previousOverlay.close)
      }
      previousOverlay = null
    }
  },
)

onBeforeUnmount(() => {
  if (dialogState.open) closeOverlay(OVERLAY_ID)
  window.removeEventListener('keydown', onKeydown)
})

/* ---- 模板事件 ---- */
function handleCancel(): void {
  resolveDialog(false)
}

function handleConfirm(): void {
  resolveDialog(true)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="dialogState.open" class="dialog-mask" @click.self="handleCancel">
        <div class="dialog-card" role="dialog" aria-modal="true" :aria-label="dialogState.title || '提示'">
          <div class="dialog-body">
            <p v-if="dialogState.title" class="dialog-title">{{ dialogState.title }}</p>
            <p class="dialog-message">{{ dialogState.message }}</p>
          </div>
          <div class="dialog-actions" :class="{ 'dialog-actions--single': dialogState.alert }">
            <button v-if="!dialogState.alert" class="dialog-btn" @click="handleCancel">
              {{ dialogState.cancelText }}
            </button>
            <button
              class="dialog-btn dialog-btn--primary"
              :class="{ 'dialog-btn--danger': dialogState.danger }"
              @click="handleConfirm"
            >
              {{ dialogState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}

.dialog-card {
  width: min(310px, 82vw);
  background: var(--bg-panel);
  border-radius: 14px;
  overflow: hidden;
  color: var(--text);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}

.dialog-body {
  padding: 24px 22px 20px;
  text-align: center;
}

.dialog-title {
  margin-bottom: 10px;
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.dialog-message {
  font-size: calc(14px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text);
  white-space: pre-line;
}

.dialog-actions {
  display: flex;
  border-top: 0.5px solid var(--divider);
}

.dialog-btn {
  flex: 1;
  height: 50px;
  background: var(--bg-panel);
  font-size: calc(16px * var(--app-font-scale));
  color: var(--text-secondary);
}

.dialog-btn + .dialog-btn {
  border-left: 0.5px solid var(--divider);
}

.dialog-btn:active {
  opacity: 0.55;
}

.dialog-btn--primary {
  color: var(--accent);
  font-weight: 500;
}

.dialog-btn--danger {
  color: #e64340;
}

.dialog-actions--single .dialog-btn {
  color: var(--accent);
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 160ms ease;
}

.dialog-enter-active .dialog-card,
.dialog-leave-active .dialog-card {
  transition: transform 180ms var(--page-easing);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .dialog-card,
.dialog-leave-to .dialog-card {
  transform: scale(0.94);
}
</style>
