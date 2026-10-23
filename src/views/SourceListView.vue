<script setup lang="ts">
/**
 * 书源管理。
 *
 * 站点会改版，书源会失效 —— 这一页的价值是把「导入 / 停用 / 体检 / 看错误」
 * 放在用户手里，而不是等版本更新。内置源不可删，只能停用。
 */
import { computed, onMounted, ref, watch } from 'vue'
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
const importMode = ref<'url' | 'json'>('url')
const importUrl = ref('')
const importText = ref('')
const importBusy = ref(false)
const importError = ref('')

/** 全量合集有几千条，一次性渲染会卡死列表，这里按关键词过滤 + 分批显示。 */
const PAGE_SIZE = 60
const filter = ref('')
const visibleCount = ref(PAGE_SIZE)

const filteredSources = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return store.sources
  return store.sources.filter(s =>
    `${s.name} ${s.url} ${s.group || ''}`.toLowerCase().includes(q),
  )
})

const shownSources = computed(() => filteredSources.value.slice(0, visibleCount.value))
const hasMore = computed(() => filteredSources.value.length > shownSources.value.length)

watch(filter, () => {
  visibleCount.value = PAGE_SIZE
})

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
  const text = importMode.value === 'url' ? importUrl.value : importText.value
  if (!text.trim()) {
    importError.value = importMode.value === 'url' ? '请先填写书源链接' : '请先粘贴书源 JSON'
    return
  }
  importBusy.value = true
  importError.value = ''
  try {
    const r = await store.importText(text)
    importUrl.value = ''
    importText.value = ''
    showImport.value = false
    const skipped = r.skipped ? `，跳过 ${r.skipped} 个音频/图片或无效条目` : ''
    await alertDialog({
      title: '导入完成',
      message: `共 ${r.total} 条，已导入 ${r.imported} 个文本书源${skipped}。`,
      confirmText: '知道了',
    })
  } catch (e) {
    importError.value = (e as Error).message || '导入失败'
  } finally {
    importBusy.value = false
  }
}

async function checkAll(): Promise<void> {
  if (!store.sources.length) return
  const total = store.sources.length
  await store.checkAll()
  const done = store.checkProgress.done
  const capped = done < total ? `本次先体检了 ${done} 个，再点一次可继续。` : `已体检 ${done} 个书源。`
  await alertDialog({ title: '体检完成', message: `健康度已更新，${capped}点进单个书源可看哪一段失败。`, confirmText: '知道了' })
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
          从链接导入是手动发起的一次请求，不受这个开关限制。
        </p>
      </div>

      <div v-if="store.sources.length" class="src-actions">
        <button class="src-action" :disabled="store.checking || !store.sources.length" @click="checkAll">
          <template v-if="store.checking">
            体检中 {{ store.checkProgress.done }}/{{ store.checkProgress.total }}
          </template>
          <template v-else>全部体检</template>
        </button>
        <button class="src-action" @click="clearCache">清除已缓存正文</button>
      </div>

      <div v-if="store.sources.length" class="src-listbar">
        <input v-model="filter" class="src-search" placeholder="搜索书名源名称、地址或分组" spellcheck="false" />
        <span class="src-count">{{ filteredSources.length }} / {{ store.sources.length }}</span>
      </div>

      <div v-if="shownSources.length" class="src-group src-group--list">
        <div v-for="s in shownSources" :key="s.id" class="src-item">
          <button class="src-item__main" @click="openDetail(s)">
            <span class="src-dot" :style="{ background: HEALTH_COLOR[s.health] || HEALTH_COLOR[0] }" />
            <span class="src-item__text">
              <span class="src-name">
                {{ s.name }}
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
          <button class="src-del" aria-label="删除" @click="removeSource(s)">
            <Icon name="trash" :size="16" />
          </button>
        </div>
      </div>

      <button v-if="hasMore" class="src-more" @click="visibleCount += PAGE_SIZE">
        还有 {{ filteredSources.length - shownSources.length }} 个，显示更多
      </button>

      <div v-if="!shownSources.length" class="src-empty">
        {{ filter ? '没有匹配的书源。' : '还没有书源。点右上角「导入」，粘贴书源链接或 JSON。' }}
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
        <div class="src-sheet__tabs">
          <button
            class="src-sheet__tab"
            :class="{ 'src-sheet__tab--on': importMode === 'url' }"
            @click="importMode = 'url'"
          >
            链接导入
          </button>
          <button
            class="src-sheet__tab"
            :class="{ 'src-sheet__tab--on': importMode === 'json' }"
            @click="importMode = 'json'"
          >
            粘贴 JSON
          </button>
        </div>

        <template v-if="importMode === 'url'">
          <input
            v-model="importUrl"
            class="src-sheet__url"
            placeholder="https://example.com/sources.json"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
          <p class="src-sheet__hint">
            支持书源合集直链、legado://import/bookSource?src=… 分享链接。全量合集约 20MB，导入需要几十秒，请保持页面打开。
          </p>
        </template>
        <template v-else>
          <p class="src-sheet__hint">粘贴书源 JSON（单个对象或数组）。</p>
          <textarea
            v-model="importText"
            class="src-sheet__input"
            placeholder='[{"bookSourceUrl":"https://example.com","bookSourceName":"示例","bookSourceType":0,...}]'
            spellcheck="false"
          />
        </template>
        <p v-if="importError" class="src-sheet__error">{{ importError }}</p>
        <div class="src-sheet__actions">
          <button class="src-sheet__btn" @click="showImport = false">取消</button>
          <button class="src-sheet__btn src-sheet__btn--primary" :disabled="importBusy" @click="doImport">
            {{ importBusy ? '导入中，大合集可能需要几十秒…' : '导入' }}
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

.src-listbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.src-search {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
}

.src-count {
  flex-shrink: 0;
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.src-more {
  flex-shrink: 0;
  height: 40px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(13px * var(--app-font-scale));
  color: var(--accent);
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

.src-sheet__tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-page);
}

.src-sheet__tab {
  flex: 1;
  height: 34px;
  border-radius: 8px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
  transition: background-color 160ms ease-out, color 160ms ease-out;
}

.src-sheet__tab--on {
  background: var(--bg-panel);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.src-sheet__url {
  width: 100%;
  height: 46px;
  padding: 0 12px;
  border-radius: 10px;
  background: var(--bg-page);
  font-size: calc(13px * var(--app-font-scale));
  font-family: ui-monospace, monospace;
  color: var(--text);
  user-select: text;
  -webkit-user-select: text;
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
