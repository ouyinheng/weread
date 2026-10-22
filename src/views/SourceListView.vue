<script setup lang="ts">
/**
 * 书源管理。
 *
 * 站点会改版，书源会失效 —— 这一页的价值是把「导入 / 停用 / 体检 / 看错误」
 * 放在用户手里，而不是等版本更新。内置源不可删，只能停用。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSourceStore } from '@/stores/source'
import { useBookStore } from '@/stores'
import type { BookSource } from '@/types/source'
import { HEALTH_COLOR, HEALTH_LABEL } from '@/types/source'
import Icon from '@/components/Icon.vue'
import { alertDialog, confirmDialog } from '@/utils/dialog'

const router = useRouter()
const store = useSourceStore()
const bookStore = useBookStore()

const showImport = ref(false)
const importText = ref('')
const importBusy = ref(false)
const importError = ref('')

onMounted(async () => {
  await store.load()
  if (!bookStore.books.length) bookStore.loadBooks()
})

/** 每个源的在线正文缓存量：books.wordCount 随抓取累加。 */
const cacheBySource = computed(() => {
  const map: Record<string, number> = {}
  for (const b of bookStore.books) {
    if (!b.sourceId) continue
    map[b.sourceId] = (map[b.sourceId] || 0) + (b.wordCount || 0)
  }
  return map
})

function cacheText(n: number): string {
  if (!n) return ''
  return n >= 10000 ? `缓存 ${(n / 10000).toFixed(1)} 万字` : `缓存 ${n} 字`
}

function openDetail(s: BookSource): void {
  router.push({ name: 'sourceDetail', query: { id: s.id } })
}

async function toggleNetwork(): Promise<void> {
  if (!store.networkEnabled) {
    const ok = await confirmDialog({
      title: '开启网络书源',
      message: '开启后，搜索、加入书架、阅读未缓存章节和书源体检会向书源站点发起网络请求。书源地址可在本页查看。',
      confirmText: '开启',
    })
    if (!ok) return
  }
  await store.setNetworkEnabled(!store.networkEnabled)
}

async function toggleSource(s: BookSource): Promise<void> {
  try {
    await store.toggle(s.id, !s.enabled)
  } catch (e) {
    await alertDialog({ title: '操作失败', message: (e as Error).message })
  }
}

