/**
 * 阅读页几何体检：一页到底用了多少高度、底部剩下多少。
 *
 * 400×890@3x 渲染（和真机同像素 1200×2670），量：
 *  1. `.reader__viewport` / `.reader__pages` / `.reader__status` 的实际矩形
 *  2. viewport 上下 padding、页面盒高度、行高
 *  3. 正文最后一行文字的真实底边
 *
 * 跑法：node tests/reader-geometry.mjs
 *   GF_FONT=26 GF_LH=2.4 node tests/reader-geometry.mjs   # 换字号/行距复现
 */
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { extname, join } from 'path'
import { launch, newPage } from './cdp.mjs'

const PORT = 5199
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = new URL('../dist/', import.meta.url).pathname
const FONT = Number(process.env.GF_FONT || 26)
const LH = Number(process.env.GF_LH || 2.4)

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  let file = join(ROOT, path)
  if (path === '/' || !existsSync(file) || !extname(file)) file = join(ROOT, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

// 和截图里长度相仿的正文：短段落 + 一句对白 + 一条分隔线 + 长段落
const PARA = [
  '他攥紧拳头，将眼前这一幕牢牢记在心底，随后深吸一口气，站起身来，脸色木然。',
  '陈海立刻转身吩咐起来。',
  '“备车！”',
  '＿＿＿＿＿＿',
  '南朝的都城建康，在建设的时候，没有按着南北中轴布局，而是依山傍水，顺势而为，取一个天道自然之意，但皇宫依旧是这座城池的核心。',
  '南陈的皇城位于建康城北，四周有城墙环绕，宫门朝南而开，正对御道。',
].map(t => `<p>${t}</p>`).join('')

const chrome = await launch()
const page = await newPage(`${BASE}/shelf`)

try {
  await page.goto(`${BASE}/shelf`, 1200)
  await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const put = (store, value) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite')
      const r = t.objectStore(store).put(value)
      r.onsuccess = () => res(); r.onerror = () => rej(r.error)
    })
    const now = Date.now()
    await put('books', { id: 'g1', title: '几何体检', author: 'x', format: 'txt', cover: null,
      wordCount: 9000, fileSize: 1000, importedAt: now, lastReadAt: now, progress: 0,
      lastChapterIndex: 0, lastCharOffset: 0, finished: false })
    await put('chapters', { bookId: 'g1', index: 0, title: '第一章 测试',
      html: ${JSON.stringify(PARA.repeat(6))}, text: 'x', charOffset: 0, wordCount: 3000 })
    // 复现真机的阅读设置：大字号 + 大行距
    await put('settings', { key: 'reader', fontSize: ${FONT}, lineHeight: ${LH},
      pageMargin: 22, theme: 'white', background: 'plain', fontFamily: 'system',
      turnPageType: 'horizontal', firstLineIndent: true, brightness: -1, showStatusBar: false,
      volumeKeyTurn: false, landscape: false, noAutoLock: false })
    return true
  })()`)

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 890, deviceScaleFactor: 3, mobile: true,
  })
  await page.goto(`${BASE}/reader/g1`, 2200)

  const geo = await page.evaluate(`(() => {
    const q = s => document.querySelector(s)
    const rect = el => { const r = el.getBoundingClientRect()
      return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) } }
    const vp = q('.reader__viewport')
    const pages = q('.reader__pages')
    const status = q('.reader__status')
    const cs = getComputedStyle(vp)
    const ps = getComputedStyle(pages)
    return {
      innerH: window.innerHeight,
      viewport: rect(vp),
      pages: rect(pages),
      status: status ? rect(status) : null,
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
      fontSize: ps.fontSize,
      lineHeight: ps.lineHeight,
      pagesHeight: ps.height,
      columns: (pages.scrollWidth / pages.clientWidth).toFixed(2),
    }
  })()`)
  console.log(JSON.stringify(geo, null, 2))

  await page.screenshot('/tmp/reader-geometry.png')
} finally {
  page.close()
  chrome.kill('SIGKILL')
  server.close()
  setTimeout(() => process.exit(0), 300)
}
