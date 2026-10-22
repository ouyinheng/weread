<script setup lang="ts">
/**
 * 笔记 sheet — matches WeRead's layout:
 *
 *  - a segmented control at the top: 笔记 / 热门划线
 *  - a summary card: position, reading time, and the cover thumbnail
 *  - a row of four quick actions
 *  - the empty state explains what can be recorded here
 *
 * Local-first, so 热门划线 has no server data: the tab exists and renders an
 * honest empty state rather than pretending to have community highlights.
 */
import { computed, ref } from 'vue'
import type { Book, Bookmark, Chapter, Highlight } from '@/types'
import Icon from '@/components/Icon.vue'
import BookCover from '@/components/BookCover.vue'
import type { IconName } from '@/components/icon-names'
import { alertDialog } from '@/utils/dialog'

const props = defineProps<{
  bookmarks: Bookmark[]
  /** 划线 / 想法 ranges saved in the reading page. */
  highlights: Highlight[]
  chapters: Chapter[]
  isBookmarked: boolean
  percentText?: string
  readingTimeText?: string
  cover?: string | null
  bookTitle?: string
}>()

const emit = defineEmits<{
  jump: [chapterIndex: number, charOffset: number]
  toggle: []
  remove: [id: string]
  removeHighlight: [id: string]
  close: []
  stats: []
}>()

const tab = ref<'notes' | 'popular'>('notes')
const searchOpen = ref(false)
const searchQuery = ref('')

/** Stand-in book record so BookCover can draw its generated chip. */
const coverFallback = computed<Book>(() => ({
  id: '',
  title: props.bookTitle || '书',
  author: '',
  format: 'txt',
  cover: null,
  wordCount: 0,
  fileSize: 0,
  importedAt: 0,
  lastReadAt: 0,
  progress: 0,
  lastChapterIndex: 0,
  lastCharOffset: 0,
  finished: false,
}))

/** One row in the list: a bookmark or a 划线/想法, in one shape. */
interface NoteRow {
  id: string
  kind: 'bookmark' | 'highlight'
  chapterIndex: number
  charOffset: number
  text: string
  note: string
  createdAt: number
}

const rows = computed<NoteRow[]>(() => {
  const list: NoteRow[] = [
    ...props.bookmarks.map(b => ({
      id: b.id,
      kind: 'bookmark' as const,
      chapterIndex: b.chapterIndex,
      charOffset: b.charOffset,
      text: b.excerpt || '（无摘录）',
      note: '',
      createdAt: b.createdAt,
    })),
    ...props.highlights.map(h => ({
      id: h.id,
      kind: 'highlight' as const,
      chapterIndex: h.chapterIndex,
      charOffset: h.start,
      text: h.text,
      note: h.note,
      createdAt: h.createdAt,
    })),
  ].sort((a, b) => b.createdAt - a.createdAt)
  const q = searchQuery.value.trim()
  if (!q) return list
  return list.filter(
    r => r.text.includes(q) || r.note.includes(q) || chapterTitle(r.chapterIndex).includes(q)
  )
})

/**
 * Four real actions. Anything that cannot work offline is not offered: WeRead's
 * 「连接纸书」needs a physical-copy code and its cloud, so it is replaced with
 * 添加书签, which is the thing this panel can actually do.
 */
const actions = computed<{ icon: IconName; label: string; run: () => void }[]>(() => [
  { icon: 'bookmark', label: props.isBookmarked ? '取消书签' : '添加书签', run: () => emit('toggle') },
  { icon: 'search', label: '搜索笔记', run: () => { searchOpen.value = !searchOpen.value } },
  { icon: 'share', label: '导出笔记', run: exportNotes },
  { icon: 'progress', label: '阅读统计', run: () => emit('stats') },
])

