import {
  countChars,
  charsBefore,
  totalChars,
  progressPercent,
  pageToChar,
  charToPage,
  remainingMinutes,
  remainText,
} from '../src/utils/progress.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- countChars ---------- */
check('count plain', countChars('abc') === 3, countChars('abc'))
check('count strips tags', countChars('<p>abc</p>') === 3, countChars('<p>abc</p>'))
check('count strips whitespace', countChars('<p>a b\n c</p>') === 3, countChars('<p>a b\n c</p>'))
check('count empty', countChars('') === 0, countChars(''))
check('count cjk', countChars('<p>第一章 起点</p>') === 5, countChars('<p>第一章 起点</p>'))

/* ---------- charsBefore / totalChars ---------- */
const chapters = [100, 200, 300]
check('charsBefore 0', charsBefore(chapters, 0) === 0, charsBefore(chapters, 0))
check('charsBefore 1', charsBefore(chapters, 1) === 100, charsBefore(chapters, 1))
check('charsBefore 2', charsBefore(chapters, 2) === 300, charsBefore(chapters, 2))
check('charsBefore clamped', charsBefore(chapters, 99) === 600, charsBefore(chapters, 99))
check('totalChars', totalChars(chapters) === 600, totalChars(chapters))
check('totalChars empty', totalChars([]) === 0, totalChars([]))

/* ---------- progressPercent ---------- */
check('pct at start', progressPercent(chapters, 0, 0) === 0, progressPercent(chapters, 0, 0))
check('pct mid chapter0', progressPercent(chapters, 0, 50) === (50 / 600) * 100, progressPercent(chapters, 0, 50))
check('pct chapter1 start', progressPercent(chapters, 1, 0) === (100 / 600) * 100, progressPercent(chapters, 1, 0))
check('pct at end', progressPercent(chapters, 2, 300) === 100, progressPercent(chapters, 2, 300))
check('pct clamps over', progressPercent(chapters, 2, 9999) === 100, progressPercent(chapters, 2, 9999))
check('pct clamps negative', progressPercent(chapters, 0, -10) === 0, progressPercent(chapters, 0, -10))
check('pct empty book', progressPercent([], 0, 0) === 0, progressPercent([], 0, 0))
check('pct zero chapters', progressPercent([0, 0], 0, 0) === 0, progressPercent([0, 0], 0, 0))

/* ---------- pageToChar / charToPage round-trip ---------- */
const PAGES = 10
const LEN = 1000
check('page0 -> char0', pageToChar(0, PAGES, LEN) === 0, pageToChar(0, PAGES, LEN))
check('page9 -> char900', pageToChar(9, PAGES, LEN) === 900, pageToChar(9, PAGES, LEN))
check('page clamps high', pageToChar(99, PAGES, LEN) === 900, pageToChar(99, PAGES, LEN))
check('page clamps low', pageToChar(-5, PAGES, LEN) === 0, pageToChar(-5, PAGES, LEN))
check('single page -> char0', pageToChar(0, 1, LEN) === 0, pageToChar(0, 1, LEN))
check('no chars -> char0', pageToChar(3, PAGES, 0) === 0, pageToChar(3, PAGES, 0))
check('char450 -> page5', charToPage(450, PAGES, LEN) === 5, charToPage(450, PAGES, LEN))
check('char offset clamps', charToPage(99999, PAGES, LEN) === PAGES - 1, charToPage(99999, PAGES, LEN))
check('char negative clamps', charToPage(-1, PAGES, LEN) === 0, charToPage(-1, PAGES, LEN))

let roundTripOk = true
for (let page = 0; page < PAGES; page++) {
  const back = charToPage(pageToChar(page, PAGES, LEN), PAGES, LEN)
  if (back !== page) { roundTripOk = false; console.log('   mismatch page', page, '->', back) }
}
check('page<->char round-trip', roundTripOk)

/* ---------- font-size change keeps the same character ---------- */
// Same charOffset, different pagination: the character must stay put.
const offset = pageToChar(5, 10, LEN)
const pageAtSmallFont = charToPage(offset, 20, LEN)   // more pages after shrinking
const pageAtLargeFont = charToPage(offset, 6, LEN)    // fewer pages after enlarging
check('offset stable across relayout', pageToChar(pageAtSmallFont, 20, LEN) === offset, pageToChar(pageAtSmallFont, 20, LEN))
check('offset stable when enlarged', pageToChar(pageAtLargeFont, 6, LEN) === offset, pageToChar(pageAtLargeFont, 6, LEN))

/* ---------- remaining time ---------- */
check('remain at start', remainingMinutes(chapters, 0, 0) === 2, remainingMinutes(chapters, 0, 0))
check('remain at end', remainingMinutes(chapters, 2, 300) === 0, remainingMinutes(chapters, 2, 300))
check('remain empty', remainingMinutes([], 0, 0) === 0, remainingMinutes([], 0, 0))
check('remain cpm guard', remainingMinutes(chapters, 0, 0, 0) === 0, remainingMinutes(chapters, 0, 0, 0))
check('remain text <1m', remainText(0) === '即将读完', remainText(0))
check('remain text min', remainText(5) === '约 5 分钟后读完', remainText(5))
check('remain text hour', remainText(60) === '约 1 小时后读完', remainText(60))
check('remain text hour+min', remainText(95) === '约 1 小时 35 分钟后读完', remainText(95))

/* ---------- big-book sanity (5000 chapters) ---------- */
const big = new Array(5000).fill(3000)
const t0 = Date.now()
const p = progressPercent(big, 2500, 1500)
const elapsed = Date.now() - t0
check('big book progress', Math.abs(p - 50) < 0.1, p)
check('big book fast (<50ms)', elapsed < 50, `${elapsed}ms`)

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
