<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onDeactivated, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore } from '@/stores'
import type { Book } from '@/types'
import BookCover from '@/components/BookCover.vue'
import Icon from '@/components/Icon.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import { openBookTransition } from '@/utils/open-book-transition'
import type { SharedElementHandle } from '@/utils/open-book-transition'
import { pickAndImport } from '@/utils/importer'
import { confirmDialog } from '@/utils/dialog'
import { uiState } from '@/utils/ui-state'

// 组件名对上 App.vue 的 keep-alive include，tab 页面才不会一返回就整页重建。
defineOptions({ name: 'shelf' })

/** In-flight open animation; cancelled if the user taps another book. */
let openAnim: SharedElementHandle | null = null

const router = useRouter()
const store = useBookStore()

type SortKey = 'recent' | 'name' | 'progress' | 'words' | 'author' | 'imported' | 'format'

/**
 * Same order WeRead uses, minus 推荐值 (there is no recommendation engine
 * behind local books) and with 作者 kept as a useful extra. 分类 sorts by
 * container format — the one classification a local library really has.
 */
const sortTabs: { key: SortKey; label: string }[] = [
  { key: 'recent', label: '默认' },
  { key: 'imported', label: '更新' },
  { key: 'progress', label: '进度' },
  { key: 'name', label: '书名' },
  { key: 'format', label: '分类' },
  { key: 'words', label: '字数' },
  { key: 'author', label: '作者' },
]
const sortKey = ref<SortKey>('recent')

const sortedBooks = computed(() => {
  const list = [...store.books]
  switch (sortKey.value) {
    case 'name': return list.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
    case 'author': return list.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh'))
    case 'progress': return list.sort((a, b) => b.progress - a.progress)
    case 'words': return list.sort((a, b) => b.wordCount - a.wordCount)
    case 'imported': return list.sort((a, b) => b.importedAt - a.importedAt)
    case 'format': return list.sort((a, b) => a.format.localeCompare(b.format) || a.title.localeCompare(b.title, 'zh'))
    default: return list.sort((a, b) => b.lastReadAt - a.lastReadAt)
  }
})

/** Multi-select mode; WeRead's 「选择」 toggles bulk actions on the shelf. */
const selectMode = ref(false)
const selected = ref<Set<string>>(new Set())

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = new Set()
}

function toggleSelected(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

/** Select-mode replaces the tab bar with its own action bar. */
watch(selectMode, (on) => {
  uiState.hideTabBar = on
  if (!on) selected.value = new Set()
})

/** Leaving the shelf (tab switch, navigation) must not leave the bar hidden. */
onDeactivated(() => {
  uiState.hideTabBar = false
  selectMode.value = false
})
onBeforeUnmount(() => { uiState.hideTabBar = false })

/**
 * Open a book with the standard "cover grows into the page" motion.
 *
 * The navigation is issued immediately and runs *under* the flying clone, so
 * the reader is already rendering when the cover lands — that is what keeps the
 * handoff free of a blank frame.
 */
function openBook(id: string, event?: MouseEvent) {
  const item = (event?.currentTarget as HTMLElement | null)?.closest('.shelf__item')
  const coverEl = item?.querySelector('.shelf__cover') as HTMLElement | null

  openAnim?.cancel()

  const anim = openBookTransition(coverEl, {
    background: 'var(--bg-page)',
    duration: 320,
    // Navigate once the card covers the viewport: the router swap then happens
    // behind the animation instead of competing with its first frames.
    onCovered: () => router.push({ name: 'reader', params: { id } }),
  })
  openAnim = anim

  // No animation available (reduced motion / no cover node): navigate directly.
  if (!anim) router.push({ name: 'reader', params: { id } })

  anim?.done.then(() => { if (openAnim === anim) openAnim = null })
}

/**
 * 导入 opens the system file picker immediately.
 *
 * There is deliberately no intermediate sheet or page: with a single import
 * channel (local files) those steps existed only to host a button, and a route
 * hop also breaks the file dialog, which only opens inside the tap's gesture.
 * Every imported book stays on the shelf; the user chooses when to read it.
 */
function importFromDevice() {
  // Imported books land on the shelf; opening one is the user's next choice.
  pickAndImport()
}

/* ---------- book context menu ---------- */
const menuBook = ref<Book | null>(null)
let pressTimer: ReturnType<typeof setTimeout> | null = null

function onItemPressStart(book: Book) {
  // In select mode a long press would fight the tap that toggles the tick.
  if (selectMode.value) return
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => { menuBook.value = book }, 460)
}
function onItemPressEnd() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
}
function openBookMenu(book: Book) {
  if (selectMode.value) return
  menuBook.value = book
}

