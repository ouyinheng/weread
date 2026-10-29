/**
 * 真实网络书源体检（不进 `npm test`，需联网，手动跑）：
 *
 *   node node_modules/vite-node/dist/cli.mjs tests/source-live.mjs ../ziyongyuan/book.json 十日终焉
 *
 * 走的是 App 完全相同的代码路径：net.ts 的请求层 + pipeline.ts 四段管线 +
 * selector.ts 规则解释器，所以这里跑通 == 装进 App 能用。
 * 每个源输出：搜索命中数 / 首条书名 / 目录章数 / 首章正文字数。
 */
import { Window } from 'happy-dom'
import fs from 'node:fs'

const win = new Window({ url: 'http://localhost/' })
globalThis.window = win
for (const key of ['document', 'Element', 'Node', 'HTMLElement', 'DOMParser', 'NodeFilter', 'location']) {
  if (win[key] !== undefined) globalThis[key] = win[key]
}

const file = process.argv[2]
const keywords = process.argv.slice(3)
if (!file || !keywords.length) {
  console.error('用法: vite-node tests/source-live.mjs <book.json> <关键词...>')
  process.exit(2)
}

const { search, loadBook, loadChapter, makeCtx } = await import('../src/utils/source/pipeline.ts')

const list = JSON.parse(fs.readFileSync(file, 'utf8'))
const rows = []

for (const src of list) {
  const url = String(src.bookSourceUrl || '').replace(/\/+$/, '')
  const source = {
    id: url,
    name: src.bookSourceName || url,
    url,
    group: src.bookSourceGroup || '',
    type: 0,
    enabled: true,
    raw: src,
    health: 0,
    lastCheckAt: 0,
    lastError: '',
    createdAt: 0,
  }
  const row = { name: source.name, url, hits: {}, toc: null, chars: null, err: '' }
  const ctx = makeCtx(source)
  for (const kw of keywords) {
    try {
      const hits = await search(ctx, kw)
      const exact = hits.find((h) => h.title.includes(kw)) || hits[0]
      row.hits[kw] = hits.length
      if (!exact) continue
      if (!row.first) row.first = exact.title
      if (row.toc === null) {
        try {
          const loaded = await loadBook(ctx, exact.bookUrl)
          row.toc = loaded.chapters.length
          row.book = loaded.info.title || exact.title
          row.author = loaded.info.author || ''
          if (loaded.chapters[0]) {
            const ch = await loadChapter(ctx, { title: loaded.chapters[0].title, url: loaded.chapters[0].url })
            row.chars = ch.text.replace(/\s/g, '').length
            row.chapter = ch.title
          }
        } catch (e) {
          row.err = `目录/正文: ${e.message}`
        }
      }
    } catch (e) {
      row.err = `搜索: ${e.message}`
    }
  }
  rows.push(row)
  const hitText = Object.entries(row.hits).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(
    `${row.name.padEnd(10)} ${hitText.padEnd(28)} 目录${String(row.toc ?? '-').padStart(4)}章 首章${String(row.chars ?? '-').padStart(5)}字  ${row.err || ''}`,
  )
}

const bad = rows.filter((r) => !r.toc || r.err)
console.log(`\n${rows.length - bad.length}/${rows.length} 通过`)
