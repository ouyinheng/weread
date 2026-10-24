/**
 * 书内搜索状态机, extracted from ReaderView.
 *
 * The reader owns the chapter cache; this composable owns the query, debounce,
 * stale-result guard and result list. Keeping it out of the view is the first
 * step of the page split the review asked for: search changes should not touch
 * pagination or gestures.
 */
import { computed, ref, watch, type Ref } from 'vue'
import type { Chapter } from '@/types'
import { searchBook, type BookSearchHit } from '@/utils/book-search'

export function useBookSearch(
  chapters: Ref<Chapter[]>,
  html: Ref<Map<number, string>>,
) {
  const query = ref('')
  const results = ref<BookSearchHit[]>([])
  const running = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  const searchable = computed(() => {
    const list: { index: number; title: string; html: string }[] = []
    for (let i = 0; i < chapters.value.length; i++) {
      const chapterHtml = html.value.get(i)
      if (!chapterHtml) continue
      list.push({ index: i, title: chapters.value[i]?.title || '', html: chapterHtml })
    }
    return list
  })

  async function run(q: string): Promise<void> {
    const id = ++seq
    const word = q.trim()
    if (!word) {
      results.value = []
      running.value = false
      return
    }
    running.value = true
    // Yield once so the spinner can paint before the synchronous scan.
    await new Promise(r => setTimeout(r, 0))
    if (id !== seq) return
    const hits = searchBook(searchable.value, word)
    if (id !== seq) return
    results.value = hits
    running.value = false
  }

  watch(query, q => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void run(q) }, 220)
  })

  /** Clear the query and invalidate any in-flight scan. */
  function reset(): void {
    query.value = ''
    results.value = []
    running.value = false
    seq++
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { query, results, running, searchable, reset, dispose }
}