function formatWords(n: number): string {
  if (!n) return '0 字'
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  return `${n} 字`
}

async function restartBook(id: string) {
  await store.updateBook(id, { lastChapterIndex: 0, lastCharOffset: 0, progress: 0, finished: false })
  menuBook.value = null
  router.push({ name: 'reader', params: { id } })
}

async function confirmDelete(book: Book) {
  const ok = await confirmDialog({
    title: '移出书架',
    message: `确定将《${book.title}》移出书架？\n阅读进度与书签也会被删除。`,
    confirmText: '移出',
    danger: true,
  })
  if (!ok) return
  await store.removeBook(book.id)
  menuBook.value = null
}

/* ---------- bulk actions (select mode) ---------- */
const allSelected = computed(
  () => sortedBooks.value.length > 0 && sortedBooks.value.every(b => selected.value.has(b.id))
)

function toggleSelectAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(sortedBooks.value.map(b => b.id))
}

async function removeSelected() {
  const ids = [...selected.value]
  if (!ids.length) return
  const ok = await confirmDialog({
    title: '移出书架',
    message: `确定将选中的 ${ids.length} 本书移出书架？\n阅读进度与书签也会被删除。`,
    confirmText: '移出',
    danger: true,
  })
  if (!ok) return
  // One at a time: each removal also clears that book's chapters, bookmarks and
  // reading sessions, and the store updates reactively between iterations.
  for (const id of ids) await store.removeBook(id)
  selected.value = new Set()
  selectMode.value = false
}

onMounted(() => {
  store.loadBooks()
})
</script>

<template>
  <div class="shelf tab-page" :class="{ 'shelf--selecting': selectMode }">
    <header class="shelf__header">
      <div class="shelf__search" @click="router.push({ name: 'search' })">
        <Icon name="search" :size="17" />
        <span class="shelf__search-text">搜本书</span>
        <span class="shelf__search-divider" />
        <button class="shelf__search-store" @click.stop="router.push({ name: 'search' })">书城</button>
      </div>
    </header>

    <!-- Title row: WeRead keeps 「书架」 on the left and the two actions right. -->
    <div class="shelf__bar">
      <span v-if="selectMode" class="shelf__title shelf__title--selecting">
        已选 {{ selected.size }} 本
      </span>
      <span v-else class="shelf__title">书架</span>
      <div class="shelf__bar-actions">
        <button v-if="!selectMode" class="shelf__bar-btn" @click="importFromDevice">
          <Icon name="plus-circle" :size="18" />
          <span>导入</span>
        </button>
        <button class="shelf__bar-btn" @click="toggleSelectMode">
          <Icon name="check-circle" :size="18" />
          <span>{{ selectMode ? '完成' : '选择' }}</span>
        </button>
      </div>
    </div>

    <div class="shelf__tabs">
      <button
        v-for="t in sortTabs"
        :key="t.key"
        class="shelf__tab"
        :class="{ 'shelf__tab--active': sortKey === t.key }"
        @click="sortKey = t.key"
      >{{ t.label }}</button>
    </div>

    <main class="shelf__body">
      <div v-if="store.loading && store.books.length === 0" class="shelf__loading">
        <LoadingDots />
        <span>正在加载书架</span>
      </div>

      <div v-else-if="store.books.length === 0" class="shelf__empty">
        <div class="shelf__empty-icon">
          <Icon name="book" :size="46" :width="1.2" />
        </div>
        <p class="shelf__empty-title">书架空空如也</p>
        <p class="shelf__empty-desc">点击「导入」选择手机里的 txt / epub</p>
        <button class="shelf__empty-btn" @click="importFromDevice">导入书籍</button>
      </div>

      <div v-else class="shelf__grid">
        <div
          v-for="book in sortedBooks"
          :key="book.id"
          class="shelf__item"
          :class="{ 'shelf__item--selected': selected.has(book.id) }"
          @click="selectMode ? toggleSelected(book.id) : openBook(book.id, $event)"
          @touchstart.passive="onItemPressStart(book)"
          @touchend.passive="onItemPressEnd"
          @touchmove.passive="onItemPressEnd"
          @contextmenu.prevent="openBookMenu(book)"
        >
          <div class="shelf__cover">
            <BookCover :book="book" />
            <span v-if="book.finished" class="shelf__badge">已读完</span>
            <span v-else-if="book.progress > 0" class="shelf__badge shelf__badge--progress">
              {{ Math.round(book.progress) }}%
            </span>
          </div>
          <span class="shelf__item-title">{{ book.title }}</span>
        </div>

        <!-- WeRead closes the grid with an "add" cell. -->
        <button class="shelf__add" @click="importFromDevice" aria-label="导入书籍">
          <span class="shelf__add-glyph">+</span>
        </button>
      </div>

      <div v-if="store.books.length" class="shelf__foot">
        {{ store.books.length }} 本 · 全部本地保存
      </div>
    </main>

    <!-- Book context menu -->
    <div v-if="menuBook" class="mask" @click.self="menuBook = null">
      <div class="sheet">
        <div class="sheet__header">
          <span class="sheet__title">{{ menuBook.title }}</span>
          <span class="sheet__meta">{{ menuBook.author || '未知作者' }} · {{ formatWords(menuBook.wordCount) }}</span>
        </div>
        <button class="sheet__item" @click="openBook(menuBook.id); menuBook = null">继续阅读</button>
        <button class="sheet__item" @click="restartBook(menuBook.id)">从头开始</button>
        <button class="sheet__item sheet__item--danger" @click="confirmDelete(menuBook)">移出书架</button>
        <div class="sheet__gap" />
        <button class="sheet__item sheet__item--cancel" @click="menuBook = null">取消</button>
      </div>
    </div>

    <!-- Bulk action bar: takes the tab bar's place while selecting. -->
    <div v-if="selectMode" class="shelf-actions">
      <button class="shelf-actions__btn" @click="toggleSelectAll">
        <span class="shelf-actions__check" :class="{ 'shelf-actions__check--on': allSelected }">
          <Icon v-if="allSelected" name="check" :size="12" :width="2.6" />
        </span>
        <span>{{ allSelected ? '取消全选' : '全选' }}</span>
      </button>
      <button
        class="shelf-actions__btn shelf-actions__btn--danger"
        :disabled="selected.size === 0"
        @click="removeSelected"
      >移出书架</button>
      <button class="shelf-actions__btn" @click="toggleSelectMode">取消</button>
    </div>
  </div>
