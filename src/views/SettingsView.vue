<script setup lang="ts">
/**
 * App settings.
 *
 * Deliberately *not* the reader's typography page: body text size, leading,
 * margins, reading theme and background live in the reader's own bottom panel,
 * where the user can see the effect on the page immediately.
 *
 * The system tab does own app chrome: the UI font family, the UI font scale and
 * the app colour scheme. None of them touch `ReaderSettings`.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppSettingsStore, useSettingsStore } from '@/stores'
import { useBookStore } from '@/stores'
import { useSourceStore } from '@/stores/source'
import type { AppTheme } from '@/types'
import { fontLabelOf } from '@/utils/fonts'
import Icon from '@/components/Icon.vue'
import { pickAndImport } from '@/utils/importer'
import { alertDialog, confirmDialog } from '@/utils/dialog'
import { isNativeShell } from '@/utils/native'
import { backupProgress, exportBackup, importBackup, saveBackup } from '@/utils/backup'

const route = useRoute()
const router = useRouter()
const store = useSettingsStore()
const appSettings = useAppSettingsStore()
const bookStore = useBookStore()
const sourceStore = useSourceStore()

const s = computed(() => store.settings)
const app = computed(() => appSettings.app)

const THEME_OPTIONS: { id: AppTheme; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
]

function setAppTheme(id: AppTheme): void {
  void appSettings.update({ theme: id })
}

/** 拖动时先实时改 CSS 变量，松手再落库，避免每移动一点就写一次 IndexedDB。 */
function previewFontScale(e: Event): void {
  appSettings.app.fontScale = Number((e.target as HTMLInputElement).value)
  appSettings.apply()
}

function saveFontScale(): void {
  void appSettings.update({ fontScale: appSettings.app.fontScale })
}

const appVersion = '1.0.0'
/** 阅读设置只改阅读页；系统设置才会作用于整个应用。「我的」页两个入口各进一页。 */
const isSystem = route.query.tab === 'system'
/** 防锁屏 / 横屏 / 音量键依赖原生桥；浏览器预览里它们不会生效，要说清楚。 */
const nativeShell = isNativeShell()

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
  const { dbClear } = await import('@/utils/db')
  await dbClear('files')
  await alertDialog({
    title: '已清理',
    message: '缓存已清理。',
    confirmText: '知道了',
  })
}

/** 导出完成后还要把字节写到磁盘（原生桥），这一段也要占住按钮并给反馈。 */
const backupSaving = ref(false)
const backupBusy = computed(() => backupProgress.busy || backupSaving.value)

/** 备份整库到一个 zip；导出期间设置页显示进度。 */
async function backupToFile() {
  if (backupBusy.value) return
  try {
    const blob = await exportBackup()
    backupSaving.value = true
    const how = await saveBackup(blob)
    backupSaving.value = false
    const message = how.mode === 'saved'
      ? `备份已保存到：${how.path || '文件管理器的下载目录'}。`
      : how.mode === 'shared'
        ? '备份文件已交给系统分享，请选择一个保存位置。'
        : '备份文件已开始下载，请在浏览器的下载目录中查看。'
    await alertDialog({ title: '备份完成', message, confirmText: '知道了' })
  } catch (e) {
    backupSaving.value = false
    const msg = (e as Error)?.name === 'AbortError'
      ? '已取消分享。'
      : ((e as Error)?.message || '导出失败')
    await alertDialog({ title: '备份未完成', message: msg, confirmText: '知道了' })
  }
}

/** 选择一个备份文件并覆盖恢复。 */
function pickRestoreFile() {
  if (backupBusy.value) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,application/zip'
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.onchange = async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return
    const ok = await confirmDialog({
      title: '从备份恢复',
      message: '恢复会覆盖这台设备上的全部书籍、进度、书签和笔记，且无法撤销。建议先备份当前数据。',
      confirmText: '覆盖恢复',
    })
    if (!ok) return
    try {
      const r = await importBackup(file)
      await alertDialog({
        title: '恢复完成',
        message: `已恢复 ${r.books} 本书、${r.files} 个原始文件、${r.highlights} 条划线。应用将重新加载。`,
        confirmText: '重新加载',
      })
      location.reload()
    } catch (e) {
      await alertDialog({
        title: '恢复失败',
        message: (e as Error)?.message || '备份文件无法读取',
        confirmText: '知道了',
      })
    }
  }
  document.body.appendChild(input)
  input.click()
}

