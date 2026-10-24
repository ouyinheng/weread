// Same file imported twice (even under a different name) must land on the
// shelf once. This is the FR-IMPORT-009 regression.
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { importBookFile, DuplicateBookError } from '../src/utils/importer.ts'

setActivePinia(createPinia())

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const text = '第一章 开始\n' + '正文内容。'.repeat(200)
const first = await importBookFile(new File([text], '第一本.txt', { type: 'text/plain' }))
check('first import returns an id', typeof first === 'string' && first.length > 0, first)

let duplicate = null
try {
  await importBookFile(new File([text], '换了个名字.txt', { type: 'text/plain' }))
} catch (e) {
  duplicate = e
}
check('identical bytes are rejected as duplicate', duplicate instanceof DuplicateBookError,
  duplicate && `${duplicate.name}: ${duplicate.message}`)

const other = await importBookFile(new File([text + '\n另一个结尾'], '另一本.txt', { type: 'text/plain' }))
check('different bytes still import', typeof other === 'string' && other !== first, other)

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
