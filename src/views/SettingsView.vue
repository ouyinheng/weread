<script setup lang="ts">
/**
 * App settings.
 *
 * Deliberately *not* the reader's typography page: font size, line height,
 * margins, theme colours and background all live in the reader's own bottom
 * panel, where the user can see the effect on the page immediately. Duplicating
 * them here let the two drift apart and made this page feel like a second
 * reader.
 *
 * What remains are settings that belong to the app, plus the four reading
 * behaviours the user asked to keep.
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '@/stores'
import { useBookStore } from '@/stores'
import { useSourceStore } from '@/stores/source'
import { fontLabelOf } from '@/utils/fonts'
import Icon from '@/components/Icon.vue'
import { pickAndImport } from '@/utils/importer'
import { alertDialog, confirmDialog } from '@/utils/dialog'

const router = useRouter()
const store = useSettingsStore()
const bookStore = useBookStore()
const sourceStore = useSourceStore()

const s = computed(() => store.settings)

const appVersion = '1.0.0'

onMounted(() => { sourceStore.load() })

async function toggleNetworkSources() {
  if (!sourceStore.networkEnabled) {
    const ok = await confirmDialog({
      title: '开启网络书源',
      message: '开启后，搜索、加入书架、阅读未缓存章节和书源体检会向书源站点发起网络请求。书源地址可在「书源管理」中查看。',
      confirmText: '开启',
    })
    if (!ok) return
  }
  await sourceStore.setNetworkEnabled(!sourceStore.networkEnabled)
}

async function clearCache() {
  const ok = await confirmDialog({
    title: '清理缓存',
    message: '清理缓存只会删除原始书籍文件（用于解析器升级时重建），已导入的书和阅读进度会保留。',
    confirmText: '清理',
  })
  if (!ok) return
  const { openRawDB } = await import('@/utils/db')
  const db = await openRawDB()
  await new Promise<void>((res, rej) => {
    const t = db.transaction('files', 'readwrite')
    const r = t.objectStore('files').clear()
    r.onsuccess = () => res()
    r.onerror = () => rej(r.error)
  })
  await alertDialog({
    title: '已清理',
    message: '缓存已清理。',
    confirmText: '知道了',
  })
}

function about() {
  void alertDialog({
    title: '关于微读',
    message: `微读（本地版） ${appVersion}\n\n本地导入 · 离线阅读 · 进度本地保存`,
    confirmText: '知道了',
  })
}
</script>

<template>
  <div class="settings-page">
    <header class="settings-header">
      <button class="settings-back" @click="router.back()" aria-label="返回">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="settings-title">设置</span>
    </header>

    <div class="settings-body">
      <!--
        Reading behaviour: these are app-level policies, not page styling.
        Order follows WeRead's list (不自动锁屏 → 允许横屏 → 时间和电量 → 音量键),
        with the entries that need an account or a cloud service left out.
      -->
      <div class="settings-group">
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">阅读时不自动锁屏</span>
          <button
            class="toggle"
            :class="{ on: s.noAutoLock }"
            role="switch"
            :aria-checked="s.noAutoLock"
            @click="store.update({ noAutoLock: !s.noAutoLock })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">阅读时允许横屏</span>
          <button
            class="toggle"
            :class="{ on: s.landscape }"
            role="switch"
            :aria-checked="s.landscape"
            @click="store.update({ landscape: !s.landscape })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">阅读时显示时间和电量</span>
          <button
            class="toggle"
            :class="{ on: s.showStatusBar }"
            role="switch"
            :aria-checked="s.showStatusBar"
            @click="store.update({ showStatusBar: !s.showStatusBar })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">使用音量键翻页</span>
          <button
            class="toggle"
            :class="{ on: s.volumeKeyTurn }"
            role="switch"
            :aria-checked="s.volumeKeyTurn"
            @click="store.update({ volumeKeyTurn: !s.volumeKeyTurn })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
      </div>

      <!-- Typography entry: the face picker is its own page, like WeRead's. -->
      <div class="settings-group">
        <button class="settings-cell" @click="router.push({ name: 'fontSettings' })">
          <span class="settings-cell-label">字体</span>
          <span class="settings-cell-value">{{ fontLabelOf(s.fontFamily) }}</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
      </div>

      <p class="settings-hint">
        字号、背景、行距等排版设置请在阅读页底部「字体」「亮度」中调整，改动会立即显示在正文上。
      </p>

      <!-- 网络书源：默认关闭，首次开启时说明会联网 -->
      <div class="settings-group">
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">网络书源</span>
          <button
            class="toggle"
            :class="{ on: sourceStore.networkEnabled }"
            role="switch"
            :aria-checked="sourceStore.networkEnabled"
            @click="toggleNetworkSources"
          >
            <span class="toggle__dot" />
          </button>
        </div>
      </div>

      <p class="settings-hint">
        网络书源关闭时不发任何请求；开启后仅在搜索、加入书架、阅读未缓存章节和书源体检时联网。
      </p>

      <!-- Library -->
      <div class="settings-group">
        <button class="settings-cell" @click="pickAndImport()">
          <span class="settings-cell-label">导入本地书籍</span>
          <span class="settings-cell-value">{{ bookStore.books.length }} 本</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
        <button class="settings-cell" @click="clearCache">
          <span class="settings-cell-label">清理缓存</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
      </div>

      <!-- About -->
      <div class="settings-group">
        <button class="settings-cell" @click="about">
          <span class="settings-cell-label">关于微读</span>
          <span class="settings-cell-value">v{{ appVersion }}</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
      </div>

      <p class="settings-note">所有数据仅保存在本机，不上传服务器。</p>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.settings-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  background: var(--bg-page);
  flex-shrink: 0;
}

.settings-back {
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

.settings-title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.settings-body {
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

.settings-group {
  background: var(--bg-panel);
  border-radius: 12px;
  overflow: hidden;
  /* Column flex parent: without this the card shrinks and clips its last row. */
  flex-shrink: 0;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  min-height: 52px;
  border-bottom: 0.5px solid var(--divider);
}

.settings-row:last-child {
  border-bottom: none;
}

.settings-row--toggle .settings-label {
  flex: 1;
}

.settings-label {
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
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

.settings-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 52px;
  padding: 0 16px;
  border-bottom: 0.5px solid var(--divider);
  text-align: left;
}

.settings-cell:last-child {
  border-bottom: none;
}

.settings-cell:active {
  opacity: 0.55;
}

.settings-cell-label {
  flex: 1;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.settings-cell-value {
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}

.settings-chevron {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.settings-hint {
  padding: 0 4px;
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.settings-note {
  padding: 0 4px 8px;
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
