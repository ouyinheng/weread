/**
 * Local backup and restore.
 *
 * Everything this app owns lives in IndexedDB, which the system can wipe when
 * the user clears app data or move phones. A backup is therefore not a nice-to-
 * have: it is the only way out of "all books and notes are gone".
 *
 * Format: a zip holding
 *   weread-backup.json   metadata + every text store, as JSON
 *   files/<bookId>.bin   the original imported bytes, uncompressed
 *
 * The bytes are kept out of the JSON on purpose: base64 would inflate a 20 MB
 * novel to 27 MB of string, and JSON.stringify of a whole library can exhaust
 * memory long before the zip does.
 */
import { reactive } from 'vue'
import JSZip from 'jszip'
import { dbClear, dbGetAll, dbPutMany, dbPutRaw } from '@/utils/db'
import { saveFile } from '@/utils/save-file'
import type { StoredFile } from '@/utils/library'

const META_FILE = 'weread-backup.json'
const FORMAT = 1

/** Text stores restored as-is. `files` is handled separately (binary). */
const DATA_STORES = [
  'books',
  'chapters',
  'bookmarks',
  'highlights',
  'sessions',
  'settings',
  'sources',
  'daily',
] as const

type DataStore = (typeof DATA_STORES)[number]

interface BackupMeta {
  app: 'weread'
  format: number
  exportedAt: string
  files: { bookId: string; name: string; path: string }[]
  data: Partial<Record<DataStore, unknown[]>>
}

export interface BackupProgress {
  busy: boolean
  phase: '' | 'export' | 'import'
  /** Units finished / total, where one unit is a store or a book file. */
  current: number
  total: number
  message: string
}

export const backupProgress = reactive<BackupProgress>({
  busy: false,
  phase: '',
  current: 0,
  total: 0,
  message: '',
})

function begin(phase: 'export' | 'import', total: number, message: string): void {
  backupProgress.busy = true
  backupProgress.phase = phase
  backupProgress.current = 0
  backupProgress.total = total
  backupProgress.message = message
}

function tick(current: number): void {
  backupProgress.current = Math.min(backupProgress.total, current)
}

function reset(): void {
  backupProgress.busy = false
  backupProgress.phase = ''
  backupProgress.current = 0
  backupProgress.total = 0
  backupProgress.message = ''
}

export interface RestoreResult {
  books: number
  files: number
  highlights: number
}

/** Build the zip in memory. The caller decides where it goes. */
export async function exportBackup(): Promise<Blob> {
  if (backupProgress.busy) throw new Error('已有备份任务在进行')

  const files = await dbGetAll<StoredFile>('files')
  const total = DATA_STORES.length + files.length + 1
  begin('export', total, '正在整理数据…')

  try {
    const data: Partial<Record<DataStore, unknown[]>> = {}
    let done = 0
    for (const store of DATA_STORES) {
      data[store] = await dbGetAll(store)
      tick(++done)
      backupProgress.message = `正在读取数据 ${done}/${DATA_STORES.length}`
    }

    const zip = new JSZip()
    const metaFiles: BackupMeta['files'] = []
    for (const f of files) {
      if (!f?.bookId || !f.bytes) { tick(++done); continue }
      const path = `files/${f.bookId}.bin`
      zip.file(path, new Uint8Array(f.bytes))
      metaFiles.push({ bookId: f.bookId, name: f.name || '', path })
      tick(++done)
      backupProgress.message = `正在打包书籍 ${done - DATA_STORES.length}/${files.length}`
    }

    const meta: BackupMeta = {
      app: 'weread',
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      files: metaFiles,
      data,
    }
    zip.file(META_FILE, JSON.stringify(meta))

    backupProgress.message = '正在生成备份文件…'
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      md => {
        // Compression progress covers the whole archive; map it onto the bar.
        tick(Math.round(total * (md.percent || 0) / 100))
      },
    )
    tick(total)
    return blob
  } finally {
    reset()
  }
}

export type BackupSaveResult = import('@/utils/save-file').SaveResult

/**
 * Put the backup somewhere the user can find it.
 *
 * The filename carries the timestamp so repeated backups do not overwrite each
 * other; the actual delivery (native 下载 collection / Web Share / download) is
 * shared with 笔记导出.
 */
export async function saveBackup(blob: Blob): Promise<BackupSaveResult> {
  const d = new Date()
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
    `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  return saveFile(blob, `微读备份-${stamp}.zip`, 'application/zip')
}

/**
 * Restore a backup over the current library.
 *
 * Deliberately destructive: a restore that merged would leave duplicate books
 * and half-old settings. The settings page confirms before calling this.
 */
export async function importBackup(file: File): Promise<RestoreResult> {
  if (backupProgress.busy) throw new Error('已有备份任务在进行')

  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const metaEntry = zip.file(META_FILE)
  if (!metaEntry) throw new Error('这不是微读的备份文件')

  let meta: BackupMeta
  try {
    meta = JSON.parse(await metaEntry.async('string'))
  } catch {
    throw new Error('备份文件已损坏')
  }
  if (meta?.app !== 'weread' || meta.format !== FORMAT || !meta.data) {
    throw new Error('备份格式不兼容')
  }

  const metaFiles = Array.isArray(meta.files) ? meta.files : []
  const total = DATA_STORES.length + metaFiles.length
  begin('import', total, '正在恢复数据…')

  try {
    let done = 0
    for (const store of DATA_STORES) {
      await dbClear(store)
      const rows = meta.data[store]
      if (Array.isArray(rows) && rows.length) await dbPutMany(store, rows)
      tick(++done)
      backupProgress.message = `正在恢复数据 ${done}/${DATA_STORES.length}`
    }

    let restoredFiles = 0
    for (const f of metaFiles) {
      const entry = zip.file(f.path) || (f.bookId ? zip.file(`files/${f.bookId}.bin`) : null)
      if (entry) {
        const bytes = await entry.async('arraybuffer')
        await dbPutRaw('files', { bookId: f.bookId, name: f.name || '', bytes })
        restoredFiles++
      }
      tick(++done)
      backupProgress.message = `正在恢复书籍 ${done - DATA_STORES.length}/${metaFiles.length}`
    }

    const data = meta.data
    return {
      books: Array.isArray(data.books) ? data.books.length : 0,
      files: restoredFiles,
      highlights: Array.isArray(data.highlights) ? data.highlights.length : 0,
    }
  } finally {
    reset()
  }
}
