/** 真机：进入「视频源管理」并导入 5 个视频源（走真实 UI 路径）。 */
import { connect } from './device.mjs'

const SOURCES = [
  { name: '暴风资源', api: 'https://bfzyapi.com/api.php/provide/vod/' },
  { name: '飘零资源', api: 'https://p2100.net/api.php/provide/vod/' },
  { name: '360资源', api: 'https://360zy.com/api.php/provide/vod/' },
  { name: '魔都资源', api: 'https://www.mdzyapi.com/api.php/provide/vod/' },
  { name: '百度资源', api: 'https://api.apibdzy.com/api.php/provide/vod/' },
]

const d = await connect(9333)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 先退回 tab 页（设置页没有底栏），再点「我」
for (let i = 0; i < 3; i++) {
  const p = await d.evaluate('location.pathname')
  if (p === '/shelf' || p === '/me' || p === '/tv') break
  await d.evaluate(`(() => {
    const back = document.querySelector('.settings-back, .font-back, .src-back, .catalog-back, .search__back')
    if (back) { back.click(); return 'back' }
    history.back(); return 'history'
  })()`)
  await sleep(700)
}
await d.evaluate(`(() => {
  const me = [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === '我')
  me && me.click(); return !!me
})()`)
await sleep(800)
console.log('route:', await d.evaluate('location.pathname'))

// 点「视频源管理」
const entered = await d.evaluate(`(() => {
  const row = [...document.querySelectorAll('.me__row')].find(x => x.textContent.includes('视频源管理'))
  if (!row) return 'no-row'
  row.click(); return 'ok'
})()`)
await sleep(900)
console.log('进入视频源:', entered, await d.evaluate('location.pathname'))

// 展开导入面板 → 填 JSON → 导入
const res = await d.evaluate(`(async () => {
  const open = document.querySelector('.tv-src__import-btn')
  if (!open) return 'no-import-btn'
  open.click()
  await new Promise(r => setTimeout(r, 400))
  const ta = document.querySelector('.tv-src__textarea')
  if (!ta) return 'no-textarea'
  const json = ${JSON.stringify(JSON.stringify(SOURCES, null, 2))}
  ta.value = json
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  document.querySelector('.tv-src__primary')?.click()
  await new Promise(r => setTimeout(r, 1500))
  return 'done'
})()`)
console.log('导入结果:', res)
await d.screenshot('/tmp/dev-src-imported.png')

const state = await d.evaluate(`(() => ({
  path: location.pathname,
  text: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 700),
  toggles: [...document.querySelectorAll('.toggle')].map(t => t.className),
}))()`)
console.log(JSON.stringify(state, null, 1))
d.close()
