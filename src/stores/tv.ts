/**
 * 影视模块的全局状态：源列表 + 观看记录。
 *
 * 刻意不写进书库的 settings 表：
 *  - 影视与阅读是两个互不依赖的功能，数据生命周期也不一样（换机、清空书库
 *    都不该牵连视频源）；
 *  - 书库备份是「整库 zip」，混进去会让备份体积和恢复语义都变复杂。
 * 因此用独立的 localStorage 键，模块内部自洽，删掉整个 `src/utils/tv` +
 * `src/views/tv` + 本文件也不会影响书库。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { normalizeApi } from '@/utils/tv/parse'
import type { TvHistoryEntry, TvSource } from '@/utils/tv/types'

const STORAGE_KEY = 'weread.tv.v1'
const MAX_HISTORY = 30

interface PersistedTv {
  sources: TvSource[]
  history: TvHistoryEntry[]
}

function newId(): string {
  return `tv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const useTvStore = defineStore('tv', () => {
  const sources = ref<TvSource[]>([])
  const history = ref<TvHistoryEntry[]>([])
  const loaded = ref(false)

  const enabledSources = computed(() => sources.value.filter(s => s.enabled))

  async function load(): Promise<void> {
    if (loaded.value) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const saved = raw ? (JSON.parse(raw) as PersistedTv) : null
      if (saved) {
        sources.value = Array.isArray(saved.sources) ? saved.sources : []
        history.value = Array.isArray(saved.history) ? saved.history : []
      }
    } catch {
      // 数据损坏时回到空列表，不让影视模块影响启动。
      sources.value = []
      history.value = []
    }
    loaded.value = true
  }

  function persist(): void {
    try {
      const data: PersistedTv = { sources: sources.value, history: history.value }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // 配额满/隐私模式：本次会话内仍然可用。
    }
  }

  function addSource(name: string, api: string): TvSource {
    const source: TvSource = {
      id: newId(),
      name: name.trim() || '未命名源',
      api: normalizeApi(api),
      enabled: true,
      addedAt: Date.now(),
    }
    sources.value.push(source)
    persist()
    return source
  }

  function updateSource(id: string, patch: Partial<Pick<TvSource, 'name' | 'api' | 'enabled'>>): void {
    const source = sources.value.find(s => s.id === id)
    if (!source) return
    Object.assign(source, patch)
    if (patch.api !== undefined) source.api = normalizeApi(patch.api)
    persist()
  }

  function removeSource(id: string): void {
    sources.value = sources.value.filter(s => s.id !== id)
    history.value = history.value.filter(h => h.sourceId !== id)
    persist()
  }

  function toggleSource(id: string): void {
    const source = sources.value.find(s => s.id === id)
    if (!source) return
    source.enabled = !source.enabled
    persist()
  }

  /** 导入源列表；返回真正新增的条数（按接口地址去重）。 */
  function importSources(list: Array<{ name?: string; api: string }>): number {
    const seen = new Set(sources.value.map(s => s.api))
    let added = 0
    for (const item of list) {
      const api = normalizeApi(item.api)
      if (!api || seen.has(api)) continue
      seen.add(api)
      sources.value.push({
        id: newId(),
        name: String(item.name || '').trim() || `源 ${sources.value.length + 1}`,
        api,
        enabled: true,
        addedAt: Date.now(),
      })
      added++
    }
    if (added) persist()
    return added
  }

  function recordHistory(entry: TvHistoryEntry): void {
    history.value = [entry, ...history.value.filter(h => h.key !== entry.key)].slice(0, MAX_HISTORY)
    persist()
  }

  function historyOf(sourceId: string, vodId: string): TvHistoryEntry | undefined {
    return history.value.find(h => h.sourceId === sourceId && h.vodId === vodId)
  }

  function clearHistory(): void {
    history.value = []
    persist()
  }

  return {
    sources,
    history,
    loaded,
    enabledSources,
    load,
    addSource,
    updateSource,
    removeSource,
    toggleSource,
    importSources,
    recordHistory,
    historyOf,
    clearHistory,
  }
})
