/**
 * IndexedDB driver — the web/test backend and the pre-migration store.
 *
 * All of this used to live in `db.ts`; it is unchanged except for the `daily`
 * store (reading statistics) and the extra index read used by the migration.
 */
import type { DBDriver, StoreKey, StoreName } from './types'

const DEFAULT_DB = 'weread'
// v6: `daily` — per-day reading duration buckets for the stats chart.
const DB_VERSION = 6

function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
}

export function createIdbDriver(dbName = DEFAULT_DB): DBDriver {
  let db: IDBDatabase | null = null

  function open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (db) return resolve()
      const req = indexedDB.open(dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains('books')) {
          d.createObjectStore('books', { keyPath: 'id' })
        }
        if (!d.objectStoreNames.contains('chapters')) {
          const st = d.createObjectStore('chapters', { keyPath: ['bookId', 'index'] })
          st.createIndex('bookId', 'bookId', { unique: false })
        } else {
          const st = req.transaction!.objectStore('chapters')
          if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' })
        }
        if (!d.objectStoreNames.contains('bookmarks')) {
          const st = d.createObjectStore('bookmarks', { keyPath: 'id' })
          st.createIndex('bookId', 'bookId', { unique: false })
        } else {
          const st = req.transaction!.objectStore('bookmarks')
          if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
        }
        if (!d.objectStoreNames.contains('sessions')) {
          d.createObjectStore('sessions', { keyPath: 'bookId' })
        }
        // Original file bytes, so a parser upgrade can rebuild a book in place.
        if (!d.objectStoreNames.contains('files')) {
          d.createObjectStore('files', { keyPath: 'bookId' })
        }
        // 划线 / 想法: character ranges selected inside the reading page.
        if (!d.objectStoreNames.contains('highlights')) {
          const st = d.createObjectStore('highlights', { keyPath: 'id' })
          st.createIndex('bookId', 'bookId', { unique: false })
        } else {
          const st = req.transaction!.objectStore('highlights')
          if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
        }
        // 在线书源配置。数量很小，enabled / health 在内存里过滤，不建索引。
        if (!d.objectStoreNames.contains('sources')) {
          d.createObjectStore('sources', { keyPath: 'id' })
        }
        // Per-day reading time: `{ id: 'YYYY-MM-DD', ms }`.
        if (!d.objectStoreNames.contains('daily')) {
          d.createObjectStore('daily', { keyPath: 'id' })
        }
      }
      req.onsuccess = () => { db = req.result; resolve() }
      req.onerror = () => reject(req.error)
    })
  }

  async function tx(store: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await open()
    return db!.transaction(store, mode).objectStore(store)
  }

  async function get(store: StoreName, key: StoreKey): Promise<any> {
    const s = await tx(store, 'readonly')
    return new Promise((resolve, reject) => {
      const r = s.get(key as IDBValidKey)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }

  async function getAll(store: StoreName): Promise<any[]> {
    const s = await tx(store, 'readonly')
    return new Promise((resolve, reject) => {
      const r = s.getAll()
      r.onsuccess = () => resolve(r.result || [])
      r.onerror = () => reject(r.error)
    })
  }

  async function getAllByIndex(store: StoreName, index: string, key: string | number): Promise<any[]> {
    const s = await tx(store, 'readonly')
    return new Promise((resolve, reject) => {
      const req = s.index(index).getAll(key as IDBValidKey)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  }

  async function count(store: StoreName): Promise<number> {
    const s = await tx(store, 'readonly')
    return new Promise((resolve, reject) => {
      const r = s.count()
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }

  async function put(store: StoreName, value: any): Promise<void> {
    const s = await tx(store, 'readwrite')
    return new Promise((resolve, reject) => {
      const r = s.put(plain(value))
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  }

  /** Binary-safe write: `plain()` would turn an ArrayBuffer into `{}`. */
  async function putRaw(store: StoreName, value: any): Promise<void> {
    const s = await tx(store, 'readwrite')
    return new Promise((resolve, reject) => {
      const r = s.put(value)
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  }

  async function putMany(store: StoreName, rows: any[]): Promise<void> {
    if (!rows.length) return
    await open()
    return new Promise((resolve, reject) => {
      const t = db!.transaction(store, 'readwrite')
      const s = t.objectStore(store)
      for (const row of rows) s.put(plain(row))
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  async function del(store: StoreName, key: StoreKey): Promise<void> {
    const s = await tx(store, 'readwrite')
    return new Promise((resolve, reject) => {
      const r = s.delete(key as IDBValidKey)
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  }

  /**
   * One transaction for the whole list: deleting a few thousand sources one
   * `del()` at a time means a few thousand transactions and a frozen UI.
   * Composite keys (chapters) are not valid IDB keys, so those fall back.
   */
  async function deleteMany(store: StoreName, keys: StoreKey[]): Promise<void> {
    if (!keys.length) return
    if (keys.some(k => Array.isArray(k))) {
      for (const k of keys) await del(store, k)
      return
    }
    await open()
    return new Promise((resolve, reject) => {
      const t = db!.transaction(store, 'readwrite')
      const s = t.objectStore(store)
      for (const k of keys) s.delete(k as IDBValidKey)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  async function deleteByIndex(store: StoreName, index: string, key: string | number): Promise<void> {
    await open()
    const t = db!.transaction(store, 'readwrite')
    const s = t.objectStore(store)
    return new Promise((resolve, reject) => {
      const req = s.index(index).openCursor(key as IDBValidKey)
      req.onsuccess = () => {
        const cur = req.result
        if (cur) { cur.delete(); cur.continue() }
        else resolve()
      }
      req.onerror = () => reject(req.error)
    })
  }

  async function clear(store: StoreName): Promise<void> {
    await open()
    return new Promise((resolve, reject) => {
      const t = db!.transaction(store, 'readwrite')
      const r = t.objectStore(store).clear()
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  }

  async function close(): Promise<void> {
    db?.close()
    db = null
  }

  return {
    backend: 'indexeddb',
    open, get, getAll, getAllByIndex, count, put, putRaw, putMany, delete: del, deleteMany, deleteByIndex, clear, close,
  }
}
