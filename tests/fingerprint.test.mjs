// Import dedup relies on a content fingerprint: same bytes, same digest,
// regardless of the filename the user picked.
import { fingerprintOf } from '../src/utils/fingerprint.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const bytes = new TextEncoder().encode('第一章 开始\n正文正文正文').buffer
const a = await fingerprintOf(bytes)
const b = await fingerprintOf(bytes.slice(0))
const other = await fingerprintOf(new TextEncoder().encode('另一个文件').buffer)

check('fingerprint is a sha-256 hex string', /^[0-9a-f]{64}$/.test(a), a)
check('same bytes produce the same fingerprint', a === b, `${a} vs ${b}`)
check('different bytes differ', a !== other, a)
check('empty buffer has a stable digest', /^[0-9a-f]{64}$/.test(await fingerprintOf(new ArrayBuffer(0))))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
