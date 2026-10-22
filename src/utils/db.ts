const DB_NAME = 'weread'
// v2: bookId indexes so deleting a book can purge its chapters/bookmarks.
// v3: `files` store keeps the original book bytes so a parser upgrade can
//     re-parse, and covers move from volatile blob: URLs to data URLs.
// v4: `highlights` store — 划线/想法 ranges selected in the reader.
// v5: `sources` store — legado 在线书源（只新增，不改任何现有 store）。
const DB_VERSION = 5

let db: IDBDatabase | null = null

export function openRawDB(): Promise<IDBDatabase> {
  return openDB()
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db)
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id' })
      }
      if (!d.objectStoreNames.contains('chapters')) {
        const st = d.createObjectStore('chapters', { keyPath: ['bookId', 'index'] })
        if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
      } else {
        const st = req.transaction!.objectStore('chapters')
        if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' })
      }
      if (!d.objectStoreNames.contains('bookmarks')) {
        const st = d.createObjectStore('bookmarks', { keyPath: 'id' })
        if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
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
        if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
      } else {
        const st = req.transaction!.objectStore('highlights')
        if (!st.indexNames.contains('bookId')) st.createIndex('bookId', 'bookId', { unique: false })
      }
      // v5: 在线书源配置。数量很小，enabled / health 在内存里过滤，不建索引。
      if (!d.objectStoreNames.contains('sources')) {
        d.createObjectStore('sources', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => { db = req.result; resolve(db) }
    req.onerror = () => reject(req.error)
  })
}

/**
 * IndexedDB structured-clones what it stores, and a Vue reactive Proxy is not
 * cloneable — `put(proxy)` throws DataCloneError. Every record passes through
 * this so callers can hand over store state directly.
 */
function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
}

async function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const d = await openDB()
  return d.transaction(store, mode).objectStore(store)
}

export async function dbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const s = await tx(store, 'readonly')
  return new Promise((resolve, reject) => {
    const r = s.get(key)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export async function dbGetAll<T>(store: string): Promise<T[]> {
  const s = await tx(store, 'readonly')
  return new Promise((resolve, reject) => {
    const r = s.getAll()
    r.onsuccess = () => resolve(r.result || [])
    r.onerror = () => reject(r.error)
  })
}

export async function dbPut(store: string, value: any): Promise<void> {
  const s = await tx(store, 'readwrite')
  return new Promise((resolve, reject) => {
    const r = s.put(plain(value))
    r.onsuccess = () => resolve()
    r.onerror = () => reject(r.error)
  })
}

export async function dbDelete(store: string, key: IDBValidKey): Promise<void> {
  const s = await tx(store, 'readwrite')
  return new Promise((resolve, reject) => {
    const r = s.delete(key)
    r.onsuccess = () => resolve()
    r.onerror = () => reject(r.error)
  })
}

/** Write many records inside a single transaction. */
export async function dbPutMany(store: string, rows: any[]): Promise<void> {
  if (!rows.length) return
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite')
    const s = t.objectStore(store)
    for (const row of rows) s.put(plain(row))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export async function dbDeleteByIndex(store: string, indexName: string, key: IDBValidKey): Promise<void> {
  const d = await openDB()
  const t = d.transaction(store, 'readwrite')
  const s = t.objectStore(store)
  return new Promise((resolve, reject) => {
    const idx = s.index(indexName)
    const req = idx.openCursor(key)
    req.onsuccess = () => {
      const cur = req.result
      if (cur) { cur.delete(); cur.continue() }
      else resolve()
    }
    req.onerror = () => reject(req.error)
  })
}
