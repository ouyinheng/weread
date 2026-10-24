// One 100k-character "chapter" is a layout hazard; import splits it at block
// boundaries without breaking tags.
import { splitLongChapters } from '../src/utils/parser.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

function chapterOf(paragraphs, charsPer) {
  const html = paragraphs.map((_, i) => `<p>${'字'.repeat(charsPer)}${i}</p>`).join('')
  return { title: '第一章', html, text: html.replace(/<[^>]+>/g, '') }
}

const long = chapterOf(Array.from({ length: 30 }, (_, i) => i), 1000)
const parts = splitLongChapters([long], 4000)
check('long chapter split into parts', parts.length > 1, String(parts.length))
check('every part keeps balanced <p> tags',
  parts.every(p => (p.html.match(/<p>/g) || []).length === (p.html.match(/<\/p>/g) || []).length),
  String(parts.length))
check('part titles are numbered',
  parts.every((p, i) => p.title === `第一章（${i + 1}/${parts.length}）`),
  parts.map(p => p.title).join(','))
const countChars = s => s.replace(/\s/g, '').length
check('no text lost',
  parts.reduce((n, p) => n + countChars(p.text), 0) === countChars(long.text),
  `${parts.reduce((n, p) => n + countChars(p.text), 0)}/${countChars(long.text)}`)

const short = chapterOf([1, 2], 100)
check('short chapters untouched', splitLongChapters([short], 4000)[0] === short)

const giantBlock = { title: '巨段', html: `<p>${'字'.repeat(50)}</p>`, text: '字'.repeat(50) }
check('single oversized block left whole', splitLongChapters([giantBlock], 10).length === 1)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
