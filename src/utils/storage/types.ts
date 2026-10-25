/**
 * Storage abstraction shared by the two backends.
 *
 * `db.ts` is the only file the rest of the app talks to. Which driver sits
 * underneath depends on the platform:
 *
 *  - Android shell → SQLite (reliable, survives WebView storage eviction)
 *  - browser / tests → IndexedDB (vite dev, CDP e2e, fake-indexeddb)
 *
 * The `files` store (original book bytes) always stays in IndexedDB for now.
 * The plugin returns BLOBs as number arrays and binding raw bytes through the
 * bridge is unproven, so moving 20 MB novels there would risk corruption for no
 * immediate benefit. The migration only moves text data; the bytes are handled
 * when they move to the filesystem in the next step.
 */
export const STORES = [
  'books',
  'chapters',
  'settings',
  'bookmarks',
  'sessions',
  'files',
  'highlights',
  'sources',
  'daily',
] as const

export type StoreName = (typeof STORES)[number]

export type StoreKey = string | number | [string, number]

/** Which backend a driver instance talks to. */
export type Backend = 'sqlite' | 'indexeddb'

export interface DBDriver {
  /**
   * Identity of the backend, not a capability flag: the settings page shows it
   * so "did the migration actually take effect" is answerable on a real device
   * instead of by reading code.
   */
  readonly backend: Backend
  open(): Promise<void>
  get(store: StoreName, key: StoreKey): Promise<any>
  getAll(store: StoreName): Promise<any[]>
  getAllByIndex(store: StoreName, index: string, key: string | number): Promise<any[]>
  count(store: StoreName): Promise<number>
  put(store: StoreName, value: any): Promise<void>
  putRaw(store: StoreName, value: any): Promise<void>
  putMany(store: StoreName, rows: any[]): Promise<void>
  delete(store: StoreName, key: StoreKey): Promise<void>
  /** Remove many keys in as few round-trips as possible (one transaction per driver batch). */
  deleteMany(store: StoreName, keys: StoreKey[]): Promise<void>
  deleteByIndex(store: StoreName, index: string, key: string | number): Promise<void>
  clear(store: StoreName): Promise<void>
  close(): Promise<void>
}

/** localStorage flag: set once the SQLite copy is complete and verified. */
export const SQLITE_FLAG = 'weread.storage.sqlite'
