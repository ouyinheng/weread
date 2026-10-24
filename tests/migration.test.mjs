// The migration copy is driver-agnostic, so it is tested with two IndexedDB
// databases: source = the live library, target = the SQLite stand-in.
import 'fake-indexeddb/auto'
import { createIdbDriver } from '../src/utils/storage/idb-driver.ts'
import { copyLibrary } from '../src/utils/storage/copy.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const source = createIdbDriver('migration-source')
const target = createIdbDriver('migration-target')
await source.open()
await target.open()

await source.put('books', { id: 'b1', title: '第一本', progress: 30 })
await source.put('books', { id: 'b2', title: '第二本', progress: 0 })
await source.put('chapters', { bookId: 'b1', index: 0, title: '一', html: '<p>a</p>' })
await source.put('chapters', { bookId: 'b1', index: 1, title: '二', html: '<p>b</p>' })
await source.put('chapters', { bookId: 'b2', index: 0, title: '一', html: '<p>c</p>' })
await source.put('highlights', { id: 'h1', bookId: 'b1', start: 0, end: 1, text: 'a' })
await source.put('bookmarks', { id: 'm1', bookId: 'b1', excerpt: 'a' })
await source.put('sessions', { bookId: 'b1', totalMs: 60000 })
await source.put('settings', { key: 'reader', fontSize: 20 })
await source.put('sources', { id: 's1', name: '源' })
await source.put('daily', { id: '2026-10-23', ms: 120000 })
await source.putRaw('files', { bookId: 'b1', name: 'a.txt', bytes: new Uint8Array([1, 2, 3]).buffer })

// Stale rows in the target must be wiped before the copy.
await target.put('books', { id: 'stale', title: '不该留下' })
await target.put('chapters', { bookId: 'stale', index: 0, html: '<p>x</p>' })

const progress = []
const result = await copyLibrary(source, target, (done, total, message) => {
  progress.push([done, total, message])
})
check('copy reports books and chapters', result.books === 2 && result.chapters === 3, JSON.stringify(result))
check('progress reaches every unit', progress.length > 0 && progress.at(-1)[0] === progress.at(-1)[1],
  JSON.stringify(progress.at(-1)))

check('books copied', (await target.count('books')) === 2)
check('chapters copied', (await target.count('chapters')) === 3)
check('highlights copied', (await target.count('highlights')) === 1)
check('bookmarks copied', (await target.count('bookmarks')) === 1)
check('sessions copied', (await target.get('sessions', 'b1'))?.totalMs === 60000)
check('settings copied', (await target.get('settings', 'reader'))?.fontSize === 20)
check('daily buckets copied', (await target.get('daily', '2026-10-23'))?.ms === 120000)
check('stale rows removed', (await target.get('books', 'stale')) === undefined)
check('original bytes stay in IndexedDB',
  (await target.count('files')) === 0 && (await source.count('files')) === 1)

// A target that silently drops chapters must fail verification instead of
// being marked as a successful migration.
const broken = createIdbDriver('migration-broken')
await broken.open()
const sabotaged = {
  ...broken,
  putMany: async (store, rows) => {
    if (store === 'chapters') return
    return broken.putMany(store, rows)
  },
}
let error = null
try {
  await copyLibrary(source, sabotaged)
} catch (e) {
  error = e
}
check('partial copy is rejected', /章节数量不一致/.test(String(error?.message || '')), String(error?.message))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
