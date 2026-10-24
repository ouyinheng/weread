/**
 * SQLite driver for the Android shell.
 *
 * Tables mirror the IndexedDB stores one-to-one, with the indexed columns
 * exposed (`book_id`, `idx`) and the record itself stored as JSON. That keeps
 * the whole app's calling surface unchanged while making cascade deletes real
 * SQL, and leaves room for FTS5 later.
 *
 * `files` is delegated to IndexedDB on purpose: the plugin hands BLOBs back as
 * number arrays and the write path is not guaranteed to accept raw bytes
 * through the bridge, so the original book bytes stay where they are until
 * they move to the filesystem.
 */
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'
import type { DBDriver, StoreKey, StoreName } from './types'
import { createIdbDriver } from './idb-driver'

const DB_NAME = 'weread'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chapters (book_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(book_id, idx));
CREATE INDEX IF NOT EXISTS chapters_book ON chapters(book_id);
CREATE TABLE IF NOT EXISTS bookmarks (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bookmarks_book ON bookmarks(book_id);
CREATE TABLE IF NOT EXISTS highlights (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS highlights_book ON highlights(book_id);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

type SqlStore = Exclude<StoreName, 'files'>

const TABLES: Record<SqlStore, string> = {
  books: 'books',
  chapters: 'chapters',
  settings: 'settings',
  bookmarks: 'bookmarks',
  sessions: 'sessions',
  highlights: 'highlights',
  sources: 'sources',
  daily: 'daily',
}

/** Stores whose rows carry a `book_id` column (cascade delete / per-book scan). */
const BOOK_INDEXED: SqlStore[] = ['chapters', 'bookmarks', 'highlights']

function idOf(store: SqlStore, value: any): string {
  if (store === 'settings') return String(value.key)
  if (store === 'sessions') return String(value.bookId)
  return String(value.id)
}

export interface SQLiteDriver extends DBDriver {
  isMigrated(): Promise<boolean>
  markMigrated(): Promise<void>
}

export function createSqliteDriver(): SQLiteDriver {
  const connection = new SQLiteConnection(CapacitorSQLite)
  const legacyFiles = createIdbDriver()
  let db: SQLiteDBConnection | null = null
  let opening: Promise<void> | null = null

  async function open(): Promise<void> {
    if (db) return
    if (opening) return opening
    opening = (async () => {
      try {
        db = await connection.createConnection(DB_NAME, false, 'no-encryption', 1, false)
      } catch {
        // Already created earlier in this WebView session (hot reload).
        db = await connection.retrieveConnection(DB_NAME, false)
      }
      await db.open()
      await db.execute(SCHEMA)
    })()
    try {
      await opening
    } finally {
      opening = null
    }
  }

  function requireDb(): SQLiteDBConnection {
    if (!db) throw new Error('SQLite connection is not open')
    return db
  }

  async function queryJson(sql: string, values: any[] = []): Promise<any[]> {
    await open()
    const res = await requireDb().query(sql, values)
    return (res.values || []).map((row: any) => {
      try { return JSON.parse(row.data) } catch { return null }
    }).filter(Boolean)
  }

  async function get(store: StoreName, key: StoreKey): Promise<any> {
    if (store === 'files') return legacyFiles.get('files', key)
    const table = TABLES[store as SqlStore]
    if (store === 'chapters') {
      const [bookId, index] = key as [string, number]
      const rows = await queryJson(
        `SELECT data FROM chapters WHERE book_id = ? AND idx = ?`,
        [bookId, index],
      )
      return rows[0]
    }
    const rows = await queryJson(`SELECT data FROM ${table} WHERE id = ?`, [String(key)])
    return rows[0]
  }

  async function getAll(store: StoreName): Promise<any[]> {
    if (store === 'files') return legacyFiles.getAll('files')
    const table = TABLES[store as SqlStore]
    return queryJson(`SELECT data FROM ${table}`)
  }

  async function getAllByIndex(store: StoreName, index: string, key: string | number): Promise<any[]> {
    if (store === 'files') return legacyFiles.getAllByIndex('files', index, key)
    const table = TABLES[store as SqlStore]
    if (index !== 'bookId' || !BOOK_INDEXED.includes(store as SqlStore)) return []
    return queryJson(`SELECT data FROM ${table} WHERE book_id = ?`, [String(key)])
  }

  function statementFor(store: SqlStore, value: any): { statement: string; values: any[] } {
    const data = JSON.stringify(value)
    if (store === 'chapters') {
      return {
        statement: 'INSERT OR REPLACE INTO chapters (book_id, idx, data) VALUES (?, ?, ?)',
        values: [String(value.bookId), Number(value.index), data],
      }
    }
    if (store === 'bookmarks' || store === 'highlights') {
      return {
        statement: `INSERT OR REPLACE INTO ${TABLES[store]} (id, book_id, data) VALUES (?, ?, ?)`,
        values: [String(value.id), String(value.bookId), data],
      }
    }
    return {
      statement: `INSERT OR REPLACE INTO ${TABLES[store]} (id, data) VALUES (?, ?)`,
      values: [idOf(store, value), data],
    }
  }

  async function count(store: StoreName): Promise<number> {
    if (store === 'files') return legacyFiles.count('files')
    await open()
    const res = await requireDb().query(`SELECT COUNT(*) AS n FROM ${TABLES[store as SqlStore]}`)
    return Number(res.values?.[0]?.n || 0)
  }

  async function put(store: StoreName, value: any): Promise<void> {
    if (store === 'files') return legacyFiles.putRaw('files', value)
    await open()
    const { statement, values } = statementFor(store as SqlStore, value)
    await requireDb().run(statement, values)
  }

  async function putRaw(store: StoreName, value: any): Promise<void> {
    if (store === 'files') return legacyFiles.putRaw('files', value)
    return put(store, value)
  }

  async function putMany(store: StoreName, rows: any[]): Promise<void> {
    if (!rows.length) return
    if (store === 'files') return legacyFiles.putMany('files', rows)
    await open()
    // A 5000-chapter import is one call from the app, but pushing 5000
    // statements through the bridge at once is a large payload; 400-statement
    // transactions keep memory bounded and still avoid a write per chapter.
    const BATCH = 400
    for (let i = 0; i < rows.length; i += BATCH) {
      const set = rows.slice(i, i + BATCH).map(value => statementFor(store as SqlStore, value))
      await requireDb().executeSet(set, true)
    }
  }

  async function del(store: StoreName, key: StoreKey): Promise<void> {
    if (store === 'files') return legacyFiles.delete('files', key)
    await open()
    if (store === 'chapters') {
      const [bookId, index] = key as [string, number]
      await requireDb().run('DELETE FROM chapters WHERE book_id = ? AND idx = ?', [bookId, index])
      return
    }
    await requireDb().run(`DELETE FROM ${TABLES[store as SqlStore]} WHERE id = ?`, [String(key)])
  }

  async function deleteByIndex(store: StoreName, index: string, key: string | number): Promise<void> {
    if (store === 'files') return legacyFiles.deleteByIndex('files', index, key)
    const table = TABLES[store as SqlStore]
    if (index !== 'bookId' || !BOOK_INDEXED.includes(store as SqlStore)) return
    await open()
    await requireDb().run(`DELETE FROM ${table} WHERE book_id = ?`, [String(key)])
  }

  async function clear(store: StoreName): Promise<void> {
    if (store === 'files') return legacyFiles.clear('files')
    await open()
    await requireDb().run(`DELETE FROM ${TABLES[store as SqlStore]}`)
  }

  async function isMigrated(): Promise<boolean> {
    await open()
    const res = await requireDb().query(`SELECT value FROM meta WHERE key = 'migrated'`)
    return res.values?.[0]?.value === '1'
  }

  async function markMigrated(): Promise<void> {
    await open()
    await requireDb().run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated', '1')`)
  }

  async function close(): Promise<void> {
    await legacyFiles.close()
    if (db) {
      try { await db.close() } catch { /* already closed */ }
      db = null
    }
  }

  return {
    open,
    get,
    getAll,
    getAllByIndex,
    count,
    put,
    putRaw,
    putMany,
    delete: del,
    deleteByIndex,
    clear,
    close,
    isMigrated,
    markMigrated,
  }
}
