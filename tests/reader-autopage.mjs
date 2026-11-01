/**
 * 自动翻页探针：走真实点击路径打开「自动翻页」，然后看页面到底有没有动。
 *
 * 跑法：node tests/reader-autopage.mjs（需要 dist/ 已构建）
 */
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { extname, join } from 'path'
import { launch, newPage } from './cdp.mjs'

const PORT = 5198
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = new URL('../dist/', import.meta.url).pathname
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  let file = join(ROOT, path)
  if (path === '/' || !existsSync(file) || !extname(file)) file = join(ROOT, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const PARA = Array.from({ length: 40 }, (_, i) =>
  `<p>第${i}段，这一句用来把正文撑够几页，方便观察自动翻页有没有动起来。</p>`).join('')

const chrome = await launch()
const page = await newPage(`${BASE}/shelf`)
const say = (label, v) => console.log(label, JSON.stringify(v))

try {
  await page.goto(`${BASE}/shelf`, 1200)
  await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('weread'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const put = (store, value) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite'); const r = t.objectStore(store).put(value)
      r.onsuccess = () => res(); r.onerror = () => rej(r.error)
    })
    const now = Date.now()
    await put('books', { id: 'ap1', title: '自动翻页', author: 'x', format: 'txt', cover: null,
      wordCount: 9000, fileSize: 1000, importedAt: now, lastReadAt: now, progress: 0,
      lastChapterIndex: 0, lastCharOffset: 0, finished: false })
    await put('chapters', { bookId: 'ap1', index: 0, title: '第一章', html: ${JSON.stringify(PARA)},
      text: 'x', charOffset: 0, wordCount: 3000 })
    await put('settings', { key: 'reader', fontSize: 19, lineHeight: 1.8, pageMargin: 22,
      theme: 'white', background: 'plain', fontFamily: 'system', turnPageType: 'horizontal',
      firstLineIndent: true, brightness: -1, showStatusBar: false, volumeKeyTurn: false,
      landscape: false, noAutoLock: false, autoPageSeconds: 3 })
    return true
  })()`)

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 890, deviceScaleFactor: 3, mobile: true,
  })
  await page.goto(`${BASE}/reader/ap1`, 2200)

  const before = await page.evaluate(`(() => {
    const el = document.querySelector('.reader__pages')
    return { transform: getComputedStyle(el).transform,
             pct: document.querySelector('.reader__status-right')?.textContent }
  })()`)
  say('before', before)

  // 真实路径：点中间出菜单 → 底栏「字体」→ 翻页方式 → 开启自动翻页
  const clicked = await page.evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vp = document.querySelector('.reader__viewport')
    const r = vp.getBoundingClientRect()
    vp.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
    await sleep(400)
    const fontBtn = [...document.querySelectorAll('.bottombar__item')]
      .find(b => b.getAttribute('aria-label') === '字体')
    if (!fontBtn) return { error: 'no 字体',
      labels: [...document.querySelectorAll('.bottombar__item')].map(b => b.getAttribute('aria-label')) }
    fontBtn.click()
    await sleep(400)
    const chip = [...document.querySelectorAll('.fp-chip')].find(b => (b.textContent || '').includes('翻页方式'))
    if (!chip) return { error: 'no 翻页方式' }
    chip.click()
    await sleep(400)
    const autoBtn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('自动翻页'))
    if (!autoBtn) return { error: 'no 自动翻页按钮' }
    const label = autoBtn.textContent.trim()
    autoBtn.click()
    await sleep(300)
    return { label, still: !!(document.querySelector('.fp-pill--on')) }
  })()`)
  say('clicked', clicked)

  await new Promise(r => setTimeout(r, 9000))
  const after = await page.evaluate(`(() => {
    const el = document.querySelector('.reader__pages')
    return { transform: getComputedStyle(el).transform,
             pct: document.querySelector('.reader__status-right')?.textContent,
             menu: !!document.querySelector('.font-panel') }
  })()`)
  say('after 9s', after)
  console.log(after.transform !== before.transform ? 'AUTO-PAGE OK' : 'AUTO-PAGE DID NOT MOVE')
} finally {
  page.close()
  chrome.kill('SIGKILL')
  server.close()
  setTimeout(() => process.exit(0), 300)
}
