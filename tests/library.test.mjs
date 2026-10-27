// A parser upgrade must be able to rebuild already-imported books, otherwise
// users keep broken markup from older parses forever.
import 'fake-indexeddb/auto'
import { makeEpubBuffer } from './fixtures.mjs'
import { dbPut, dbPutMany, dbGet, dbGetAll } from '../src/utils/db.ts'
import { PARSER_VERSION, parseEpub } from '../src/utils/parser.ts'
import { saveSourceFile, loadSourceFile, rebuildBook, needsRebuild } from '../src/utils/library.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const ab = await makeEpubBuffer()

/* ---------- needsRebuild ---------- */
check('legacy book needs rebuild', needsRebuild({ parserVersion: undefined }), '')
check('v1 book needs rebuild', needsRebuild({ parserVersion: 1 }), '')
check('current book is fresh', !needsRebuild({ parserVersion: PARSER_VERSION }), '')
check('newer book is fresh', !needsRebuild({ parserVersion: PARSER_VERSION + 1 }), '')

/* ---------- source bytes round-trip (ArrayBuffer must survive clone) ---------- */
await saveSourceFile('b1', 'test.epub', ab)
const src = await loadSourceFile('b1')
check('source saved', !!src, '')
check('source name kept', src?.name === 'test.epub', src?.name)
check('source bytes intact', src?.bytes?.byteLength === ab.byteLength, `${src?.bytes?.byteLength} vs ${ab.byteLength}`)

/* ---------- rebuild replaces stale chapters ---------- */
await dbPut('books', {
  id: 'b1', title: 'Stale', author: '', format: 'epub', cover: null,
  wordCount: 1, fileSize: ab.byteLength, importedAt: Date.now(), lastReadAt: Date.now(),
  progress: 5, lastChapterIndex: 99, lastCharOffset: 0, finished: false,
  parserVersion: 1,
})
await dbPutMany('chapters', [
  { bookId: 'b1', index: 0, title: 'stale', html: '<p><?xml version="1.0"?><html><head><title>bad</title></head></html></p>', text: 'x', charOffset: 0, wordCount: 1 },
])

const rebuilt = await rebuildBook(await dbGet('books', 'b1'))
check('rebuild reports success', rebuilt === true, rebuilt)

const book = await dbGet('books', 'b1')
check('parserVersion bumped', book?.parserVersion === PARSER_VERSION, book?.parserVersion)
check('title refreshed', book?.title === 'The story of Little Black Quibba', book?.title)
check('author refreshed', book?.author === 'Helen Bannerman', book?.author)
check('cover is a data URL', (book?.cover || '').startsWith('data:image/'), (book?.cover || '').slice(0, 40))
check('index clamped into range', book?.lastChapterIndex <= 1, book?.lastChapterIndex)

const chapters = await dbGetAll('chapters')
const mine = chapters.filter(c => c.bookId === 'b1')
check('stale chapters replaced', mine.length >= 1, mine.length)
check('no leaked <title> in rebuilt html', mine.every(c => !/<title/i.test(c.html)), mine.map(c => c.html.slice(0, 60)))
check('no leaked <?xml prolog', mine.every(c => !c.html.includes('<?xml')), '')
check('rebuilt chapters have text', mine.every(c => c.text.length > 0), mine.map(c => c.text.length))

/* ---------- rebuild without source bytes is a no-op ---------- */
await dbPut('books', { id: 'b2', title: 'NoSource', author: '', format: 'txt', cover: null, wordCount: 0, fileSize: 0, importedAt: 0, lastReadAt: 0, progress: 0, lastChapterIndex: 0, lastCharOffset: 0, finished: false, parserVersion: 1 })
check('rebuild without source returns false', (await rebuildBook(await dbGet('books', 'b2'))) === false, '')

/* ---------- cover survives a reload (data URL, not blob:) ---------- */
const parsed = await parseEpub(ab, 'pg79784-images-3.epub')
check('fresh parse cover is data URL', (parsed.cover || '').startsWith('data:image/'), (parsed.cover || '').slice(0, 40))
check('fresh parse cover is not blob', !(parsed.cover || '').startsWith('blob:'), '')

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
