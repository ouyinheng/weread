/**
 * 订阅导入的解析：只收「直连类」CMS 接口，其余计数跳过。
 *
 * 这份规则是照 LibreTV 的 tvbox-parser 抄的，重点不是「多收」，而是**别把
 * 跑不起来的条目收进来**——TVBOX 配置里一半以上是 Spider（csp_xxx / jar /
 * js），收进来就是一条点了必报错的死源。
 */
import { describeSkips, parseSubscription } from '../src/utils/tv/subscription.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- TVBOX 配置 ---------- */

const tvbox = JSON.stringify({
  sites: [
    { key: 'cms1', name: '采集一', type: 1, api: 'https://a.com/api.php/provide/vod/', searchable: 1, disabled: 0 },
    { key: 'cms2', name: '采集二', api: 'https://b.com/api.php/provide/vod' },
    { key: 'sp1', name: 'Spider 站', type: 3, api: 'csp_AppYs' },
    { key: 'sp2', name: 'JS 站', type: 3, api: 'https://c.com/spider.js' },
    { key: 'sp3', name: '本地资源', type: 1, api: './json/local.json' },
    { key: 'xml1', name: 'XML 站', type: 0, api: 'https://d.com/api.php/provide/vod/at/xml' },
    { key: 'off', name: '停用的', type: 1, api: 'https://e.com/api.php/provide/vod/', disabled: 1 },
    { key: 'nosearch', name: '不能搜', type: 1, api: 'https://f.com/api.php/provide/vod/', searchable: 0 },
    { key: 'dup', name: '重复的采集一', type: 1, api: 'https://a.com/api.php/provide/vod/' },
  ],
})

const r1 = parseSubscription(tvbox)
check('只收 CMS 直连', r1.sources.length === 2, `got ${r1.sources.length}`)
check('保留了名字', r1.sources[0].name === '采集一')
check('spider 计数 3', r1.skipped.spider === 3, JSON.stringify(r1.skipped))
check('xml 计数 1', r1.skipped.xml === 1, JSON.stringify(r1.skipped))
check('停用计数 1', r1.skipped.disabled === 1, JSON.stringify(r1.skipped))
check('不支持搜索计数 1', r1.skipped.unsearchable === 1, JSON.stringify(r1.skipped))
check('重复接口只留一条', r1.sources.filter(s => s.api.includes('a.com')).length === 1)
check('总数含跳过', r1.total === 9, String(r1.total))

/* ---------- 其它结构 ---------- */

const libre = parseSubscription(JSON.stringify({ customAPIs: [{ name: 'A', url: 'https://a.com/api.php/provide/vod/' }] }))
check('LibreTV 导出可以导入', libre.sources.length === 1)

const bare = parseSubscription(JSON.stringify([{ name: 'B', api: 'https://b.com/api.php/provide/vod/' }]))
check('裸数组可以导入', bare.sources.length === 1)

const ours = parseSubscription(JSON.stringify({ sources: [{ name: 'C', url: 'https://c.com/api.php/provide/vod/' }] }))
check('本 App 导出的 sources 可以再导入', ours.sources.length === 1)

/* ---------- 边界 ---------- */

// type=1 是「JSON 接口」的显式声明，地址长什么样都信它（和 LibreTV 一致）
const typed = parseSubscription(JSON.stringify({ sites: [{ name: 'X', type: 1, api: 'https://x.com/api' }] }))
check('type=1 直接信任', typed.sources.length === 1)

// 没有 type、地址又不像采集站：不能收，收了就是一条死源
const notCms = parseSubscription(JSON.stringify({ sites: [{ name: 'Y', api: 'https://y.com/api' }] }))
check('无 type 且不像 CMS 的跳过', notCms.sources.length === 0 && notCms.skipped.invalid === 1)

const empty = parseSubscription(JSON.stringify({}))
check('空对象不炸', empty.sources.length === 0 && empty.total === 0)

check('跳过说明是人话', describeSkips({ spider: 3, xml: 1, disabled: 0, unsearchable: 0, invalid: 0 }) === 'Spider 引擎 3、XML 接口 1')

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
if (fail) process.exit(1)
