/**
 * One-time IndexedDB → SQLite migration.
 *
 * Runs in the background while the app keeps reading from IndexedDB. The switch
 * itself happens as soon as the copy is verified: the driver is replaced with
 * the SQLite one in the same session, so nothing written afterwards can land in
 * the store that is about to be abandoned. (An earlier version deferred the
 * switch to the next launch — everything imported or read in between was
 * written to IndexedDB and then silently lost.)
 *
 * A failed migration still never touches the live library: the flag is only set
 * after the row counts match, and the working IndexedDB backend stays in place.
 */
import { reactive } from 'vue'
import { isNativeShell } from '@/utils/native'
import { resetDriver } from '@/utils/db'
import { createIdbDriver } from './idb-driver'
import { createSqliteDriver } from './sqlite-driver'
import { copyLibrary } from './copy'
import { SQLITE_FLAG } from './types'

export interface MigrationProgress {
  busy: boolean
  done: number
  total: number
  message: string
  error: string
  /** Copy verified and this session already switched to SQLite. */
  completed: boolean
}

export const migrationState = reactive<MigrationProgress>({
  busy: false,
  done: 0,
  total: 0,
  message: '',
  error: '',
  completed: false,
})

/**
 * Kick off the migration without blocking startup. Never throws: a failure
 * leaves the flag unset, so the next launch keeps using IndexedDB.
 */
export async function migrateToSqliteInBackground(): Promise<void> {
  if (!isNativeShell()) return
  if (localStorage.getItem(SQLITE_FLAG) === '1') return
  if (migrationState.busy || migrationState.completed) return

  const target = createSqliteDriver()
  /** Set once the SQLite copy is trustworthy; drives the in-session switch. */
  let switchNow = false
  try {
    await target.open()
    // A previous run may have finished even if localStorage lost the flag.
    if (await target.isMigrated()) {
      localStorage.setItem(SQLITE_FLAG, '1')
      migrationState.completed = true
      migrationState.message = '数据已在 SQLite 中'
      switchNow = true
      return
    }

    const source = createIdbDriver()
    await source.open()
    const books = await source.getAll('books')
    // Nothing to migrate yet. Do not flip the flag: anything imported during
    // this session must not be stranded in a store the next launch ignores.
    if (!books.length) {
      await source.close()
      return
    }

    migrationState.busy = true
    migrationState.error = ''
    migrationState.total = books.length + 5

    const result = await copyLibrary(source, target, (done, total, message) => {
      migrationState.done = done
      migrationState.total = total
      migrationState.message = message
    })

    await target.markMigrated()
    localStorage.setItem(SQLITE_FLAG, '1')
    migrationState.completed = true
    migrationState.message = `已迁移 ${result.books} 本书、${result.chapters} 章`
    await source.close()
    switchNow = true
  } catch (e) {
    // Keep the working IndexedDB backend; the next launch tries again.
    migrationState.error = (e as Error)?.message || '迁移失败'
    console.warn('[storage] SQLite migration failed', e)
  } finally {
    migrationState.busy = false
    migrationState.done = 0
    migrationState.total = 0
    // Close the migration's own handle before replacing the live driver: the
    // plugin will not hand out a second connection for the same database name.
    await target.close().catch(() => undefined)
    /*
     * Hand the session over to SQLite now. The in-memory stores were read from
     * IndexedDB, but the copy just verified every row and reconciled anything
     * that changed mid-run, so both sides agree and no reload is needed.
     */
    if (switchNow) await resetDriver()
  }
}
