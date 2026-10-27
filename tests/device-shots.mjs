/** 真机产品截图：影视首页 / 详情 / 播放页（控制栏）/ 投屏面板 / 我。 */
import { connect } from './device.mjs'

const d = await connect(9333)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const OUT = '/Users/ouyinheng/Documents/GitHub/weread/app/weread/assets/screenshots'

await d.goTab('影视')
await sleep(1200)
await d.screenshot(`${OUT}/tv-home.png`)
console.log('影视首页 ok')

await d.evaluate(`document.querySelector('.tv__search')?.click(); true`)
await sleep(900)
await d.evaluate(`(async () => {
  const i = document.querySelector('.tv-search__input')
  i.value = '虚颜'; i.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  document.querySelector('.tv-search__submit')?.click(); return true
})()`)
await sleep(6000)
await d.screenshot(`${OUT}/tv-search.png`)

await d.evaluate(`document.querySelector('.tv-card')?.click(); true`)
await sleep(2800)
await d.screenshot(`${OUT}/tv-detail.png`)

await d.evaluate(`document.querySelector('.tv-actions__primary')?.click(); true`)
await sleep(8000)
// 暂停 + 显示控制栏，截图里才有控件
await d.evaluate(`(() => { const v = document.querySelector('video'); if (v && !v.paused) v.pause(); return true })()`)
const r = await d.evaluate(`(() => { const b = document.querySelector('.tv-play__screen').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
d.tap(r.x, r.y)
await sleep(700)
await d.screenshot(`${OUT}/tv-player.png`)
console.log('播放页 ok')

// 投屏面板
await d.evaluate(`(() => {
  const cast = document.querySelector('.art-control-cast')
  cast && cast.click(); return !!cast
})()`)
await sleep(4200)
await d.screenshot(`${OUT}/tv-cast.png`)
console.log('投屏面板 ok')
await d.evaluate(`document.querySelector('.cast__close')?.click(); true`)
await sleep(400)

await d.goTab('我')
await sleep(1000)
await d.screenshot(`${OUT}/me.png`)
console.log('我 ok')

d.close()
