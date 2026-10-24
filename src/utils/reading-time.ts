import { dbGet, dbGetAll, dbPut } from '@/utils/db'

export interface ReadingSession {
  bookId: string
  totalMs: number
  lastAt: number
}

/** One calendar day of reading, used by the 30-day chart. */
export interface DailyReading {
  /** `YYYY-MM-DD`, local time. */
  id: string
  ms: number
}

function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Accumulate foreground reading duration for a book (and for the day). */
export async function addReadingTime(bookId: string, deltaMs: number): Promise<number> {
  if (!isFinite(deltaMs) || deltaMs <= 0) return 0
  // Ignore absurd deltas (app suspended for hours, device sleep, clocks).
  const delta = Math.min(deltaMs, 6 * 60 * 60 * 1000)

  const cur = await dbGet<ReadingSession>('sessions', bookId)
  const totalMs = (cur?.totalMs || 0) + delta
  await dbPut('sessions', { bookId, totalMs, lastAt: Date.now() })

  // The daily bucket is what the 30-day chart reads; keep it in the same call
  // so the two can never disagree about how long the session was.
  const key = dayKey()
  const day = await dbGet<DailyReading>('daily', key)
  await dbPut('daily', { id: key, ms: (day?.ms || 0) + delta })
  return totalMs
}

export async function getReadingTime(bookId: string): Promise<number> {
  const s = await dbGet<ReadingSession>('sessions', bookId)
  return s?.totalMs || 0
}

export async function getAllReadingTime(): Promise<number> {
  const all = await dbGetAll<ReadingSession>('sessions')
  return all.reduce((sum, s) => sum + (s.totalMs || 0), 0)
}

/**
 * The last `days` calendar days, including zero days, ready for a bar chart.
 * Local dates on purpose: a reader's "yesterday" is their device's yesterday.
 */
export async function getDailyReading(days = 30): Promise<{ date: string; ms: number }[]> {
  const all = await dbGetAll<DailyReading>('daily')
  const byDay = new Map(all.map(d => [d.id, d.ms || 0]))
  const out: { date: string; ms: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = dayKey(d)
    out.push({ date: key, ms: byDay.get(key) || 0 })
  }
  return out
}

/** Consecutive days with reading, counting back from today. */
export function readingStreak(list: { date: string; ms: number }[]): number {
  let streak = 0
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].ms > 0) streak++
    else break
  }
  return streak
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
