import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BookSource, SearchHit } from '@/types/source'
import type { SearchFailure, DiagnoseResult } from '@/utils/source/sourceService'
import * as sourceService from '@/utils/source/sourceService'

/**
 * 书源状态：书源列表、网络总开关、搜索结果。
 *
 * 所有落库与网络动作都在 sourceService 里，store 只维护页面需要的那份状态。
 */
export const useSourceStore = defineStore('source', () => {
  const sources = ref<BookSource[]>([])
  const networkEnabled = ref(false)
  const loaded = ref(false)

  const searching = ref(false)
  const checking = ref(false)
  const lastKey = ref('')
  const hits = ref<SearchHit[]>([])
  const failures = ref<SearchFailure[]>([])

  /** 总开关打开、且至少有一条启用中的书源，发现页才走在线搜索。 */
  const onlineReady = computed(() => networkEnabled.value && sources.value.some(s => s.enabled))
  const enabledSources = computed(() => sources.value.filter(s => s.enabled))

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    await sourceService.ensureBuiltinSources()
    sources.value = await sourceService.listSources()
    networkEnabled.value = await sourceService.loadNetworkEnabled()
    loaded.value = true
  }

  async function refresh(): Promise<void> {
    sources.value = await sourceService.listSources()
  }

  async function setNetworkEnabled(enabled: boolean): Promise<void> {
    networkEnabled.value = enabled
    await sourceService.saveNetworkEnabled(enabled)
  }

  async function importText(text: string): Promise<number> {
    const n = await sourceService.importSourcesFromText(text)
    await refresh()
    return n
  }

  async function remove(id: string): Promise<void> {
    await sourceService.deleteSource(id)
    await refresh()
  }

  async function toggle(id: string, enabled: boolean): Promise<void> {
    await sourceService.setSourceEnabled(id, enabled)
    await refresh()
  }

  async function saveRaw(id: string, text: string): Promise<BookSource> {
    const next = await sourceService.updateSourceRaw(id, text)
    await refresh()
    return next
  }

  let searchSeq = 0

  async function searchOnline(key: string): Promise<void> {
    const word = key.trim()
    const seq = ++searchSeq
    lastKey.value = word
    if (!word) {
      hits.value = []
      failures.value = []
      searching.value = false
      return
    }
    searching.value = true
    try {
      const out = await sourceService.searchAll(word)
      // 用户又搜了一次：旧请求的结果不许覆盖新结果。
      if (seq !== searchSeq) return
      hits.value = out.hits
      failures.value = out.failures
    } catch {
      if (seq === searchSeq) {
        hits.value = []
        failures.value = []
      }
    } finally {
      if (seq === searchSeq) searching.value = false
      await refresh().catch(() => undefined)
    }
  }

  function clearResults(): void {
    searchSeq++
    lastKey.value = ''
    hits.value = []
    failures.value = []
    searching.value = false
  }

  async function addToShelf(hit: SearchHit): Promise<string> {
    return sourceService.addToShelf(hit)
  }

  /** 同名书换到另一个源，保留阅读进度。 */
  async function switchSource(bookId: string, hit: SearchHit): Promise<void> {
    await sourceService.switchSource(bookId, hit)
  }

  async function checkOne(id: string, key: string): Promise<DiagnoseResult> {
    const src = sources.value.find(s => s.id === id)
    if (!src) throw new Error('书源不存在')
    const result = await sourceService.diagnose(src, key)
    const failed = result.steps.find(s => !s.ok)
    await sourceService.markHealth(id, result.health, result.health === 1 ? '' : (failed?.detail || ''))
    await refresh()
    return result
  }

  async function checkAll(key = '小说'): Promise<void> {
    if (checking.value) return
    checking.value = true
    try {
      await Promise.all(sources.value.map(async (s) => {
        try {
          const r = await sourceService.diagnose(s, key)
          const failed = r.steps.find(x => !x.ok)
          await sourceService.markHealth(s.id, r.health, r.health === 1 ? '' : (failed?.detail || '')).catch(() => undefined)
        } catch (e) {
          await sourceService.markHealth(s.id, 3, (e as Error)?.message || '体检失败').catch(() => undefined)
        }
      }))
    } finally {
      checking.value = false
      await refresh()
    }
  }

  async function clearCache(): Promise<number> {
    return sourceService.clearOnlineChapterCache()
  }

  return {
    sources,
    networkEnabled,
    loaded,
    searching,
    checking,
    lastKey,
    hits,
    failures,
    onlineReady,
    enabledSources,
    load,
    refresh,
    setNetworkEnabled,
    importText,
    remove,
    toggle,
    saveRaw,
    searchOnline,
    clearResults,
    addToShelf,
    switchSource,
    checkOne,
    checkAll,
    clearCache,
  }
})
