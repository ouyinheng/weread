import 'fake-indexeddb/auto'
import { addReadingTime, getReadingTime, formatDuration } from '../src/utils/reading-time.ts'

let fail = 0
const check = (n, c, e='') => { console.log(c?'ok  ':'FAIL', n, c?'':e); if(!c) fail++ }

check('format 0', formatDuration(0) === '不足 1 分钟', formatDuration(0))
check('format 30s', formatDuration(30000) === '不足 1 分钟', formatDuration(30000))
check('format 5min', formatDuration(5*60000) === '5 分钟', formatDuration(5*60000))
check('format 2h', formatDuration(2*3600000) === '2 小时', formatDuration(2*3600000))
check('format 35h6m', formatDuration(35*3600000 + 6*60000) === '35 小时 6 分钟', formatDuration(35*3600000+6*60000))

check('initial 0', (await getReadingTime('b1')) === 0)
await addReadingTime('b1', 60000)
check('after 1min', (await getReadingTime('b1')) === 60000, String(await getReadingTime('b1')))
await addReadingTime('b1', 30000)
check('accumulates', (await getReadingTime('b1')) === 90000, String(await getReadingTime('b1')))

// guards
await addReadingTime('b1', -5000)
check('negative ignored', (await getReadingTime('b1')) === 90000)
await addReadingTime('b1', NaN)
check('NaN ignored', (await getReadingTime('b1')) === 90000)
await addReadingTime('b1', 99*3600000)
const capped = await getReadingTime('b1')
check('absurd delta capped at 6h', capped === 90000 + 6*3600000, String(capped))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail?1:0)