async function removeSource(s: BookSource): Promise<void> {
  const ok = await confirmDialog({
    title: '删除书源',
    message: `删除「${s.name}」？书架上的书会保留，但未缓存的章节将无法再抓取。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await store.remove(s.id)
  } catch (e) {
    await alertDialog({ title: '删除失败', message: (e as Error).message })
  }
}

async function doImport(): Promise<void> {
  if (importBusy.value) return
  importBusy.value = true
  importError.value = ''
  try {
    const n = await store.importText(importText.value)
    importText.value = ''
    showImport.value = false
    await alertDialog({ title: '导入完成', message: `已导入 ${n} 个书源`, confirmText: '知道了' })
  } catch (e) {
    importError.value = (e as Error).message || '导入失败'
  } finally {
    importBusy.value = false
  }
}

async function checkAll(): Promise<void> {
  if (!store.sources.length) return
  await store.checkAll()
  await alertDialog({ title: '体检完成', message: '健康度已更新，点进单个书源可看哪一段失败。', confirmText: '知道了' })
}

async function clearCache(): Promise<void> {
  const ok = await confirmDialog({
    title: '清除已缓存正文',
    message: '只会删除在线章节的正文，目录、进度、书签和划线都会保留。读过的章节需要重新联网抓取。',
    confirmText: '清除',
    danger: true,
  })
  if (!ok) return
  const n = await store.clearCache()
  await alertDialog({ title: '已清除', message: `已清除 ${n} 个章节的正文。`, confirmText: '知道了' })
}
</script>

<template>
  <div class="src-page">
    <header class="src-header">
      <button class="src-back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="src-title">书源管理</span>
      <button class="src-header-action" @click="showImport = true">导入</button>
    </header>

    <main class="src-body">
      <div class="src-group">
        <div class="src-row">
          <span class="src-label">网络书源</span>
          <button
            class="toggle"
            :class="{ on: store.networkEnabled }"
            role="switch"
            :aria-checked="store.networkEnabled"
            @click="toggleNetwork"
          >
            <span class="toggle__dot" />
          </button>
        </div>
        <p class="src-hint">
          默认关闭。开启后仅在搜索、加入书架、阅读未缓存章节、书源体检时联网；书源地址均可在下方查看。
        </p>
      </div>

      <div v-if="store.sources.length" class="src-group src-group--list">
        <div v-for="s in store.sources" :key="s.id" class="src-item">
          <button class="src-item__main" @click="openDetail(s)">
            <span class="src-dot" :style="{ background: HEALTH_COLOR[s.health] || HEALTH_COLOR[0] }" />
            <span class="src-item__text">
              <span class="src-name">
                {{ s.name }}
                <span v-if="s.builtin" class="src-badge">内置</span>
              </span>
              <span class="src-meta">{{ s.url }}</span>
              <span class="src-meta">
                {{ HEALTH_LABEL[s.health] || '未检测' }}
                <template v-if="cacheBySource[s.id]"> · {{ cacheText(cacheBySource[s.id]) }}</template>
                <template v-if="s.group"> · {{ s.group }}</template>
              </span>
              <span v-if="s.lastError" class="src-error">{{ s.lastError }}</span>
            </span>
          </button>
          <button
            class="toggle src-toggle"
            :class="{ on: s.enabled }"
            role="switch"
            :aria-checked="s.enabled"
            @click="toggleSource(s)"
          >
            <span class="toggle__dot" />
          </button>
          <button v-if="!s.builtin" class="src-del" aria-label="删除" @click="removeSource(s)">
            <Icon name="trash" :size="16" />
          </button>
        </div>
      </div>

      <div v-else class="src-empty">还没有书源。点右上角「导入」粘贴书源 JSON 或地址。</div>

      <div class="src-actions">
        <button class="src-action" :disabled="store.checking || !store.sources.length" @click="checkAll">
          {{ store.checking ? '体检中…' : '全部体检' }}
        </button>
        <button class="src-action" @click="clearCache">清除已缓存正文</button>
      </div>
    </main>

    <!-- 导入面板 -->
    <div v-if="showImport" class="src-mask" @click.self="showImport = false">
      <div class="src-sheet">
        <div class="src-sheet__head">
          <span class="src-sheet__title">导入书源</span>
          <button class="src-sheet__close" aria-label="关闭" @click="showImport = false">
            <Icon name="close" :size="18" :width="2" />
          </button>
        </div>
        <p class="src-sheet__hint">粘贴书源 JSON（单个或数组），或一个返回 JSON 的地址。</p>
        <textarea
          v-model="importText"
          class="src-sheet__input"
          placeholder='[{"bookSourceUrl":"https://example.com","bookSourceName":"示例","bookSourceType":0,...}]'
          spellcheck="false"
        />
        <p v-if="importError" class="src-sheet__error">{{ importError }}</p>
        <div class="src-sheet__actions">
          <button class="src-sheet__btn" @click="showImport = false">取消</button>
          <button class="src-sheet__btn src-sheet__btn--primary" :disabled="importBusy" @click="doImport">
            {{ importBusy ? '导入中…' : '导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.src-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.src-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  background: var(--bg-page);
  flex-shrink: 0;
}

.src-back {
  position: absolute;
  left: 8px;
  bottom: 2px;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  border-radius: 50%;
}

.src-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.src-header-action {
  position: absolute;
  right: 12px;
  bottom: 8px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
  padding: 6px 4px;
}

.src-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px 12px calc(20px + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: contentIn 180ms var(--page-easing);
}

.src-group {
  background: var(--bg-panel);
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}

.src-group--list {
  display: flex;
  flex-direction: column;
}

.src-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  min-height: 52px;
}

.src-label {
  flex: 1;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.src-hint {
  padding: 0 16px 14px;
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.src-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--divider);
}

.src-item:last-child {
  border-bottom: none;
}

.src-item__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  text-align: left;
}

.src-item__main:active {
  opacity: 0.6;
}

.src-dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.src-item__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.src-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.src-badge {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: calc(10px * var(--app-font-scale));
  font-weight: 400;
  color: var(--accent);
  background: var(--accent-soft);
}

.src-meta {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.src-error {
  font-size: calc(11px * var(--app-font-scale));
  color: #E35B5B;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.toggle {
  position: relative;
  width: 46px;
  height: 22px;
  border-radius: 11px;
  background: rgba(120, 120, 128, 0.22);
  transition: background-color 200ms ease-out;
  flex-shrink: 0;
}

.toggle.on {
  background: var(--accent);
}

.toggle__dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  transition: transform 200ms var(--page-easing);
}

.toggle.on .toggle__dot {
  transform: translateX(24px);
}

.src-toggle {
  margin-left: 6px;
}

.src-del {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.src-empty {
  padding: 32px 16px;
  border-radius: 12px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
  text-align: center;
}

.src-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.src-action {
  flex: 1;
  height: 46px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
}

.src-action:disabled {
  opacity: 0.45;
}

.src-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
}

.src-sheet {
  width: 100%;
  max-height: 82vh;
  padding: 16px 16px calc(16px + var(--safe-bottom));
  border-radius: 16px 16px 0 0;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.src-sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.src-sheet__title {
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.src-sheet__close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.src-sheet__hint {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.src-sheet__input {
  width: 100%;
  min-height: 160px;
  max-height: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-page);
  font-size: calc(12px * var(--app-font-scale));
  font-family: ui-monospace, monospace;
  color: var(--text);
  line-height: 1.5;
  resize: vertical;
  user-select: text;
  -webkit-user-select: text;
}

.src-sheet__error {
  font-size: calc(12px * var(--app-font-scale));
  color: #E35B5B;
}

.src-sheet__actions {
  display: flex;
  gap: 10px;
}

.src-sheet__btn {
  flex: 1;
  height: 44px;
  border-radius: 10px;
  background: var(--bg-page);
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.src-sheet__btn--primary {
  background: var(--accent);
  color: #fff;
}

.src-sheet__btn:disabled {
  opacity: 0.5;
}
</style>
