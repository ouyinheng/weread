/**
 * 真机：播放器交互探针。
 * 进入播放页后依次测试：单击、双击、横向拖动、纵向拖动，记录状态变化。
 */
import { connect } from './device.mjs'

const d = await connect(9333)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const state = () => d.evaluate(`(() => {
  const v = document.querySelector('video')
  const p = document.querySelector('.art-video-player')
  return v ? {
    path: location.pathname,
    t: +v.currentTime.toFixed(1),
    paused: v.paused,
    ctl: p.className.includes('art-control-show'),
    volume: +(v.volume).toFixed(2),
  } : { path: location.pathname, video: null }
})()`)

const rect = () => d.evaluate(`(() => {
  const b = document.querySelector('.tv-play__screen').getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
})()`)

// 详情页 → 播放
await d.evaluate(`document.querySelector('.tv-actions__primary')?.click(); true`)
await sleep(5000)
let r = await rect()
console.log('进入播放页:', JSON.stringify(await state()), 'stage', Math.round(r.w) + 'x' + Math.round(r.h))

// 1. 单击画面（四分之一处，避开中央大按钮）
let before = await state()
d.tap(r.x + r.w * 0.22, r.y + r.h * 0.5)
await sleep(700)
let after = await state()
console.log('单击后:', JSON.stringify(after), '| 变化:', after.paused === before.paused ? '未播放/暂停切换' : '切换了播放状态',
  '| 控制栏:', before.ctl, '->', after.ctl)

// 2. 横向拖动（右滑 → 快进）
before = await state()
d.swipe(r.x + r.w * 0.3, r.y + r.h * 0.5, r.x + r.w * 0.75, r.y + r.h * 0.5, 400)
await sleep(1200)
after = await state()
console.log('横滑后:', JSON.stringify(after), '| 位移:', (after.t - before.t).toFixed(1), 's')

// 3. 纵向拖动（左侧下滑 → 亮度）
before = await state()
d.swipe(r.x + r.w * 0.2, r.y + r.h * 0.3, r.x + r.w * 0.2, r.y + r.h * 0.75, 400)
await sleep(800)
after = await state()
console.log('竖滑后:', JSON.stringify(after))

await d.screenshot('/tmp/probe-player.png')
d.close()