</template>

<style scoped>
.shelf {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

/* ---------- header ---------- */
.shelf__header {
  display: flex;
  align-items: center;
  gap: 12px;
  /* WeRead leaves ~30dp between the status bar and the search field. */
  padding: calc(30px + var(--safe-top)) 20px 8px;
  flex-shrink: 0;
}

.shelf__search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  /* WeRead's search field is a translucent grey pill on the page canvas. */
  background: rgba(120, 120, 128, 0.12);
  border-radius: 8px;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text-secondary);
  min-width: 0;
}

.shelf__search-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}

.shelf__search-divider {
  width: 1px;
  height: 15px;
  background: rgba(120, 120, 128, 0.3);
  flex-shrink: 0;
}

.shelf__search-store {
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
  padding-left: 2px;
  flex-shrink: 0;
}

/* ---------- title row ---------- */
.shelf__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px 2px;
  flex-shrink: 0;
}

.shelf__title {
  /* Measured from the reference: ink box 53px @3x → a 20px face at 600. */
  font-size: calc(20px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text-title);
}

.shelf__title--selecting {
  color: var(--text);
}

.shelf__bar-actions {
  display: flex;
  align-items: center;
  gap: 18px;
}

.shelf__bar-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

/* ---------- sort tabs ---------- */
.shelf__tabs {
  display: flex;
  gap: 22px;
  padding: 4px 20px 10px;
  overflow-x: auto;
  flex-shrink: 0;
}

.shelf__tab {
  position: relative;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text-secondary);
  white-space: nowrap;
  padding: 4px 0 6px;
  transition: color 140ms ease-out;
}

/* WeRead marks the active sort with colour alone, not an underline. */
.shelf__tab--active {
  color: var(--accent);
}

/* ---------- body ---------- */
.shelf__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px 20px calc(16px + var(--safe-bottom));
}

.shelf__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* 20dp gutters and a taller row gap, matching WeRead's shelf grid. */
  gap: 32px 20px;
  animation: contentIn 180ms var(--page-easing);
}

