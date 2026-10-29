<script setup lang="ts">
/**
 * 视频源管理。
 *
 * 页面结构和交互都照「书源管理」来：同一个页头（返回 / 标题 / 导入）、同一套
 * 操作行、搜索框加计数、列表行、底部导入面板。样式用的是共用的
 * `styles/source-page.css`，两个页面不会各长各的。
 *
 * 视频源的差异都在数据层：
 *  - 只有一种源（苹果 CMS 接口根地址），没有分组、没有缓存；
 *  - 多一个「测活」，因为它连的是第三方接口，挂掉是常事。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { testSource } from '@/utils/tv/cms'
import { confirmDialog } from '@/utils/dialog'
import { HEALTH_COLOR, HEALTH_LABEL } from '@/types/source'
import type { TvSource } from '@/utils/tv/types'

const router = useRouter()
const store = useTvStore()

const sheet = ref(false)
const tab = ref<'url' | 'paste'>('paste')

const importUrl = ref('')
const importText = ref('')
const importBusy = ref(false)
const fileInput = ref<HTMLInputElement>()
const notice = ref('')

const filter = ref('')
const testing = ref('')

/** 本次会话的测活结果。源本身没有健康字段，测出来只活在这个页面里。 */
const health = ref<Record<string, boolean>>({})
const checking = ref(false)
const progress = ref({ done: 0, total: 0 })

onMounted(() => {
  void store.load()
})

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const list = store.sources
  if (!q) return list
  return list.filter(s => s.name.toLowerCase().includes(q) || s.api.toLowerCase().includes(q))
})

const dead = computed(() => store.sources.filter(s => health.value[s.id] === false))

function flash(message: string): void {
  notice.value = message
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 2500)
}

/** 复用书源的体检配色：0 未检测 / 1 可用 / 3 失效，两个页面的点颜色必须一致。 */
function healthOf(s: TvSource): number {
  const h = health.value[s.id]
  if (h === true) return 1
  if (h === false) return 3
  return 0
}

function dotColor(s: TvSource): string {
  return HEALTH_COLOR[healthOf(s)]
}

function healthLabel(s: TvSource): string {
  if (testing.value === s.id) return '测活中…'
  // 未检测时补一句怎么测：这一行点了就是测活，不说的话没人会去点。
  return healthOf(s) === 0 ? `${HEALTH_LABEL[0]} · 点一下测活` : HEALTH_LABEL[healthOf(s)]
}

async function test(source: TvSource): Promise<void> {
  if (testing.value) return
  testing.value = source.id
  const result = await testSource(source)
  testing.value = ''
  health.value = { ...health.value, [source.id]: result.ok }
  flash(`${source.name}：${result.message}`)
}

async function checkAll(): Promise<void> {
  if (checking.value) return
  checking.value = true
  progress.value = { done: 0, total: store.sources.length }
  for (const source of store.sources) {
    const result = await testSource(source)
    health.value = { ...health.value, [source.id]: result.ok }
    progress.value = { done: progress.value.done + 1, total: progress.value.total }
  }
  checking.value = false
  const failed = dead.value.length
  flash(failed ? `测活完成，${failed} 个不可用` : '测活完成，全部可用')
}

function purgeDead(): Promise<void> {
  const list = dead.value
  if (!list.length) return Promise.resolve()
  return confirmDialog({
    title: '清除失效源',
    message: `删除测活失败的 ${list.length} 个源？它们的观看记录也会一并清掉。`,
    confirmText: '删除',
    danger: true,
  }).then(ok => {
    if (!ok) return
    list.forEach(s => store.removeSource(s.id))
    flash(`已清除 ${list.length} 个`)
  })
}

/** 选文件塞进文本框：让用户能先看一眼再点导入，和书源那边一致。 */
function pickFile(): void {
  fileInput.value?.click()
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选同一个文件
  if (!file) return
  try {
    importText.value = await file.text()
    tab.value = 'paste'
    flash(`已读取 ${file.name}`)
  } catch (err) {
    flash(`读取失败：${(err as Error).message || '未知错误'}`)
  }
}

function remove(source: TvSource): Promise<void> {
  return confirmDialog({
    title: '删除源',
    message: `删除「${source.name}」？该源的观看记录也会一并清掉。`,
    confirmText: '删除',
    danger: true,
  }).then(ok => {
    if (ok) store.removeSource(source.id)
  })
}

/**
 * 把代码托管平台的「网页地址」换成能跨域拿到的内容地址。
 *
 * 背景：gitee 的 raw 链接（含 302 之后的 giteeusercontent）响应里**没有任何
 * Access-Control-Allow-Origin**，WebView 里 fetch 必被 CORS 拦（控制台表现为 403）。
 * 只有 api/v5 的 contents 接口带 `Access-Control-Allow-Origin: *`，代价是内容包在
 * base64 里，需要解开。
 *
 * GitHub 的 blob 页面同理走不通，换成 raw.githubusercontent（带 `*`，可直接读）。
 * 其他地址原样返回，调用方照旧 fetch。
 */
