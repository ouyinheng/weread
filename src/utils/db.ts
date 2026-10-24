/**
 * The app's single storage entry point.
 *
 * Everything below the exported functions is a driver: SQLite on Android,
 * IndexedDB in the browser and the test suite. Callers never know which one is
 * active, which is what let the SQLite migration land without touching views or
 * stores.
 */
import { isNativeShell } from '@/utils/native'
import { createIdbDriver } from '@/utils/storage/idb-driver'
import { createSqliteDriver } from '@/utils/storage/sqlite-driver'
import { SQLITE_FLAG, type DBDriver, type StoreKey, type StoreName } from '@/utils/storage/types'

let driverPromise: Promise<DBDriver> | null = null

/**
 * Pick the backend once per app session.
 *
 * SQLite wins on Android only after the one-time migration has been verified
 * (flag in localStorage, duplicated in the database's `meta` table so a lost
 * localStorage cannot silently send the app back to a stale IndexedDB copy).
 */
async function chooseDriver(): Promise<DBDriver> {
  if (isNativeShell()) {
    const flagged = localStorage.getItem(SQLITE_FLAG) === '1'
    try {
      const sqlite = createSqliteDriver()
      await sqlite.open()
      if (flagged || await sqlite.isMigrated()) {
        if (!flagged) localStorage.setItem(SQLITE_FLAG, '1')
        return sqlite
      }
      // Not migrated yet: keep reading the live IndexedDB library.
      await sqlite.close()
    } catch (e) {
      // Plugin missing or the database cannot be opened: the app still reads.
      console.warn('[storage] SQLite unavailable, using IndexedDB', e)
    }
  }
  return createIdbDriver()
}

export function getDriver(): Promise<DBDriver> {
  if (!driverPromise) driverPromise = chooseDriver()
  return driverPromise
}

export async function dbGet<T>(store: StoreName, key: StoreKey): Promise<T | undefined> {
  return (await (await getDriver()).get(store, key)) as T | undefined
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return (await (await getDriver()).getAll(store)) as T[]
}

/** Per-book read (chapters/bookmarks/highlights) without loading the whole store. */
export async function dbGetAllByIndex<T>(store: StoreName, index: string, key: string | number): Promise<T[]> {
  return (await (await getDriver()).getAllByIndex(store, index, key)) as T[]
}

export async function dbCount(store: StoreName): Promise<number> {
  return (await getDriver()).count(store)
}

export async function dbPut(store: StoreName, value: any): Promise<void> {
  await (await getDriver()).put(store, value)
}

/** Binary-safe write; see the driver's `putRaw`. */
export async function dbPutRaw(store: StoreName, value: any): Promise<void> {
  await (await getDriver()).putRaw(store, value)
}

/** Write many records inside a single transaction. */
export async function dbPutMany(store: StoreName, rows: any[]): Promise<void> {
  await (await getDriver()).putMany(store, rows)
}

export async function dbDelete(store: StoreName, key: StoreKey): Promise<void> {
  await (await getDriver()).delete(store, key)
}

export async function dbDeleteByIndex(store: StoreName, index: string, key: string | number): Promise<void> {
  await (await getDriver()).deleteByIndex(store, index, key)
}

/** Empty a store in one transaction (backup restore starts from a clean slate). */
export async function dbClear(store: StoreName): Promise<void> {
  await (await getDriver()).clear(store)
}
