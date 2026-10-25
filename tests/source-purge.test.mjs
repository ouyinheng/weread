// 「清除失效书源」的两条底线：
//  1. 判定只认 health === 3 —— 降级(2) 还能搜到书，未检测(0) 只是没结论，
//     把它们一起清掉，用户下次要用就没得选了。
//  2. 批量删除真的把目标源删干净、不误伤其他源，并且能重复调用。
import 'fake-indexeddb/auto'
import { isDeadSource } from '../src/types/source.ts'
import { dbGetAll, dbPut } from '../src/utils/db.ts'
import { deleteSources, getSource, markHealth, noteSourceFailure } from '../src/utils/source/sourceService.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- 判定 ---------- */
{
  check('health 3 is dead', isDeadSource({ health: 3 }))
  check('health 2 (degraded) is kept', !isDeadSource({ health: 2 }))
  check('health 1 (alive) is kept', !isDeadSource({ health: 1 }))
  check('health 0 (unchecked) is kept', !isDeadSource({ health: 0 }))
}

/* ---------- 批量删除 ---------- */
function src(id, health) {
  return {
    id,
    name: `源 ${id}`,
    url: id,
    group: '',
    type: 0,
    enabled: true,
    raw: { bookSourceUrl: id, bookSourceName: `源 ${id}` },
    health,
    lastCheckAt: 0,
    lastError: '',
    createdAt: 0,
  }
}

{
  await dbPut('sources', src('a', 3))
  await dbPut('sources', src('b', 3))
  await dbPut('sources', src('c', 1))
  await dbPut('sources', src('d', 2))
  // 重复 id 只删一次；空数组不该发请求。
  const removed = await deleteSources(['a', 'b', 'a', ''])
  check('reports unique removed count', removed === 2, String(removed))

  const left = (await dbGetAll('sources')).map(s => s.id).sort()
  check('dead sources gone', !left.includes('a') && !left.includes('b'), JSON.stringify(left))
  check('alive and degraded kept', left.join(',') === 'c,d', JSON.stringify(left))
}

/* ---------- 失败判定：连续两次才判死，成功一次就清零 ---------- */
{
  await dbPut('sources', src('e', 1))
  check('first failure does not kill', (await noteSourceFailure('e', '网络超时')) === 1)
  let row = await getSource('e')
  check(
    'first failure keeps health and records the streak',
    row.health === 1 && row.failStreak === 1,
    JSON.stringify(row)
  )

  check('second failure marks dead', (await noteSourceFailure('e', '网络超时')) === 3)
  row = await getSource('e')
  check(
    'second failure sets health 3',
    row.health === 3 && row.failStreak === 2,
    JSON.stringify(row)
  )

  await markHealth('e', 1, '')
  row = await getSource('e')
  check('a success clears the streak', row.health === 1 && row.failStreak === 0, JSON.stringify(row))

  // Leave the table as the next block expects it.
  await deleteSources(['e'])
}

/* ---------- 重复调用 / 空输入 ---------- */
{
  // 返回值是「提交的唯一条数」，不存在的 id 不会抛错（真实路径里 id 都来自当前列表）。
  const again = await deleteSources(['a', 'b'])
  check('rerun does not throw', again === 2, String(again))
  check('empty list short-circuits', (await deleteSources([])) === 0)
  check('sources still intact', (await dbGetAll('sources')).length === 2)
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
