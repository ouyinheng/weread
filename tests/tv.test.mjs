/**
 * 影视模块的纯函数：地址归一化 + CMS 播放地址解析。
 *
 * 这两个函数是「源能不能用」的第一道关口——`vod_play_url` 的格式在采集站之间
 * 千奇百怪（缺集名、多线路、夹广告位），解析错了表现为「有详情但点播放没反应」，
 * 所以按真实格式逐个锁住。
 */
import { normalizeApi, parsePlayGroups } from '../src/utils/tv/parse.ts'
import { homeTab, visibleTabs } from '../src/router/tabs.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- normalizeApi ---------- */

check('adds https when missing', normalizeApi('example.com/api.php/provide/vod') === 'https://example.com/api.php/provide/vod/')
check('keeps http', normalizeApi('http://a.com/api.php/provide/vod/') === 'http://a.com/api.php/provide/vod/')
check('keeps https and trailing slash', normalizeApi('https://a.com/vod/') === 'https://a.com/vod/')
check('trims whitespace', normalizeApi('  https://a.com/vod  ') === 'https://a.com/vod/')
check('empty stays empty', normalizeApi('   ') === '')

/* ---------- parsePlayGroups ---------- */

const single = parsePlayGroups('第1集$https://a.com/1.m3u8#第2集$https://a.com/2.m3u8', 'm3u8')
check('single line -> one group', single.length === 1, String(single.length))
check('single line episodes', single[0].episodes.length === 2, String(single[0].episodes.length))
check('episode names kept', single[0].episodes[1].name === '第2集', single[0].episodes[1].name)
check('episode urls kept', single[0].episodes[1].url === 'https://a.com/2.m3u8', single[0].episodes[1].url)
check('group name from vod_play_from', single[0].name === 'm3u8', single[0].name)

const multi = parsePlayGroups(
  '第1集$https://a.com/1.m3u8#第2集$https://a.com/2.m3u8$$$第1集$https://b.com/1.m3u8',
  '线路一$$$线路二',
)
check('multi line -> two groups', multi.length === 2, String(multi.length))
check('multi names follow vod_play_from', multi.map(g => g.name).join(',') === '线路一,线路二', multi.map(g => g.name).join(','))
check('second group kept shorter', multi[1].episodes.length === 1, String(multi[1].episodes.length))
check('empty group dropped', parsePlayGroups('$$$第1集$https://a.com/1.m3u8', '').length === 1)

const unnamed = parsePlayGroups('https://a.com/1.m3u8#https://a.com/2.m3u8', '')
check('missing names fall back to 第N集', unnamed[0].episodes.map(e => e.name).join(',') === '第1集,第2集', unnamed[0].episodes.map(e => e.name).join(','))
check('missing from falls back to 线路 N', unnamed[0].name === '线路 1', unnamed[0].name)

const dirty = parsePlayGroups('第1集$https://a.com/1.m3u8#广告$#第2集$javascript:alert(1)#第3集$https://a.com/3.m3u8', '')
check('non-http entries dropped', dirty[0].episodes.length === 2, String(dirty[0].episodes.length))
check('dropped entries do not shift names', dirty[0].episodes[1].name === '第3集', dirty[0].episodes[1].name)

check('empty raw -> no groups', parsePlayGroups('', 'm3u8').length === 0)
check('undefined raw -> no groups', parsePlayGroups(undefined, undefined).length === 0)

/* ---------- 底栏入口开关（书架 / 影视 各一个） ---------- */

const bar = v => visibleTabs(v).map(t => t.name).join(',')

check('tv tab hidden by default', bar({ showShelfTab: true, showTvTab: false }) === 'shelf,me', bar({ showShelfTab: true, showTvTab: false }))
check('tv tab shown once enabled', bar({ showShelfTab: true, showTvTab: true }) === 'shelf,tv,me', bar({ showShelfTab: true, showTvTab: true }))
check('shelf tab hideable', bar({ showShelfTab: false, showTvTab: false }) === 'me', bar({ showShelfTab: false, showTvTab: false }))
check('shelf hidden, tv kept', bar({ showShelfTab: false, showTvTab: true }) === 'tv,me', bar({ showShelfTab: false, showTvTab: true }))

/* 隐藏当前 tab 后的落点：第一个还在的 tab，「我」永远兜底。 */
check('home prefers shelf', homeTab({ showShelfTab: true, showTvTab: true }) === 'shelf', homeTab({ showShelfTab: true, showTvTab: true }))
check('home skips hidden shelf', homeTab({ showShelfTab: false, showTvTab: true }) === 'tv', homeTab({ showShelfTab: false, showTvTab: true }))
check('home never empty', homeTab({ showShelfTab: false, showTvTab: false }) === 'me', homeTab({ showShelfTab: false, showTvTab: false }))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
