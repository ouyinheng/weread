<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore, useBookmarkStore } from '@/stores'
import { useSourceStore } from '@/stores/source'
import { useTvStore } from '@/stores/tv'
import type { Highlight } from '@/types'
import { getAllReadingTime, formatDuration } from '@/utils/reading-time'
import { dbGetAll } from '@/utils/db'
import { storageIssues } from '@/utils/storage-errors'
import { migrationState } from '@/utils/storage/migrate'
import type { IconName } from '@/components/icon-names'
import Icon from '@/components/Icon.vue'

const router = useRouter()
const bookStore = useBookStore()
const bookmarkStore = useBookmarkStore()
const sourceStore = useSourceStore()
const tvStore = useTvStore()

const totalMs = ref(0)
const storageText = ref('—')
const quotaText = ref('')
/** Usage / quota, 0 when the platform does not report a quota. */
const storageRatio = ref(0)
const noteCount = ref(0)

const reading = computed(() => bookStore.books.filter(b => !b.finished && b.progress > 0).length)
const finished = computed(() => bookStore.books.filter(b => b.finished).length)
const bookmarks = computed(() => bookmarkStore.bookmarks.length)
const durationText = computed(() => (totalMs.value > 0 ? formatDuration(totalMs.value) : '—'))

interface StatItem {
  icon: IconName
  label: string
  value: string
  color: string
}

/**
 * The four counters WeRead puts in its 2×2 grid, mapped to data this build
 * actually owns: 笔记 counts highlights (划线/想法), 书签 counts bookmarks.
 * Empty states use WeRead's own wording instead of a bare zero.
 */
const stats = computed<StatItem[]>(() => [
  {
    icon: 'book-open',
    label: '在读',
    value: reading.value ? `${reading.value} 本` : '暂无在读的书',
    color: '#33B36B',
  },
  {
    icon: 'check-circle',
    label: '读完',
    value: finished.value ? `${finished.value} 本` : '暂无读完的书',
    color: '#2F8FEA',
  },
  {
    icon: 'note',
    label: '笔记',
    value: noteCount.value ? `${noteCount.value} 个` : '尚未留下笔记',
    color: '#2F8FEA',
  },
  {
    icon: 'bookmark',
    label: '书签',
    value: bookmarks.value ? `${bookmarks.value} 个` : '暂无书签',
    color: '#9B59D0',
  },
])

function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Report what the local database actually occupies instead of guessing. */
async function measureStorage() {
  try {
    const est = await navigator.storage?.estimate?.()
    if (est?.usage) {
      storageText.value = formatBytes(est.usage)
      // WebView 报的是整个源的配额；没有配额（部分老内核）就只显示用量。
      if (est.quota && est.quota > 0) {
        quotaText.value = formatBytes(est.quota)
        storageRatio.value = Math.min(1, est.usage / est.quota)
      }
      return
    }
  } catch {
    /* not supported */
  }

  try {
    const stores = [
      'books',
      'chapters',
      'files',
      'bookmarks',
      'highlights',
      'sessions',
      'sources',
      'daily',
    ] as const
    let total = 0
    for (const name of stores) {
      const rows = await dbGetAll(name)
      total += JSON.stringify(rows).length
    }
    storageText.value = formatBytes(total)
  } catch {
    storageText.value = '—'
  }
}

onMounted(async () => {
  await bookStore.loadBooks()
  await bookmarkStore.loadAll()
  await sourceStore.load()
  await tvStore.load()
  noteCount.value = (await dbGetAll<Highlight>('highlights')).length
  totalMs.value = await getAllReadingTime()
  await measureStorage()
})
</script>

