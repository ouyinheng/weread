// In-book search must report two offsets: one for painting the match (DOM
// text, whitespace included) and one for progress (non-whitespace characters).
import { searchBook, htmlToSearchText } from '../src/utils/book-search.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const chapters = [
  { index: 0, title: '第一章', html: '<p>第一段有天空</p><p>第二段也有天空和云</p>' },
  { index: 1, title: '第二章', html: '<p>前文　天空</p>' },
]

const hits = searchBook(chapters, '天空')
check('finds every occurrence', hits.length === 3, String(hits.length))
check('chapter index preserved', hits[0].chapterIndex === 0 && hits[2].chapterIndex === 1,
  hits.map(h => h.chapterIndex).join(','))
check('DOM offset points at the match',
  chapters[0].html && hits[0].domOffset === htmlToSearchText(chapters[0].html).indexOf('天空'),
  String(hits[0].domOffset))
check('character offset skips whitespace', hits[2].charOffset === 2, String(hits[2].charOffset))
check('DOM offset keeps whitespace', hits[2].domOffset === 3, String(hits[2].domOffset))
check('excerpt carries the match', hits[0].excerpt.includes('天空'), hits[0].excerpt)
check('match span marks the query',
  hits[0].excerpt.slice(hits[0].matchStart, hits[0].matchEnd) === '天空',
  JSON.stringify(hits[0]))
check('chapter title included', hits[0].chapterTitle === '第一章', hits[0].chapterTitle)

const many = [{ index: 0, title: '长', html: '<p>' + '空'.repeat(50) + '</p>' }]
check('per-chapter results are capped', searchBook(many, '空').length === 20,
  String(searchBook(many, '空').length))

const limited = searchBook(chapters, '天空', 2)
check('global limit respected', limited.length === 2, String(limited.length))

check('empty query returns nothing', searchBook(chapters, '   ').length === 0)
check('no match returns nothing', searchBook(chapters, '不存在').length === 0)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
