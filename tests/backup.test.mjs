// Backup round-trip: export a zip, wipe the database, restore it, and check
// that text, binary source files and notes all come back.
import 'fake-indexeddb/auto'
import { dbClear, dbGetAll, dbPut, dbPutRaw } from '../src/utils/db.ts'
import { exportBackup, importBackup } from '../src/utils/backup.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer
await dbPut('books', { id: 'b1', title: '备份测试', progress: 42, lastChapterIndex: 3 })
await dbPut('chapters', { bookId: 'b1', index: 0, title: '第一章', text: '正文', html: '<p>正文</p>' })
await dbPut('highlights', { id: 'h1', bookId: 'b1', chapterIndex: 0, start: 0, end: 2, text: '正文', note: '想法' })
await dbPut('settings', { key: 'reader', fontSize: 21, theme: 'yellow' })
await dbPutRaw('files', { bookId: 'b1', name: 'book.txt', bytes })

const blob = await exportBackup()
check('export produced a zip blob', blob instanceof Blob && blob.size > 0, String(blob.size))

// Wipe everything the restore is expected to rewrite.
for (const s of ['books', 'chapters', 'bookmarks', 'highlights', 'sessions', 'settings', 'sources', 'files']) {
  await dbClear(s)
}

const result = await importBackup(new File([blob], 'backup.zip', { type: 'application/zip' }))
check('restore reports one book', result.books === 1, JSON.stringify(result))
check('restore reports one source file', result.files === 1, JSON.stringify(result))
check('restore reports one highlight', result.highlights === 1, JSON.stringify(result))

const books = await dbGetAll('books')
const chapters = await dbGetAll('chapters')
const highlights = await dbGetAll('highlights')
const settings = await dbGetAll('settings')
const files = await dbGetAll('files')

check('book restored with progress', books[0]?.title === '备份测试' && books[0]?.progress === 42, JSON.stringify(books[0]))
check('chapter restored', chapters[0]?.text === '正文', JSON.stringify(chapters[0]))
check('highlight restored', highlights[0]?.note === '想法', JSON.stringify(highlights[0]))
check('settings restored', settings[0]?.fontSize === 21, JSON.stringify(settings[0]))
check('binary bytes restored intact',
  files[0]?.bytes instanceof ArrayBuffer && files[0].bytes.byteLength === bytes.byteLength,
  files[0]?.bytes?.byteLength)

// A non-backup zip must be rejected rather than silently wiping the library.
const JSZip = (await import('jszip')).default
const bogus = new JSZip()
bogus.file('hello.txt', 'not a backup')
const bogusBlob = await bogus.generateAsync({ type: 'blob' })
let rejected = false
try {
  await importBackup(new File([bogusBlob], 'other.zip'))
} catch (e) {
  rejected = /不是微读的备份/.test(String(e?.message || ''))
}
check('non-backup zip rejected', rejected)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
