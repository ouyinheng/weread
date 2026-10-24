/**
 * Storage failures must not disappear.
 *
 * The app once lost every progress write because a `DataCloneError` was
 * swallowed by an empty catch. The silent-failure lesson is now a rule: a
 * failure the user would care about is recorded here and surfaced once in 「我」,
 * with the full detail going to the console for whoever is debugging.
 *
 * This is a session-level list on purpose: it is a "something did not save"
 * notice, not a log file.
 */
import { reactive } from 'vue'

export interface StorageIssue {
  message: string
  at: number
}

export const storageIssues = reactive<StorageIssue[]>([])

export function reportStorageIssue(message: string, error?: unknown): void {
  console.warn('[storage]', message, error)
  if (storageIssues.some(i => i.message === message)) return
  storageIssues.push({ message, at: Date.now() })
  if (storageIssues.length > 20) storageIssues.splice(0, storageIssues.length - 20)
}