<template>
  <div class="me tab-page">
    <main class="me__body">
      <div class="me__profile">
        <div class="me__avatar">
          <Icon name="person" :size="34" />
        </div>
        <div class="me__info">
          <span class="me__name">本地用户</span>
          <span class="me__desc">本地导入 · 无需登录</span>
        </div>
      </div>

      <div class="me__stats">
        <div v-for="s in stats" :key="s.label" class="me__card me__stat">
          <span class="me__stat-icon" :style="{ background: s.color }">
            <Icon :name="s.icon" :size="16" :width="2.2" />
          </span>
          <span class="me__stat-text">
            <span class="me__stat-label">{{ s.label }}</span>
            <span class="me__stat-value">{{ s.value }}</span>
          </span>
        </div>
      </div>

      <!-- 近 30 天阅读与存储引擎不在「我的」展示：数据仍在本地记录，只是不占首页。 -->

      <div class="me__card me__rows">
        <button
          class="me__row me__row--link"
          @click="router.push({ name: 'settings', query: { tab: 'reading' } })"
        >
          <span class="me__row-label">阅读设置</span>
          <Icon name="chevron-right" :size="17" :width="2" class="me__row-chevron" />
        </button>
        <button
          class="me__row me__row--link"
          @click="router.push({ name: 'settings', query: { tab: 'system' } })"
        >
          <span class="me__row-label">系统设置</span>
          <Icon name="chevron-right" :size="17" :width="2" class="me__row-chevron" />
        </button>
      </div>

      <div class="me__card me__rows">
        <div class="me__row">
          <span class="me__row-label">累计阅读</span>
          <span class="me__row-value" :class="{ 'me__row-value--accent': totalMs > 0 }">{{
            durationText
          }}</span>
        </div>
        <div class="me__row">
          <span class="me__row-label">本地占用</span>
          <span class="me__row-value">
            {{ storageText }}<template v-if="quotaText"> / {{ quotaText }}</template>
          </span>
        </div>
        <button class="me__row me__row--link" @click="router.push({ name: 'sourceList' })">
          <span class="me__row-label">书源管理</span>
          <span class="me__row-value">{{ sourceStore.sources.length }} 个</span>
          <Icon name="chevron-right" :size="17" :width="2" class="me__row-chevron" />
        </button>
        <button class="me__row me__row--link" @click="router.push({ name: 'tvSources' })">
          <span class="me__row-label">视频源管理</span>
          <span class="me__row-value">{{ tvStore.sources.length }} 个</span>
          <Icon name="chevron-right" :size="17" :width="2" class="me__row-chevron" />
        </button>
      </div>

      <div
        v-if="migrationState.busy || migrationState.completed || migrationState.error"
        class="me__card me__rows"
      >
        <div class="me__row">
          <span class="me__row-label">存储迁移</span>
          <span class="me__row-value" :class="{ 'me__row-value--accent': migrationState.completed }">
            {{
              migrationState.error
                ? `未完成：${migrationState.error}`
                : migrationState.completed
                  ? '已完成'
                  : `迁移中 ${migrationState.done}/${migrationState.total}`
            }}
          </span>
        </div>
      </div>

      <p v-if="storageRatio >= 0.8" class="me__warn">
        存储空间已用
        {{
          Math.round(storageRatio * 100)
        }}%。空间紧张时系统可能回收本地数据，建议先备份，再清理缓存或删除已读完的书。
      </p>

      <p v-if="storageIssues.length" class="me__warn">
        {{ storageIssues[0].message }}（本次运行中还有 {{ storageIssues.length }} 项存储问题，详见控制台）
      </p>

      <p class="me__note">数据仅保存在本机存储中，不上传任何服务器。</p>
    </main>
  </div>
</template>

<style scoped>
.me {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.me__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: calc(12px + var(--safe-top)) 20px calc(20px + var(--safe-bottom));
}

.me__profile {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 4px 16px;
}

.me__avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: var(--bg-panel);
}

.me__info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.me__name {
  font-size: calc(18px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.me__desc {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

.me__card {
  background: var(--bg-panel);
  border-radius: 12px;
  margin-bottom: 10px;
  overflow: hidden;
  flex-shrink: 0;
}

/* Four separate 72dp cards with a 10dp gutter, like WeRead's 2×2 grid. */
.me__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
  animation: contentIn 180ms var(--page-easing);
}

.me__stat {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 0 14px;
  margin-bottom: 0;
}

.me__stat-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}

.me__stat-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.me__stat-label {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 500;
  color: var(--text);
}

.me__stat-value {
  font-size: calc(11.5px * var(--app-font-scale));
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 30-day reading chart removed from this page; its styles went with it. */

.me__rows {
  padding: 0 14px;
}

.me__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 50px;
  gap: 12px;
  border-bottom: 0.5px solid var(--divider);
  text-align: left;
}

.me__row:last-child {
  border-bottom: none;
}

/* Row that navigates: keep the row look, drop the button chrome. */
.me__row--link {
  background: none;
  padding: 0;
  color: inherit;
}

.me__row--link:active {
  opacity: 0.55;
}

.me__row-chevron {
  color: var(--text-secondary);
  flex-shrink: 0;
  margin-left: -4px;
}

.me__row-label {
  /* Takes the free space so the value (e.g. 书源个数) sits next to the chevron
     on the right, not floating in the middle of the row. */
  flex: 1;
  min-width: 0;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.me__row-value {
  flex-shrink: 0;
  text-align: right;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
}

.me__row-value--accent {
  color: var(--accent);
  font-weight: 500;
}

.me__note {
  padding: 4px 4px 12px;
  font-size: calc(11px * var(--app-font-scale));
  line-height: 1.6;
  color: var(--text-secondary);
}

.me__warn {
  margin: 0 4px 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(230, 67, 64, 0.08);
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.6;
  color: #c0392b;
}
</style>
