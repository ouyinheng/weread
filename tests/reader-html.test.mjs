/**
 * 正文空行瘦身（`tidyChapterHtml`）。
 *
 * 采集站和不少 epub 转出来的 XHTML 用空段落 / 连续 `<br>` 表示「段落之间空
 * 一行」，阅读页段距本来就是 0，于是每处都多出整行空白。这里锁住三件事：
 *   1. 空块被加上 `.reader__blank`（隐藏），但文字一个字都没少 —— 划线/进度
 *      是按字符偏移存的，少一个字就会整体前移；
 *   2. 连续 `<br>` 只留一个，块首块尾的 `<br>` 直接删；
 *   3. 正常的段落、插图、代码块一个都不能动。
 */
import { Window } from 'happy-dom'

const win = new Window()
globalThis.DOMParser = win.DOMParser
// applyHighlights 走 TreeWalker，需要 NodeFilter 常量。
globalThis.NodeFilter = win.NodeFilter

const { BLANK_CLASS, tidyChapterHtml } = await import('../src/utils/reader-html.ts')

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/** 用同一套 parser 取回纯文字，比较「瘦身前后文字是否一致」。 */
const textOf = (html) => {
  const doc = new win.DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html')
  return doc.getElementById('r').textContent
}

/* ---------- 1. 空段落被隐藏，文字不变 ---------- */
const spaced = [
  '<p>第一段。</p>',
  '<p>&nbsp;</p>',
  '<p>第二段。</p>',
  '<p><br></p>',
  '<p>　　</p>',
  '<p>第三段。</p>',
].join('')

const tidy = tidyChapterHtml(spaced)
check('blank paragraphs marked', (tidy.match(new RegExp(BLANK_CLASS, 'g')) || []).length === 3, tidy)
check('text preserved', textOf(tidy) === textOf(spaced), JSON.stringify(textOf(tidy)))
check('real paragraphs kept', (tidy.match(/<(?!\/)/g) || []).length >= 3, tidy)

/* ---------- 2. 连续 <br> 收敛成一个，块首尾的删掉 ---------- */
const breaks = '<p>甲<br/><br/>乙</p><p>丙<br/><br/></p><p><br/><br/>丁</p>'
const tidyBreaks = tidyChapterHtml(breaks)
check('br run collapsed', (tidyBreaks.match(/<br\s*\/?>/g) || []).length === 1, tidyBreaks)
check('br text untouched', textOf(tidyBreaks) === textOf(breaks), JSON.stringify(textOf(tidyBreaks)))

/* ---------- 3. 不该动的东西 ---------- */
const media = '<p><img src="a.png" alt="插图" /></p><hr /><pre>code\n\n\nblock</pre>'
check('media/pre untouched', tidyChapterHtml(media) === media, tidyChapterHtml(media))

const clean = '<p>　　正常段落一。</p><p>　　正常段落二。</p>'
check('clean chapter is a no-op', tidyChapterHtml(clean) === clean, tidyChapterHtml(clean))

check('empty input', tidyChapterHtml('') === '', JSON.stringify(tidyChapterHtml('')))

/* ---------- 4. 顺序：瘦身后仍能按偏移划线 ---------- */
const { applyHighlights } = await import('../src/utils/highlights.ts')
const marked = applyHighlights(tidyChapterHtml('<p>&nbsp;</p><p>目标句</p>'), [{ start: 1, end: 4 }])
check('highlight lands after tidying', marked.includes('<mark') && marked.includes('目标句'), marked)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