/** Export this book's notes as a plain-text file (the only honest "export"). */
function exportNotes() {
  if (!rows.value.length) {
    void alertDialog({
      title: '导出笔记',
      message: '还没有笔记可以导出。',
      confirmText: '知道了',
    })
    return
  }
  const lines = rows.value.map((r, i) => {
    const when = new Date(r.createdAt).toLocaleString()
    const kind = r.kind === 'highlight' ? (r.note ? '想法' : '划线') : '书签'
    const note = r.note ? `\n   想法：${r.note}` : ''
    return `${i + 1}. [${kind}] ${chapterTitle(r.chapterIndex)} · ${when}\n   ${r.text}${note}`
  })
  const text = `${props.bookTitle || '笔记'} · ${rows.value.length} 条\n\n${lines.join('\n\n')}\n`
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(props.bookTitle || 'notes').replace(/[\\/:*?"<>|]/g, '_')}-笔记.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function chapterTitle(index: number): string {
  return props.chapters[index]?.title || `第${index + 1}章`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div class="notes-mask" @click.self="emit('close')">
    <div class="notes">
      <div class="notes__grabber" />

      <!-- Segmented tabs -->
      <div class="notes__segmented">
        <button
          class="notes__segment"
          :class="{ 'notes__segment--on': tab === 'notes' }"
          @click="tab = 'notes'"
        >笔记</button>
        <button
          class="notes__segment"
          :class="{ 'notes__segment--on': tab === 'popular' }"
          @click="tab = 'popular'"
        >热门划线</button>
      </div>

      <!-- Search field appears only when the user asks for it. -->
      <div v-if="searchOpen" class="notes__search">
        <Icon name="search" :size="15" />
        <input v-model="searchQuery" placeholder="搜索摘录或章节名" @keydown.esc="searchOpen = false" />
        <button class="notes__search-close" @click="searchOpen = false; searchQuery = ''">
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div class="notes__body">
        <!-- Summary card -->
        <div class="notes__card">
          <div class="notes__summary">
            <div class="notes__summary-main">
              <span class="notes__book">{{ bookTitle || '当前书籍' }}</span>
              <span class="notes__meta-line">
                <Icon name="chevron-right" :size="13" :width="2" />
                <span>已读到 {{ percentText || '0%' }}</span>
              </span>
              <span class="notes__meta-line">
                <Icon name="sort-down" :size="15" />
                <span>时长 {{ readingTimeText || '不足 1 分钟' }}</span>
                <button class="notes__link" @click="emit('stats')">阅读明细</button>
              </span>
            </div>
            <!-- Real cover when the book carries one; the generated chip otherwise,
                 so the card is never half empty. -->
            <div class="notes__cover">
              <img v-if="cover" :src="cover" alt="" />
              <BookCover v-else :book="coverFallback" compact />
            </div>
          </div>

          <div class="notes__actions">
            <button v-for="a in actions" :key="a.label" class="notes__action" @click="a.run">
              <Icon :name="a.icon" :size="22" />
              <span>{{ a.label }}</span>
            </button>
          </div>
        </div>

        <!-- Saved notes: bookmarks and 划线/想法, newest first -->
        <div v-if="tab === 'notes' && rows.length" class="notes__list">
          <div v-for="row in rows" :key="row.id" class="notes__row">
            <button class="notes__row-main" @click="emit('jump', row.chapterIndex, row.charOffset)">
              <span class="notes__row-chapter">
                <i v-if="row.kind === 'highlight'" class="notes__row-kind">{{ row.note ? '想法' : '划线' }}</i>
                {{ chapterTitle(row.chapterIndex) }}
              </span>
              <span class="notes__row-excerpt">{{ row.text }}</span>
              <span v-if="row.note" class="notes__row-note">{{ row.note }}</span>
              <span class="notes__row-time">{{ formatDate(row.createdAt) }}</span>
            </button>
            <button
              class="notes__row-del"
              aria-label="删除"
              @click="row.kind === 'highlight' ? emit('removeHighlight', row.id) : emit('remove', row.id)"
            >
              <Icon name="close" :size="16" />
            </button>
          </div>
        </div>

        <!-- Empty states, one per tab -->
        <div v-else class="notes__card notes__empty">
          <p v-if="tab === 'notes'">
            你可以在这里记录本书的<br />想法、划线、书签
          </p>
          <p v-else>
            这本书还没有热门划线<br />本地书籍不联网，暂无社区划线
          </p>
          <button class="notes__link" @click="emit('toggle')">
            {{ isBookmarked ? '查看我的全部笔记' : '添加第一条书签' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notes-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.35);
  animation: maskIn 180ms ease-out;
}

@keyframes maskIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.notes {
  width: 100%;
  height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  border-radius: 16px 16px 0 0;
  padding-bottom: var(--safe-bottom);
  animation: sheetUp 260ms var(--page-easing);
}

@keyframes sheetUp {
  from { transform: translate3d(0, 100%, 0); }
  to { transform: translate3d(0, 0, 0); }
}

.notes__grabber {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(120, 120, 128, 0.35);
  margin: 8px auto 8px;
  flex-shrink: 0;
}

/* Segmented control with a raised white pill */
.notes__segmented {
  display: flex;
  margin: 0 14px 12px;
  height: 40px;
  padding: 3px;
  border-radius: 20px;
  background: rgba(120, 120, 128, 0.12);
  flex-shrink: 0;
}

.notes__segment {
  flex: 1;
  border-radius: 17px;
  font-size: calc(14px * var(--app-font-scale));
  color: var(--text-secondary);
  transition: background-color 160ms, color 160ms, box-shadow 160ms;
}

.notes__segment--on {
  background: #fff;
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.notes__search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 14px 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: 17px;
  background: rgba(120, 120, 128, 0.12);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.notes__search input {
  flex: 1;
  min-width: 0;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text);
}

.notes__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 14px 14px;
}

.notes__card {
  background: var(--bg-panel);
  border-radius: 12px;
  margin-bottom: 12px;
  overflow: hidden;
}

.notes__summary {
  display: flex;
  gap: 12px;
  padding: 16px;
}

.notes__summary-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}

.notes__book {
  font-size: calc(17px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes__meta-line {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--text-secondary);
}

.notes__link {
  margin-left: 2px;
  font-size: calc(13px * var(--app-font-scale));
  color: var(--accent);
}

.notes__cover {
  width: 56px;
  height: 77px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(120, 120, 128, 0.12);
}

.notes__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* The generated chip fills the same box the photo would. */
.notes__cover :deep(.cover) {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  border-radius: 0;
  box-shadow: none;
}

.notes__actions {
  display: flex;
  border-top: 0.5px solid var(--divider);
  padding: 10px 0 12px;
}

.notes__action {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
  padding: 4px 0;
}

.notes__list {
  background: var(--bg-panel);
  border-radius: 12px;
  overflow: hidden;
}

.notes__row {
  display: flex;
  align-items: center;
  border-bottom: 0.5px solid var(--divider);
}

.notes__row:last-child {
  border-bottom: none;
}

.notes__row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  text-align: left;
  min-width: 0;
}

.notes__row-chapter {
  font-size: calc(12px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.notes__row-excerpt {
  font-size: calc(13px * var(--app-font-scale));
  line-height: 1.5;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.notes__row-kind {
  font-style: normal;
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: calc(10px * var(--app-font-scale));
  line-height: 1.5;
  color: var(--accent);
  background: var(--accent-soft);
}
.notes__row-note {
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.5;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notes__row-time {
  font-size: calc(11px * var(--app-font-scale));
  color: var(--text-secondary);
}

.notes__row-del {
  flex-shrink: 0;
  padding: 10px 14px;
  color: var(--text-secondary);
}

.notes__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
}

.notes__empty p {
  font-size: calc(14px * var(--app-font-scale));
  line-height: 1.7;
  color: var(--text-secondary);
}
</style>
