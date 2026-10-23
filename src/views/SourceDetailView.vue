<script setup lang="ts">
/**
 * 单条书源的规则调试。
 *
 * 这一页就是命令行验证脚本的四段判定搬到浏览器里：站点改版时，用户能看出
 * 到底是搜索、详情、目录还是正文断了，并直接编辑原始 JSON 修规则。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSourceStore } from '@/stores/source'
import type { DiagnoseResult } from '@/utils/source/sourceService'
import { HEALTH_COLOR, HEALTH_LABEL } from '@/types/source'
import Icon from '@/components/Icon.vue'
import { alertDialog, confirmDialog } from '@/utils/dialog'

const route = useRoute()
const router = useRouter()
const store = useSourceStore()

const id = computed(() => String(route.query.id || ''))
const source = computed(() => store.sources.find(s => s.id === id.value))

const keyword = ref('小说')
const running = ref(false)
const result = ref<DiagnoseResult | null>(null)
const runError = ref('')

const editing = ref(false)
const rawText = ref('')
const saving = ref(false)

onMounted(async () => {
  await store.load()
})

function openEdit(): void {
  rawText.value = JSON.stringify(source.value?.raw ?? {}, null, 2)
  editing.value = true
}

async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  runError.value = ''
  result.value = null
  try {
    result.value = await store.checkOne(id.value, keyword.value.trim() || '小说')
  } catch (e) {
    runError.value = (e as Error).message || '运行失败'
  } finally {
    running.value = false
  }
}

async function saveEdit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const next = await store.saveRaw(id.value, rawText.value)
    editing.value = false
    if (next.id !== id.value) {
      await alertDialog({ title: '已保存', message: '书源地址已变更，旧记录已替换。', confirmText: '知道了' })
      router.replace({ name: 'sourceList' })
    }
  } catch (e) {
    await alertDialog({ title: '保存失败', message: (e as Error).message })
  } finally {
    saving.value = false
  }
}

async function toggleSource(): Promise<void> {
  const s = source.value
  if (!s) return
  try {
    await store.toggle(s.id, !s.enabled)
  } catch (e) {
    await alertDialog({ title: '操作失败', message: (e as Error).message })
  }
}

async function removeSource(): Promise<void> {
  const s = source.value
  if (!s) return
  const ok = await confirmDialog({
    title: '删除书源',
    message: `删除「${s.name}」？书架上的书会保留，但未缓存的章节将无法再抓取。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  await store.remove(s.id)
  router.replace({ name: 'sourceList' })
}
</script>

<template>
  <div class="src-detail">
    <header class="src-detail__header">
      <button class="src-detail__back" aria-label="返回" @click="router.back()">
        <Icon name="back" :size="24" :width="2" />
      </button>
      <span class="src-detail__title">{{ source?.name || '书源详情' }}</span>
      <button v-if="source" class="src-detail__action" @click="toggleSource">
        {{ source.enabled ? '停用' : '启用' }}
      </button>
    </header>

    <main v-if="source" class="src-detail__body">
      <div class="src-card">
        <div class="src-line">
          <span class="src-line__label">地址</span>
          <span class="src-line__value">{{ source.url }}</span>
        </div>
        <div class="src-line">
          <span class="src-line__label">状态</span>
          <span class="src-line__value">
            <span class="src-dot" :style="{ background: HEALTH_COLOR[source.health] || HEALTH_COLOR[0] }" />
            {{ HEALTH_LABEL[source.health] || '未检测' }}
            <template v-if="source.lastCheckAt">
              · {{ new Date(source.lastCheckAt).toLocaleString('zh-CN', { hour12: false }) }}
            </template>
          </span>
        </div>
        <div v-if="source.group" class="src-line">
          <span class="src-line__label">分组</span>
          <span class="src-line__value">{{ source.group }}</span>
        </div>
        <div v-if="source.lastError" class="src-line">
          <span class="src-line__label">上次错误</span>
          <span class="src-line__value src-line__value--error">{{ source.lastError }}</span>
        </div>
      </div>

      <div class="src-card">
        <div class="src-debug-head">
          <span class="src-card__title">规则调试</span>
        </div>
        <div class="src-debug-key">
          <input
            v-model="keyword"
            class="src-debug-input"
            placeholder="关键词"
            enterkeyhint="search"
            @keyup.enter="run"
          />
          <button class="src-debug-run" :disabled="running" @click="run">{{ running ? '运行中…' : '运行' }}</button>
        </div>

        <p v-if="runError" class="src-debug-error">{{ runError }}</p>

        <div v-if="result" class="src-steps">
          <div v-for="step in result.steps" :key="step.key" class="src-step">
            <span class="src-step__icon" :class="step.ok ? 'src-step__icon--ok' : 'src-step__icon--bad'">
              <Icon :name="step.ok ? 'check' : 'close'" :size="12" :width="2.6" />
            </span>
            <span class="src-step__text">
              <span class="src-step__label">{{ step.label }}</span>
              <span class="src-step__detail">{{ step.detail }}</span>
            </span>
          </div>
        </div>
      </div>

      <div class="src-card">
        <button class="src-edit" @click="openEdit">编辑原始 JSON</button>
      </div>

      <button class="src-remove" @click="removeSource">删除书源</button>
    </main>

    <main v-else class="src-detail__body">
      <p class="src-missing">书源不存在，可能已被删除。</p>
    </main>

    <!-- 原始 JSON 编辑 -->
    <div v-if="editing" class="src-mask" @click.self="editing = false">
      <div class="src-sheet">
        <div class="src-sheet__head">
          <span class="src-sheet__title">编辑书源 JSON</span>
          <button class="src-sheet__close" aria-label="关闭" @click="editing = false">
            <Icon name="close" :size="18" :width="2" />
          </button>
        </div>
        <textarea v-model="rawText" class="src-sheet__input" spellcheck="false" />
        <div class="src-sheet__actions">
          <button class="src-sheet__btn" @click="editing = false">取消</button>
          <button class="src-sheet__btn src-sheet__btn--primary" :disabled="saving" @click="saveEdit">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.src-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.src-detail__header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(8px + var(--safe-top)) 12px 8px;
  background: var(--bg-page);
  flex-shrink: 0;
}

.src-detail__back {
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

.src-detail__title {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.src-detail__action {
  position: absolute;
  right: 12px;
  bottom: 8px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
  padding: 6px 4px;
}

.src-detail__body {
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

.src-card {
  background: var(--bg-panel);
  border-radius: 12px;
  padding: 12px 16px;
  flex-shrink: 0;
}

.src-card__title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.src-line {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 6px 0;
  font-size: calc(13px * var(--app-font-scale));
}

.src-line__label {
  width: 64px;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.src-line__value {
  flex: 1;
  min-width: 0;
  color: var(--text);
  word-break: break-all;
  display: flex;
  align-items: center;
  gap: 6px;
}

.src-line__value--error {
  color: #E35B5B;
}

.src-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.src-debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.src-debug-key {
  display: flex;
  gap: 8px;
  align-items: center;
}

.src-debug-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--bg-page);
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text);
  user-select: text;
  -webkit-user-select: text;
}

.src-debug-run {
  height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--accent);
  font-size: calc(13px * var(--app-font-scale));
  color: #fff;
  flex-shrink: 0;
}

.src-debug-run:disabled {
  opacity: 0.5;
}

.src-debug-error {
  margin-top: 10px;
  font-size: calc(12px * var(--app-font-scale));
  color: #E35B5B;
  line-height: 1.6;
}

.src-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.src-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.src-step__icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  margin-top: 1px;
}

.src-step__icon--ok {
  background: #33B36B;
}

.src-step__icon--bad {
  background: #E35B5B;
}

.src-step__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.src-step__label {
  font-size: calc(13px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.src-step__detail {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.55;
  color: var(--text-secondary);
  word-break: break-all;
}

.src-edit {
  width: 100%;
  height: 44px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--accent);
}

.src-remove {
  height: 46px;
  border-radius: 10px;
  background: var(--bg-panel);
  font-size: calc(14px * var(--app-font-scale));
  color: #E35B5B;
  flex-shrink: 0;
}

.src-missing {
  padding: 40px 8px;
  text-align: center;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
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

.src-sheet__input {
  width: 100%;
  min-height: 260px;
  max-height: 46vh;
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
