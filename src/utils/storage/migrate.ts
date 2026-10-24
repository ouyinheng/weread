/**
 * One-time IndexedDB → SQLite migration.
 *
 * Runs in the background while the app keeps reading from IndexedDB, and only
 * flips the switch for the *next* session. That ordering is deliberate: a
 * failed migration must never be able to take the working library down with it.
 */
import { reactive } from 'vue'
import { isNativeShell } from '@/utils/native'
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
  /** Completed in this session; takes effect on the next launch. */
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
  try {
    await target.open()
    // A previous run may have finished even if localStorage lost the flag.
    if (await target.isMigrated()) {
      localStorage.setItem(SQLITE_FLAG, '1')
      migrationState.completed = true
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
    migrationState.message = `已迁移 ${result.books} 本书、${result.chapters} 章，下次启动生效`
    await source.close()
  } catch (e) {
    // Keep the working IndexedDB backend; the next launch tries again.
    migrationState.error = (e as Error)?.message || '迁移失败'
    console.warn('[storage] SQLite migration failed', e)
  } finally {
    migrationState.busy = false
    migrationState.done = 0
    migrationState.total = 0
    // This session still uses IndexedDB; release the SQLite handle until the
    // next launch picks it up.
    await target.close().catch(() => undefined)
  }
}
