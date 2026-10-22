import 'fake-indexeddb/auto'
import { readFileSync } from 'fs'
import { parseTxt } from './src/utils/parser.ts'
import { dbPut, dbPutMany, dbGetAll, dbDelete, dbDeleteByIndex } from './src/utils/db.ts'

let fail = 0
const check = (name, cond, extra='') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const buf = readFileSync('/Users/ouyinheng/Documents/GitHub/weread/docs/evidence/测试书籍/第五形态.txt')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const t0 = Date.now()
const parsed = await parseTxt(ab, '第五形态.txt')
const parseMs = Date.now() - t0
console.log(`parse: ${parsed.chapters.length} chapters, ${parseMs}ms`)
check('chapter count > 1000', parsed.chapters.length > 1000, `got ${parsed.chapters.length}`)
check('has words', parsed.totalWords > 1000000, `got ${parsed.totalWords}`)

const bookId = 'test-book-1'
const rows = parsed.chapters.map((c, i) => ({
  bookId, index: i, title: c.title || `第${i+1}章`, html: c.html,
  text: c.text, charOffset: 0, wordCount: c.text.replace(/\s/g,'').length
}))

const t1 = Date.now()
await dbPut('books', { id: bookId, title: parsed.title, author: parsed.author, progress: 0 })
await dbPutMany('chapters', rows)
const writeMs = Date.now() - t1
console.log(`write ${rows.length} chapters: ${writeMs}ms`)
check('bulk write fast (<5s)', writeMs < 5000, `${writeMs}ms`)

const all = await dbGetAll('chapters')
const mine = all.filter(r => r.bookId === bookId)
check('all chapters persisted', mine.length === rows.length, `${mine.length}/${rows.length}`)
check('html preserved', !!mine[0].html && mine[0].html.includes('<p>'), 'missing html')

// index-based purge (delete book cascade)
await dbDeleteByIndex('chapters', 'bookId', bookId)
const after = (await dbGetAll('chapters')).filter(r => r.bookId === bookId)
check('cascade delete removed chapters', after.length === 0, `left ${after.length}`)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
