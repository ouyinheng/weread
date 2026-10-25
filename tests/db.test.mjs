// Regression: putting a Vue reactive Proxy into IndexedDB throws DataCloneError.
// That silently broke every progress write, so store state must be de-proxied.
import 'fake-indexeddb/auto'
import { reactive, ref } from 'vue'
import {
  dbPut, dbPutMany, dbGet, dbGetAll, dbDelete, dbDeleteByIndex,
  resetDriver, storageBackend,
} from '../src/utils/db.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- the bug itself ---------- */
{
  const proxied = reactive({ id: 'p1', title: 'proxied', progress: 42 })
  let err = null
  try {
    await dbPut('books', proxied)
  } catch (e) {
    err = e
  }
  check('dbPut accepts a reactive proxy', !err, err && `${err.name}: ${err.message}`)

  const back = await dbGet('books', 'p1')
  check('proxied record round-trips', back?.title === 'proxied' && back?.progress === 42, JSON.stringify(back))
}

/* ---------- nested proxy ---------- */
{
  const nested = reactive({ id: 'p2', meta: { tags: ['a', 'b'], deep: { n: 1 } } })
  let err = null
  try { await dbPut('books', nested) } catch (e) { err = e }
  check('nested proxy stored', !err, err && err.message)
  const back = await dbGet('books', 'p2')
  check('nested structure preserved', back?.meta?.deep?.n === 1 && back?.meta?.tags?.length === 2, JSON.stringify(back))
}

/* ---------- ref proxy ---------- */
{
  const r = ref({ id: 'p3', v: 7 })
  let err = null
  try { await dbPut('books', r.value) } catch (e) { err = e }
  check('ref value stored', !err, err && err.message)
}

/* ---------- bulk path ---------- */
{
  const rows = [reactive({ bookId: 'b1', index: 0, html: '<p>x</p>' }), reactive({ bookId: 'b1', index: 1, html: '<p>y</p>' })]
  let err = null
  try { await dbPutMany('chapters', rows) } catch (e) { err = e }
  check('dbPutMany accepts proxies', !err, err && err.message)
  const all = await dbGetAll('chapters')
  check('bulk records persisted', all.filter(r => r.bookId === 'b1').length === 2, all.length)
}

/* ---------- no proxy leakage into stored value ---------- */
{
  const src = reactive({ id: 'p4', title: 'clean' })
  await dbPut('books', src)
  const back = await dbGet('books', 'p4')
  check('stored value is a plain object', back && Object.getPrototypeOf(back) === Object.prototype, Object.getPrototypeOf(back)?.constructor?.name)
}

/* ---------- cascade delete still works ---------- */
{
  await dbDeleteByIndex('chapters', 'bookId', 'b1')
  const all = await dbGetAll('chapters')
  check('delete by index purges rows', all.filter(r => r.bookId === 'b1').length === 0, all.length)
  await dbDelete('books', 'p1')
  check('delete by key removes record', (await dbGet('books', 'p1')) === undefined, '')
}

/* ---------- driver reset: the SQLite migration hands the session over ---------- */
{
  const before = await dbGet('books', 'p4')
  check('backend is indexeddb in the browser', (await storageBackend()) === 'indexeddb')

  await resetDriver()
  check('backend report survives a reset', (await storageBackend()) === 'indexeddb')

  // The reset closes the old connection; the replacement must reopen the same
  // database rather than hand back an empty store.
  const after = await dbGet('books', 'p4')
  check('data survives a driver reset', after?.title === 'clean' && before?.title === 'clean', JSON.stringify(after))

  await dbPut('books', { id: 'p5', title: 'after-reset' })
  check('writes work after a reset', (await dbGet('books', 'p5'))?.title === 'after-reset')
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
