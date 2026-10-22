import { dbGet, dbPut } from '@/utils/db'

export interface ReadingSession {
  bookId: string
  totalMs: number
  lastAt: number
}

/** Accumulate foreground reading duration for a book. */
export async function addReadingTime(bookId: string, deltaMs: number): Promise<number> {
  if (!isFinite(deltaMs) || deltaMs <= 0) return 0
  // Ignore absurd deltas (app suspended for hours, device sleep, clocks).
  const delta = Math.min(deltaMs, 6 * 60 * 60 * 1000)

  const cur = await dbGet<ReadingSession>('sessions', bookId)
  const totalMs = (cur?.totalMs || 0) + delta
  await dbPut('sessions', { bookId, totalMs, lastAt: Date.now() })
  return totalMs
}

export async function getReadingTime(bookId: string): Promise<number> {
  const s = await dbGet<ReadingSession>('sessions', bookId)
  return s?.totalMs || 0
}

export async function getAllReadingTime(): Promise<number> {
  const { dbGetAll } = await import('@/utils/db')
  const all = await dbGetAll<ReadingSession>('sessions')
  return all.reduce((sum, s) => sum + (s.totalMs || 0), 0)
}

/** Format like WeRead: "35 小时 6 分钟" */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  if (totalMin < 1) return '不足 1 分钟'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h <= 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

/**
 * Same duration, split into segments so the caller can set the numbers in the
 * stat style WeRead uses ("35**小时**6**分钟**" — figures large, units small).
 */
export interface DurationSegment {
  text: string
  strong: boolean
}

export function durationSegments(ms: number): DurationSegment[] {
  const totalMin = Math.floor(ms / 60000)
  if (totalMin < 1) {
    return [
      { text: '不足', strong: false },
      { text: '1', strong: true },
      { text: '分钟', strong: false },
    ]
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const segs: DurationSegment[] = []
  if (h > 0) {
    segs.push({ text: String(h), strong: true }, { text: '小时', strong: false })
  }
  if (m > 0 || h === 0) {
    segs.push({ text: String(m), strong: true }, { text: '分钟', strong: false })
  }
  return segs
}
