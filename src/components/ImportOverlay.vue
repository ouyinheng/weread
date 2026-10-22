<script setup lang="ts">
/**
 * Import feedback: one HUD for the whole app.
 *
 * Import is now a single tap from anywhere, so the only place left to report
 * what happened is a floating layer: a spinner while a book is parsed (large
 * EPUBs take a few seconds), a toast when it lands, and a dismissible line if
 * a file was refused.
 */
import { importState, dismissImportError } from '@/utils/importer'
</script>

<template>
  <div v-if="importState.busy" class="import-hud" role="status" aria-live="polite">
    <div class="import-hud__card">
      <span class="import-hud__spinner" />
      <span class="import-hud__title">
        正在导入<span v-if="importState.total > 1"> {{ importState.index }}/{{ importState.total }}</span>
      </span>
      <span class="import-hud__name">{{ importState.name }}</span>
    </div>
  </div>

  <div v-if="importState.error && !importState.busy" class="import-toast" role="alert">
    <span class="import-toast__text">{{ importState.error }}</span>
    <button class="import-toast__close" aria-label="关闭" @click="dismissImportError">✕</button>
  </div>

  <div v-else-if="importState.notice && !importState.busy" class="import-toast import-toast--ok" role="status">
    <span class="import-toast__text">{{ importState.notice }}</span>
  </div>
</template>

<style scoped>
.import-hud {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.18);
}

.import-hud__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: 168px;
  max-width: 78vw;
  padding: 22px 24px;
  border-radius: 14px;
  background: rgba(30, 30, 32, 0.9);
  color: #fff;
}

.import-hud__spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.28);
  border-top-color: #fff;
  animation: spin 720ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.import-hud__title {
  font-size: calc(14px * var(--app-font-scale));
  font-weight: 500;
}

.import-hud__name {
  font-size: calc(12px * var(--app-font-scale));
  color: rgba(255, 255, 255, 0.72);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-toast {
  position: fixed;
  left: 50%;
  bottom: calc(72px + var(--safe-bottom));
  transform: translateX(-50%);
  z-index: 300;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 86vw;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(30, 30, 32, 0.92);
  color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  animation: toastIn 180ms ease-out;
}

@keyframes toastIn {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

.import-toast__text {
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.4;
}

.import-toast__close {
  color: rgba(255, 255, 255, 0.6);
  font-size: calc(12px * var(--app-font-scale));
  padding: 2px;
}
</style>
