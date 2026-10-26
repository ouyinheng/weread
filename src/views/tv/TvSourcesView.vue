<script setup lang="ts">
/**
 * 源管理。
 *
 * 三种入口，覆盖绝大多数用法：
 *  1. 手动添加：名称 + 苹果 CMS 接口地址；
 *  2. 粘贴导入：LibreTV / TVBox 的源列表 JSON；
 *  3. 测活：拉第一页，确认接口真的能用。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useTvStore } from '@/stores/tv'
import { testSource } from '@/utils/tv/cms'
import { confirmDialog } from '@/utils/dialog'
import type { TvSource } from '@/utils/tv/types'

const router = useRouter()
const store = useTvStore()

const name = ref('')
const api = ref('')
const notice = ref('')
const importText = ref('')
const showImport = ref(false)
const testing = ref<string>('')

onMounted(() => { void store.load() })

function flash(message: string): void {
  notice.value = message
  window.setTimeout(() => { if (notice.value === message) notice.value = '' }, 2500)
}

function add(): void {
  if (!api.value.trim()) {
    flash('先填接口地址')
    return
  }
  store.addSource(name.value, api.value)
  name.value = ''
  api.value = ''
  flash('已添加')
}

function remove(source: TvSource): Promise<void> {
  return confirmDialog({
    title: '删除源',
    message: `删除「${source.name}」？该源的观看记录也会一并清掉。`,
    confirmText: '删除',
    danger: true,
  }).then((ok) => {
    if (ok) store.removeSource(source.id)
  })
}

async function test(source: TvSource): Promise<void> {
  testing.value = source.id
  const result = await testSource(source)
  testing.value = ''
  flash(`${source.name}：${result.message}`)
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
  const push = (name: unknown, api: unknown) => {
    if (typeof api !== 'string') return
    if (!/^https?:\/\//i.test(api)) return
    out.push({ name: typeof name === 'string' ? name : undefined, api })
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

function doImport(): void {
  if (!importText.value.trim()) {
    flash('先粘贴 JSON')
    return
  }
  let list: Array<{ name?: string; api: string }>
  try {
    list = parseImport(importText.value)
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
  showImport.value = false
  flash(added ? `新增 ${added} 个源` : '这些源都已经在了')
}
</script>

<template>
  <div class="tv-src">
    <header class="tv-src__bar">
      <button class="tv-src__back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="22" :width="2" />
      </button>
      <span class="tv-src__title">源管理</span>
      <button class="tv-src__import-btn" @click="showImport = !showImport">
        {{ showImport ? '收起' : '导入' }}
      </button>
    </header>

    <main class="tv-src__body">
      <p v-if="notice" class="tv-src__notice">{{ notice }}</p>

      <section v-if="showImport" class="tv-src__card">
        <h2 class="tv-src__card-title">粘贴源列表</h2>
        <textarea
          v-model="importText"
          class="tv-src__textarea"
          rows="6"
          placeholder='支持 LibreTV 导出的 { "customAPIs": [...] }、TVBox 的 { "sites": [...] }，或 [{ "name": "...", "url": "..." }]'
        />
        <button class="tv-src__primary" @click="doImport">导入</button>
      </section>

      <section class="tv-src__card">
        <h2 class="tv-src__card-title">添加源</h2>
        <input v-model="name" class="tv-src__input" type="text" placeholder="名称（可空）" />
        <input
          v-model="api"
          class="tv-src__input"
          type="url"
          placeholder="https://example.com/api.php/provide/vod/"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
        />
        <button class="tv-src__primary" @click="add">添加</button>
        <p class="tv-src__hint">苹果 CMS V10 的接口根地址，通常以 <code>/api.php/provide/vod/</code> 结尾。</p>
      </section>

      <section class="tv-src__list">
        <div class="tv-src__list-head">
          <span class="tv-src__list-title">全部源</span>
          <span class="tv-src__list-count">{{ store.sources.length }} 个</span>
        </div>

        <p v-if="!store.sources.length" class="tv-src__empty">
          还没有源。手动添加，或从上面的「导入」粘贴一份源列表。
        </p>

        <div v-for="source in store.sources" :key="source.id" class="tv-src__row">
          <div class="tv-src__row-main">
            <div class="tv-src__row-head">
              <span class="tv-src__row-name">{{ source.name }}</span>
              <button
                class="toggle"
                :class="{ on: source.enabled }"
                role="switch"
                :aria-checked="source.enabled"
                @click="store.toggleSource(source.id)"
              >
                <span class="toggle__dot" />
              </button>
            </div>
            <span class="tv-src__row-api">{{ source.api }}</span>
            <div class="tv-src__row-actions">
              <button class="tv-src__action" :disabled="testing === source.id" @click="test(source)">
                {{ testing === source.id ? '测试中…' : '测活' }}
              </button>
              <button class="tv-src__action tv-src__action--danger" @click="remove(source)">删除</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.tv-src {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.tv-src__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: calc(8px + var(--safe-top)) 10px 8px;
  background: var(--bg-page);
}
.tv-src__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  background: transparent;
  color: var(--text);
}
.tv-src__title { flex: 1; font-size: 16px; font-weight: 600; color: var(--text); }
.tv-src__import-btn {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-family: inherit;
  padding: 6px 4px;
}

.tv-src__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 14px calc(24px + var(--safe-bottom));
}

.tv-src__notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
}

.tv-src__card {
  margin-bottom: 14px;
  padding: 14px;
  border-radius: 10px;
  background: var(--bg);
}
.tv-src__card-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.tv-src__input,
.tv-src__textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 9px 10px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.tv-src__input:focus,
.tv-src__textarea:focus { border-color: var(--accent); }
.tv-src__textarea { resize: vertical; line-height: 1.5; }
.tv-src__primary {
  width: 100%;
  height: 38px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--text-inverse);
  font-size: 14px;
  font-family: inherit;
}
.tv-src__primary:active { background: var(--accent-press); }
.tv-src__hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.tv-src__hint code {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-secondary);
}

.tv-src__list { margin-top: 4px; }
.tv-src__list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 0 2px;
}
.tv-src__list-title { font-size: 14px; font-weight: 600; color: var(--text); }
.tv-src__list-count { font-size: 11px; color: var(--text-secondary); }
.tv-src__empty {
  margin: 0;
  padding: 18px 12px;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}

.tv-src__row {
  margin-bottom: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg);
}
.tv-src__row-main { min-width: 0; }
.tv-src__row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tv-src__row-name {
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-src__row-api {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-src__row-actions { display: flex; gap: 8px; margin-top: 10px; }
.tv-src__action {
  border: 1px solid var(--divider);
  border-radius: 14px;
  padding: 4px 12px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.tv-src__action--danger { color: #d9534f; }
.tv-src__action:disabled { opacity: 0.5; }

.toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 26px;
  border: 0;
  border-radius: 13px;
  padding: 2px;
  background: var(--divider);
  display: flex;
  align-items: center;
  transition: background-color 0.18s ease;
}
.toggle.on { background: var(--accent); }
.toggle__dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  transform: translateX(0);
  transition: transform 0.18s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.toggle.on .toggle__dot { transform: translateX(18px); }
</style>
