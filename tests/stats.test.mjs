// Daily buckets power the 30-day chart and the goal card; the streak must not
// reset just because today has not been read yet.
import 'fake-indexeddb/auto'
import { dbGet } from '../src/utils/db.ts'
import { addReadingTime, getDailyReading, readingStreak } from '../src/utils/reading-time.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const emptyToday = [
  { date: '2026-10-21', ms: 1000 },
  { date: '2026-10-22', ms: 1000 },
  { date: '2026-10-23', ms: 0 },
]
check('streak survives an empty today', readingStreak(emptyToday) === 2, String(readingStreak(emptyToday)))
check('today extends the streak', readingStreak([...emptyToday.slice(0, 2), { date: '2026-10-23', ms: 1 }]) === 3)
check('a gap stops the streak', readingStreak([{ date: 'a', ms: 0 }, { date: 'b', ms: 5 }, { date: 'c', ms: 5 }]) === 2)
check('no reading means no streak', readingStreak([{ date: 'a', ms: 0 }]) === 0)

const before = new Date()
const p = (n) => String(n).padStart(2, '0')
const today = `${before.getFullYear()}-${p(before.getMonth() + 1)}-${p(before.getDate())}`

await addReadingTime('b1', 5 * 60 * 1000)
const bucket = await dbGet('daily', today)
check('daily bucket written with the session', bucket?.ms === 5 * 60 * 1000, JSON.stringify(bucket))

const days = await getDailyReading(30)
check('chart always has 30 days', days.length === 30, String(days.length))
check('today is the last bucket', days.at(-1).date === today, days.at(-1)?.date)
check('today holds the session time', days.at(-1).ms === 5 * 60 * 1000, String(days.at(-1)?.ms))
check('missing days report zero', days[0].ms === 0, String(days[0]?.ms))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