function contentUrl(raw: string): { url: string; base64: boolean } {
  const clean = raw.trim().replace(/[?#].*$/, '')
  const gitee = clean.match(/^https?:\/\/gitee\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i)
  if (gitee) {
    const [, owner, repo, ref, path] = gitee
    return {
      url: `https://gitee.com/api/v5/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      base64: true,
    }
  }
  const github = clean.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i)
  if (github) {
    const [, owner, repo, ref, path] = github
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      base64: false,
    }
  }
  return { url: raw.trim(), base64: false }
}

/** gitee 接口把文件内容包成 base64；中文要按 UTF-8 解，直接 atob 出来是乱码。 */
function decodeBase64Text(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
}

/**
 * 兼容三种结构：
 *  - LibreTV 导出：{ customAPIs: [{ name, url }] }
 *  - TVBox 配置：  { sites: [{ name, api }] }
 *  - 裸数组：      [{ name, url | api }]
 */
function parseImport(text: string): Array<{ name?: string; api: string }> {
  const data = JSON.parse(text)
  const out: Array<{ name?: string; api: string }> = []
  const push = (n: unknown, a: unknown) => {
    if (typeof a !== 'string') return
    if (!/^https?:\/\//i.test(a)) return
    out.push({ name: typeof n === 'string' ? n : undefined, api: a })
  }

  if (Array.isArray(data)) {
    data.forEach((row: any) => push(row?.name, row?.api || row?.url))
  } else if (Array.isArray(data?.customAPIs)) {
    data.customAPIs.forEach((row: any) => push(row?.name, row?.url || row?.api))
  } else if (Array.isArray(data?.sites)) {
    data.sites.forEach((row: any) => push(row?.name || row?.key, row?.api || row?.url))
  } else if (Array.isArray(data?.sources)) {
    data.sources.forEach((row: any) => push(row?.name, row?.url || row?.api))
  }

  return out
}

async function doImport(): Promise<void> {
  if (importBusy.value) return
  importBusy.value = true
  try {
    let text = importText.value
    if (tab.value === 'url') {
      const url = importUrl.value.trim()
      if (!url) {
        flash('先填源列表链接')
        return
      }
      const target = contentUrl(url)
      const res = await fetch(target.url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
      if (target.base64) {
        // 接口返回 { encoding: 'base64', content: '...' }；失败时是 { message }
        const payload = JSON.parse(text) as { encoding?: string; content?: string; message?: string }
        if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
          throw new Error(payload.message || '接口没返回文件内容')
        }
        text = decodeBase64Text(payload.content)
      }
    }
    if (!text.trim()) {
      flash(tab.value === 'url' ? '先填源列表链接' : '先粘贴 JSON 或选一个文件')
      return
    }
    let list: Array<{ name?: string; api: string }>
    try {
      list = parseImport(text)
    } catch {
      flash('不是合法 JSON')
      return
    }
    if (!list.length) {
      flash('没找到接口地址，检查 JSON 结构')
      return
    }
    const added = store.importSources(list)
    importText.value = ''
    importUrl.value = ''
    sheet.value = false
    flash(added ? `新增 ${added} 个源` : '这些源都已经在了')
  } catch (err) {
    flash(`拉取失败：${(err as Error).message || '未知错误'}`)
  } finally {
    importBusy.value = false
  }
}

/* ---- 模板事件 ---- */
function handleBack(): void {
  router.back()
}

function handleOpenSheet(): void {
  sheet.value = true
}

function handleCloseSheet(): void {
  sheet.value = false
}

function handleToggleSource(s: TvSource): void {
  void store.toggleSource(s.id)
}

function handleUseUrlTab(): void {
  tab.value = 'url'
}

function handleUsePasteTab(): void {
  tab.value = 'paste'
}
</script>

<template>
  <div class="src-page tv-src-page">
    <header class="src-header">
      <button class="src-back tap-target" aria-label="返回" @click="handleBack">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="src-title">视频源管理</span>
      <button class="src-header-action tap-target" @click="handleOpenSheet">导入</button>
    </header>

    <main class="src-body">
      <p v-if="notice" class="tv-src__notice">{{ notice }}</p>

      <div class="src-group">
        <p class="src-hint">
          苹果 CMS V10 的接口根地址，一般以 <code>/api.php/provide/vod/</code> 结尾。
          视频源与书库分开存放：这里的源只服务「影视」Tab，不影响阅读。
        </p>
      </div>

      <div v-if="store.sources.length" class="src-actions">
        <button class="src-action" :disabled="checking" @click="checkAll">
          <template v-if="checking">测活中 {{ progress.done }}/{{ progress.total }}</template>
          <template v-else>全部测活</template>
        </button>
        <button class="src-action" :disabled="checking || !dead.length" @click="purgeDead">
          清除失效<template v-if="dead.length">（{{ dead.length }}）</template>
        </button>
      </div>

      <div v-if="store.sources.length" class="src-listbar">
        <input v-model="filter" class="src-search" placeholder="搜索源名称或接口地址" spellcheck="false" />
        <span class="src-count">{{ filtered.length }} / {{ store.sources.length }}</span>
      </div>

      <div v-if="filtered.length" class="src-group src-group--list">
        <div v-for="s in filtered" :key="s.id" class="src-item">
          <button class="src-item__main" @click="test(s)">
            <span class="src-dot" :style="{ background: dotColor(s) }" />
            <span class="src-item__text">
              <span class="src-name">{{ s.name }}</span>
              <span class="src-meta">{{ s.api }}</span>
              <span class="src-meta">{{ healthLabel(s) }}</span>
            </span>
          </button>
          <button
            class="toggle src-toggle"
            :class="{ on: s.enabled }"
            role="switch"
            :aria-checked="s.enabled"
            :aria-label="`启用 ${s.name}`"
            @click="handleToggleSource(s)"
          >
            <span class="toggle__dot" />
          </button>
          <button class="src-del" aria-label="删除" @click="remove(s)">
            <Icon name="trash" :size="16" />
          </button>
        </div>
      </div>

      <div v-if="!filtered.length" class="src-empty">
        {{
          filter ? '没有匹配的视频源。' : '还没有视频源。点右上角「导入」，粘贴 JSON、填源列表链接或选文件。'
        }}
      </div>
    </main>

    <!-- 导入面板：和书源管理同一套（链接 / 粘贴 / 文件），只是内容换成视频源 -->
    <div v-if="sheet" class="src-mask" @click.self="handleCloseSheet">
      <div class="src-sheet">
        <div class="src-sheet__head">
          <span class="src-sheet__title">导入视频源</span>
          <button class="src-sheet__close" aria-label="关闭" @click="handleCloseSheet">
            <Icon name="close" :size="18" :width="2" />
          </button>
        </div>

        <div class="src-sheet__tabs">
          <button
            class="src-sheet__tab"
            :class="{ 'src-sheet__tab--on': tab === 'url' }"
            @click="handleUseUrlTab"
          >
            链接导入
          </button>
          <button
            class="src-sheet__tab"
            :class="{ 'src-sheet__tab--on': tab === 'paste' }"
            @click="handleUsePasteTab"
          >
            粘贴 JSON
          </button>
        </div>

        <template v-if="tab === 'url'">
          <input
            v-model="importUrl"
            class="src-sheet__url"
            placeholder="https://example.com/sources.json"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            inputmode="url"
          />
          <p class="src-sheet__hint">
            填一份源列表的直链：LibreTV 导出的 <code>customAPIs</code>、TVBox 的 <code>sites</code>，或
            <code>[{ "name": …, "url": … }]</code> 数组都认。 Gitee / GitHub
            的仓库页面地址直接贴就行，会自动换成能跨域读取的接口。
          </p>
        </template>

        <template v-else>
          <p class="src-sheet__hint">
            支持 LibreTV 导出的 <code>{ "customAPIs": […] }</code>、TVBox 的 <code>{ "sites": […] }</code>，或
            <code>[{ "name": …, "url": … }]</code> 数组。
          </p>

          <button class="src-sheet__file" @click="pickFile">
            <Icon name="import" :size="16" :width="1.8" />
            <span>从文件导入 .json</span>
          </button>
          <input
            ref="fileInput"
            class="src-sheet__fileinput"
            type="file"
            accept=".json,.txt,application/json,text/plain"
            @change="onFileChange"
          />

          <textarea
            v-model="importText"
            class="src-sheet__input"
            placeholder='[{"name":"暴风资源","api":"https://example.com/api.php/provide/vod/"}]'
            spellcheck="false"
          />
        </template>

        <p v-if="notice" class="src-sheet__error">{{ notice }}</p>

        <div class="src-sheet__actions">
          <button class="src-sheet__btn" @click="handleCloseSheet">取消</button>
          <button class="src-sheet__btn src-sheet__btn--primary" :disabled="importBusy" @click="doImport">
            {{ importBusy ? '导入中…' : '导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 面板关闭后的操作反馈（新增/清除/测活结果），样式跟着页面走，不另开一套。 */
.tv-src__notice {
  margin: 0 0 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: calc(13px * var(--app-font-scale));
}
</style>
