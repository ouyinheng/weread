/** 真机：影视 → 搜索 <关键词> → 第 <n> 个结果 → 播放。 */
import { connect } from './device.mjs'

const keyword = process.argv[2] || '流浪地球'
const cardIndex = Number(process.argv[3] || 0)

const d = await connect(9333)
const sleep = ms => new Promise(r => setTimeout(r, ms))

await d.goTab('影视')
await d.evaluate(`(() => { document.querySelector('.tv__search')?.click(); return true })()`)
await sleep(900)

await d.evaluate(`(async () => {
  const input = document.querySelector('.tv-search__input')
  input.value = ${JSON.stringify(keyword)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
  document.querySelector('.tv-search__submit')?.click()
  return true
})()`)
await sleep(7000)

const cards = await d.evaluate(`[...document.querySelectorAll('.tv-card')].map(c => c.textContent.replace(/\\s+/g,' ').trim().slice(0, 26))`)
console.log('结果数:', cards.length)
cards.slice(0, 12).forEach((c, i) => console.log(' ', i, c))

const picked = await d.evaluate(`(() => {
  const c = document.querySelectorAll('.tv-card')[${cardIndex}]
  if (!c) return 'none'
  c.click(); return c.textContent.replace(/\\s+/g,' ').trim().slice(0, 30)
})()`)
console.log('打开:', picked)
await sleep(2600)
await d.screenshot('/tmp/w-detail.png')

await d.evaluate(`(() => {
  const b = document.querySelector('.tv-actions__primary')
  b?.click(); return !!b
})()`)
await sleep(9000)

const st = await d.evaluate(`(() => {
  const v = document.querySelector('video')
  return v ? { t: +v.currentTime.toFixed(1), dur: isFinite(v.duration) ? Math.round(v.duration) : null,
    paused: v.paused, w: v.videoWidth, h: v.videoHeight } : 'no-video'
})()`)
console.log('播放:', JSON.stringify(st))
await d.screenshot('/tmp/w-player.png')
d.close()