const backupPercent = computed(() => {
  if (!backupProgress.total) return 0
  return Math.min(100, Math.round(backupProgress.current / backupProgress.total * 100))
})

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
      <span class="settings-title">{{ isSystem ? '系统设置' : '阅读设置' }}</span>
    </header>

    <div class="settings-body">
      <template v-if="!isSystem">
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
      <p v-if="!nativeShell" class="settings-hint">
        不自动锁屏、允许横屏和音量键翻页由 Android 客户端实现，浏览器预览中不会生效。
      </p>

      <!-- 听书: the engine itself is the phone's, so there is nothing to set up
           here — only how the reader behaves while it speaks. -->
      <div class="settings-group">
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">听书时跟随高亮</span>
          <button
            class="toggle"
            :class="{ on: s.listenFollow }"
            role="switch"
            :aria-checked="s.listenFollow"
            aria-label="听书时跟随高亮"
            @click="store.update({ listenFollow: !s.listenFollow })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">听完本章自动播下一章</span>
          <button
            class="toggle"
            :class="{ on: s.listenAutoNext }"
            role="switch"
            :aria-checked="s.listenAutoNext"
            aria-label="听完本章自动播下一章"
            @click="store.update({ listenAutoNext: !s.listenAutoNext })"
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

      </template>

      <template v-else>
      <!-- 界面外观：只改应用外壳，阅读页的字号/字体/主题仍由阅读设置决定。 -->
      <div class="settings-group">
        <button
          class="settings-cell"
          @click="router.push({ name: 'fontSettings', query: { scope: 'app' } })"
        >
          <span class="settings-cell-label">字体</span>
          <span class="settings-cell-value">{{ fontLabelOf(app.fontFamily) }}</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>

        <div class="settings-row settings-row--scale">
          <span class="settings-label">字体大小</span>
          <div class="font-scale">
            <span class="font-scale__a font-scale__a--small">A</span>
            <input
              class="font-scale__slider"
              type="range"
              min="0.85"
              max="1.35"
              step="0.05"
              :value="app.fontScale"
              aria-label="界面字体大小"
              @input="previewFontScale"
              @change="saveFontScale"
            />
            <span class="font-scale__a font-scale__a--large">A</span>
            <span class="font-scale__value">{{ Math.round(app.fontScale * 100) }}%</span>
          </div>
        </div>

        <div class="settings-row settings-row--theme">
          <span class="settings-label">主题色</span>
          <div class="theme-options">
            <button
              v-for="t in THEME_OPTIONS"
              :key="t.id"
              class="theme-option"
              :class="{ 'theme-option--on': app.theme === t.id }"
              @click="setAppTheme(t.id)"
            >{{ t.label }}</button>
          </div>
        </div>
      </div>

      <!-- 功能入口：影视是可选模块，默认不占底栏，需要时再打开。 -->
      <div class="settings-group">
        <div class="settings-row settings-row--toggle">
          <span class="settings-label">显示影视入口</span>
          <button
            class="toggle"
            :class="{ on: app.showTvTab }"
            role="switch"
            :aria-checked="app.showTvTab"
            @click="appSettings.update({ showTvTab: !app.showTvTab })"
          >
            <span class="toggle__dot" />
          </button>
        </div>
      </div>
      <p class="settings-hint">
        开启后底部导航显示「影视」。关闭只会隐藏入口，已添加的视频源和观看记录都会保留，仍可从「我 → 视频源管理」进入。
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

      <!-- Library -->
      <div class="settings-group">
        <button class="settings-cell" @click="pickAndImport()">
          <span class="settings-cell-label">导入本地书籍</span>
          <span class="settings-cell-value">{{ bookStore.books.length }} 本</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
        <button class="settings-cell" :disabled="backupBusy" @click="backupToFile">
          <span class="settings-cell-label">备份到文件</span>
          <span class="settings-cell-value">
            {{ backupSaving ? '写入中' : backupProgress.phase === 'export' ? `${backupProgress.current}/${backupProgress.total}` : 'zip' }}
          </span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
        <button class="settings-cell" :disabled="backupBusy" @click="pickRestoreFile">
          <span class="settings-cell-label">从备份恢复</span>
          <span class="settings-cell-value">覆盖当前数据</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
        <button class="settings-cell" @click="clearCache">
          <span class="settings-cell-label">清理缓存</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
      </div>

      <!-- 备份/恢复是长任务：转圈之外要有可数的进度。 -->
      <div v-if="backupProgress.busy" class="settings-progress" role="status">
        <div class="settings-progress__track">
          <div class="settings-progress__bar" :style="{ width: backupPercent + '%' }" />
        </div>
        <div class="settings-progress__text">
          <span>{{ backupProgress.message }}</span>
          <span>{{ backupPercent }}%</span>
        </div>
      </div>

      <!-- About -->
      <div class="settings-group">
        <button class="settings-cell" @click="about">
          <span class="settings-cell-label">关于微读</span>
          <span class="settings-cell-value">v{{ appVersion }}</span>
          <Icon name="chevron-right" :size="17" :width="2" class="settings-chevron" />
        </button>
      </div>

      </template>
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

.settings-hint {
  padding: 0 6px;
  font-size: calc(11.5px * var(--app-font-scale));
  line-height: 1.7;
  color: var(--text-secondary);
}

.settings-progress {
  padding: 12px 14px;
  background: var(--bg-panel);
  border-radius: 12px;
}

.settings-progress__track {
  height: 4px;
  border-radius: 2px;
  background: var(--divider);
  overflow: hidden;
}

.settings-progress__bar {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width var(--dur-fast) linear;
}

.settings-progress__text {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.settings-cell:disabled {
  opacity: 0.45;
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

.settings-row--scale,
.settings-row--theme {
  min-height: 58px;
}

.settings-row--theme .settings-label {
  flex-shrink: 0;
}

.font-scale {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.font-scale__a {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.font-scale__a--small {
  font-size: calc(12px * var(--app-font-scale));
}

.font-scale__a--large {
  font-size: calc(18px * var(--app-font-scale));
}

.font-scale__slider {
  flex: 1;
  min-width: 0;
  height: 20px;
  accent-color: var(--accent);
}

.font-scale__value {
  width: 36px;
  flex-shrink: 0;
  text-align: right;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.theme-options {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.theme-option {
  padding: 5px 9px;
  border-radius: 9px;
  background: rgba(120, 120, 128, 0.1);
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.theme-option--on {
  background: var(--accent-soft);
  color: var(--accent);
}

</style>
