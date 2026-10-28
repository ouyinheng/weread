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

/*
 * 大合集的粘贴不走 textarea。
 *
 * 一份全量书源约 2MB / 几十万字符，塞进 `<textarea v-model>` 会让 WebView 每次
 * 输入事件都重排这几兆文本，手机上表现为卡死甚至被系统杀掉 —— 用户看到的就是
 * 「这么长的 JSON 导不进来」。这里在 paste 事件里就把它截下来，存在普通变量里
 * （非响应式，不进 DOM），界面上只显示一行摘要。
 *
 * 真机上更推荐「从文件导入」，连粘贴都省了。
 */
const LARGE_PASTE = 100_000
let bigPayload = ''
const bigSize = ref(0)
const fileInput = ref<HTMLInputElement>()

const bigSummary = computed(() => {
  if (!bigSize.value) return ''
  const mb = bigSize.value / 1024 / 1024
  return mb >= 1
    ? `${mb.toFixed(1)} MB 文本已就绪`
    : `${Math.round(bigSize.value / 1024)} KB 文本已就绪`
})

function holdBig(text: string) {
  bigPayload = text
  bigSize.value = text.length
  // 让 textarea 保持空，避免同一份内容被渲染两遍。
  importText.value = ''
  importError.value = ''
}

function clearBig() {
  bigPayload = ''
  bigSize.value = 0
  importText.value = ''
}

/** 粘贴时劫持大文本：小的交给 textarea，大的只留摘要。 */
function onJsonPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') ?? ''
  if (text.length <= LARGE_PASTE) return
  e.preventDefault()
  holdBig(text)
}

function pickFile() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许再次选择同一个文件
  if (!file) return
  try {
    holdBig(await file.text())
  } catch (err) {
    importError.value = `读取文件失败：${(err as Error).message || '未知错误'}`
  }
}

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
  // 大文本存在 bigPayload 里；小的照旧从 textarea 取。
  const text = importMode.value === 'url' ? importUrl.value : (bigPayload || importText.value)
  if (!text.trim()) {
    importError.value = importMode.value === 'url' ? '请先填写书源链接' : '请先粘贴书源 JSON 或选择文件'
    return
  }
  importBusy.value = true
  importError.value = ''
  try {
    const r = await store.importText(text)
    importUrl.value = ''
    clearBig()
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

/** 失效源里有多少本书还挂在书架上：删源后这些书的未缓存章节会抓不到。 */
const deadBookCount = computed(() => {
  const dead = new Set(store.deadSources.map(s => s.id))
  return bookStore.books.filter(b => b.sourceId && dead.has(b.sourceId)).length
})

/**
 * 一次清掉所有失效书源。
 *
 * 判死需要连续两次请求失败，且断网期间不记失败；这里仍把即将删掉的源名摆出来，
 * 让用户确认没有误伤。降级（能搜到、读不到正文）和未检测的源不在清理范围内。
 */
async function purgeDead(): Promise<void> {
  if (store.checking) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await alertDialog({
      title: '当前没有网络',
      message: '断网时请求失败只是连不上，不代表书源失效。连上网再清除，避免误删。',
      confirmText: '知道了',
    })
    return
  }
  const dead = store.deadSources
  if (!dead.length) {
    await alertDialog({
      title: '没有失效书源',
      message: '还没有判定为失效的书源。先点「全部体检」查一遍，失败的源会标红，之后再回来一次清掉。',
      confirmText: '知道了',
    })
    return
  }

  const names = dead.slice(0, 5).map(s => `· ${s.name}`).join('\n')
  const more = dead.length > 5 ? `\n· 另 ${dead.length - 5} 个` : ''
  const books = deadBookCount.value
  const bookNote = books
    ? `\n\n书架上有 ${books} 本书来自这些源：书和已缓存章节都保留，只是没缓存的章节抓不到了。`
    : ''
  const ok = await confirmDialog({
    title: `清除 ${dead.length} 个失效书源`,
    message: `连续两次请求失败，判定为失效：\n${names}${more}${bookNote}\n\n降级和未检测的源不会删。`,
    confirmText: '清除',
    danger: true,
  })
  if (!ok) return

  try {
    const n = await store.removeDead()
    await alertDialog({ title: '已清除', message: `已删除 ${n} 个失效书源。`, confirmText: '知道了' })
  } catch (e) {
    await alertDialog({ title: '清除失败', message: (e as Error).message })
  }
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
      <button class="src-back tap-target" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="src-title">书源管理</span>
      <button class="src-header-action tap-target" @click="showImport = true">导入</button>
    </header>

    <main class="src-body">
      <div class="src-group">
        <button
          class="src-row src-row--toggle"
          role="switch"
          :aria-checked="store.networkEnabled"
          @click="toggleNetwork"
        >
          <span class="src-label">网络书源</span>
          <span class="toggle" :class="{ on: store.networkEnabled }" aria-hidden="true">
            <span class="toggle__dot" />
          </span>
        </button>
        <p class="src-hint">
          默认关闭。开启后仅在搜索、加入书架、阅读未缓存章节、书源体检时联网；书源地址均可在下方查看。
          从链接导入是手动发起的一次请求，不受这个开关限制。
        </p>
      </div>

      <div v-if="store.sources.length" class="src-actions">
        <button class="src-action" :disabled="store.checking" @click="checkAll">
          <template v-if="store.checking">
            体检中 {{ store.checkProgress.done }}/{{ store.checkProgress.total }}
          </template>
          <template v-else>全部体检</template>
        </button>
        <button class="src-action" :disabled="store.checking" @click="purgeDead">
          清除失效<template v-if="store.deadSources.length">（{{ store.deadSources.length }}）</template>
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
          <p class="src-sheet__hint">
            粘贴书源 JSON（单个对象或数组）。大合集（几 MB）建议用文件导入，或直接填直链。
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

          <!--
            超过阈值的内容不进 textarea：几十万字符渲染会让 WebView 卡死。
            这里只留一行摘要，原文在 bigPayload 里，导入时照样能用。
          -->
          <div v-if="bigSize" class="src-sheet__big">
            <span class="src-sheet__big-text">{{ bigSummary }}</span>
            <button class="src-sheet__big-clear" @click="clearBig">清除</button>
          </div>
          <textarea
            v-else
            v-model="importText"
            class="src-sheet__input"
            placeholder='[{"bookSourceUrl":"https://example.com","bookSourceName":"示例","bookSourceType":0,...}]'
            spellcheck="false"
            @paste="onJsonPaste"
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