/* The "add" cell that closes WeRead's grid: a plain card with a plus. */
.shelf__add {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 2 / 3;
  /* Grid items stretch to the row height by default, which made this card
     extend down past the covers into the title row. Keep it cover-height. */
  align-self: start;
  justify-self: stretch;
  border-radius: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--divider);
}
.shelf__add-glyph {
  font-size: calc(34px * var(--app-font-scale));
  font-weight: 300;
  line-height: 1;
  color: var(--text-secondary);
}

.shelf__item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.shelf__cover {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  transition: transform 140ms ease-out;
}

/* Selected state in multi-select mode. */
.shelf__item--selected .shelf__cover {
  box-shadow: 0 0 0 2.5px var(--accent);
}

.shelf__item:active .shelf__cover {
  transform: scale(0.96);
}

.shelf__badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: calc(10px * var(--app-font-scale));
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  backdrop-filter: blur(2px);
}

.shelf__badge--progress {
  background: var(--accent);
}

.shelf__item-title {
  /* The reference's cover captions are 12sp, a step below the 14px body. */
  font-size: calc(12px * var(--app-font-scale));
  line-height: 1.35;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.shelf__foot {
  padding: 26px 0 8px;
  text-align: center;
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
}

/* ---------- bulk action bar ---------- */
.shelf-actions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  height: calc(var(--tabbar-height) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background: var(--bg-panel);
  border-top: 0.5px solid var(--divider);
  animation: actionsUp 180ms var(--page-easing);
}

@keyframes actionsUp {
  from { transform: translate3d(0, 100%, 0); }
  to { transform: translate3d(0, 0, 0); }
}

.shelf-actions__btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  font-size: calc(15px * var(--app-font-scale));
  color: var(--text);
}

.shelf-actions__btn--danger {
  color: #e64340;
}

.shelf-actions__btn:disabled {
  color: var(--text-secondary);
  opacity: 0.5;
}

/* The tick in WeRead's select bar is a filled square when everything is picked. */
.shelf-actions__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.4px solid var(--text-secondary);
  color: #fff;
}

.shelf-actions__check--on {
  background: var(--accent);
  border-color: var(--accent);
}

/* Keep the last row clear of the action bar. */
.shelf--selecting .shelf__body {
  padding-bottom: calc(66px + var(--safe-bottom));
}

/* ---------- empty ---------- */
.shelf__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 96px 24px 0;
  color: var(--text-secondary);
  font-size: calc(13px * var(--app-font-scale));
  animation: contentIn 180ms var(--page-easing);
}

.shelf__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 96px 24px 0;
  color: var(--text-secondary);
}

.shelf__empty-icon {
  color: var(--text-secondary);
  opacity: 0.5;
  margin-bottom: 4px;
}

.shelf__empty-title {
  font-size: calc(16px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
}

.shelf__empty-desc {
  font-size: calc(13px * var(--app-font-scale));
}

.shelf__empty-btn {
  margin-top: 14px;
  height: 38px;
  padding: 0 26px;
  border-radius: 19px;
  background: var(--accent);
  color: var(--text-inverse);
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 500;
  transition: background-color 120ms;
}

.shelf__empty-btn:active {
  background: var(--accent-press);
  opacity: 1;
}

/* ---------- bottom sheet ---------- */
.mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.4);
  animation: maskIn 180ms ease-out;
}

@keyframes maskIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sheet {
  width: 100%;
  padding: 0 10px calc(10px + var(--safe-bottom));
  background: var(--bg-page);
  border-radius: 16px 16px 0 0;
  animation: sheetUp 240ms var(--page-easing);
}

@keyframes sheetUp {
  from { transform: translate3d(0, 100%, 0); }
  to { transform: translate3d(0, 0, 0); }
}

.sheet__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 16px 16px;
  text-align: center;
}

.sheet__title {
  font-size: calc(15px * var(--app-font-scale));
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet__meta {
  font-size: calc(12px * var(--app-font-scale));
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet__item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 52px;
  margin-bottom: 1px;
  font-size: calc(16px * var(--app-font-scale));
  color: var(--text);
  background: var(--bg-panel);
}

.sheet__item:first-of-type {
  border-radius: 12px 12px 0 0;
}

.sheet__item:last-of-type {
  border-radius: 0 0 12px 12px;
}

.sheet__item--with-icon {
  justify-content: flex-start;
  padding-left: 18px;
}

.sheet__item--danger {
  color: #e64340;
}

.sheet__item--cancel {
  border-radius: 12px;
  font-weight: 500;
  margin-top: 8px;
}

.sheet__gap {
  height: 8px;
}
</style>
