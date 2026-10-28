/**
 * 本地视频入口（影视首页 → 播放页）的回归截图。
 *
 * 路由链路跟 `tv-player-shots.mjs` 一样：静态 dist + mock 苹果 CMS，
 * 区别是这里不点海报，而是点顶栏的「本地视频」，用 CDP 的
 * `DOM.setFileInputFiles` 把样例 mp4 塞进那个隐藏的 file input —— 走的
 * 就是真机上的同一条路径（点击 → 系统选择器 → change → 跳播放页）。
 *
 * 跑法：node tests/tv-local-shots.mjs
 * 产物：assets/screenshots/tv-local-{home,player,empty}.png
 */
import { createServer } from 'http'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { extname, join } from 'path'
import { launch, newPage } from './cdp.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const FIXTURE = '/tmp/tvfix/sample.mp4'
const OUT = join(ROOT, 'assets/screenshots')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
}

/** 跟 tv-player-shots 同形状的假详情，让首页有海报墙可画。 */
function cmsPayload() {
  const eps = [1, 2, 3]
    .map((n) => `第${n}集$${API_BASE}/sample.mp4`)
    .join('#')
  return {
    code: 1,
    msg: '数据列表',
    list: [
      {
        vod_id: '1',
        vod_name: '虚颜',
        vod_year: '2022',
        vod_area: '内地',
        vod_remarks: '全3集',
        type_name: '微短剧',
        vod_content: '画师与心机千金交换容颜。',
        vod_play_url: eps,
        vod_play_from: '高清线路',
      },
      {
        vod_id: '2',
        vod_name: '漫长的季节',
        vod_year: '2023',
        vod_area: '内地',
        vod_remarks: '全12集',
        type_name: '电视剧',
        vod_content: '桦林的一场旧案。',
        vod_play_url: eps,
        vod_play_from: '高清线路',
      },
    ],
  }
}

function startServer(port) {
  const server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname.startsWith('/api.php/provide/vod')) {
      res.writeHead(200, { ...cors, 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify(cmsPayload()))
      return
    }
    if (url.pathname === '/sample.mp4' && existsSync(FIXTURE)) {
      const bytes = readFileSync(FIXTURE)
      res.writeHead(200, {
        'Content-Type': MIME['.mp4'],
        'Content-Length': bytes.length,
        'Accept-Ranges': 'bytes',
      })
      res.end(bytes)
      return
    }
    const file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (existsSync(file) && extname(file)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(readFileSync(file))
      return
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    res.end(readFileSync(join(DIST, 'index.html')))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 8943
const BASE = `http://127.0.0.1:${PORT}`
const API_BASE = `http://localtest.me:${PORT}`

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，先跑一次 vite build')
  process.exit(1)
}
if (!existsSync(FIXTURE)) {
  console.error(`缺样例视频 ${FIXTURE}`)
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const server = await startServer(PORT)
const chrome = await launch()
const page = await newPage('about:blank')

try {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 890,
    deviceScaleFactor: 3,
    mobile: true,
  })
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })

  await page.goto(`${BASE}/`, 800)
  await page.evaluate(`localStorage.setItem('weread.tv.v1', JSON.stringify({
    sources: [{
      id: 'mock',
      name: '测试源',
      api: '${API_BASE}/api.php/provide/vod/',
      enabled: true,
      addedAt: Date.now(),
    }],
    history: [],
  })); true`)
  /*
   * 影视 tab 默认不占底栏（功能入口是 opt-in），所以直接把设置写进 IndexedDB：
   * App.vue 的守卫会把「当前 tab 被隐藏」的访问重定向回书架，不打开这个开关
   * 连 /tv 都进不去。
   */
  await sleep(500)
  await page.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('weread', 6)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('settings', 'readwrite')
      tx.objectStore('settings').put({
        key: 'app',
        fontScale: 1,
        fontFamily: 'system',
        theme: 'light',
        showShelfTab: true,
        showTvTab: true,
      })
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => reject(tx.error)
    }
  })`)
  await page.goto(`${BASE}/tv`, 2000)

  /* ---------- 1. 首页：入口不该动现有布局 ---------- */
  const home = await page.evaluate(`(() => {
    const search = document.querySelector('.tv__search')
    const local = document.querySelector('.tv__local')
    const top = document.querySelector('.tv__top')
    const grid = document.querySelector('.tv__grid')
    const r = (el) => el ? el.getBoundingClientRect() : null
    return {
      hasLocal: !!local,
      search: r(search),
      local: r(local),
      topH: r(top)?.height || 0,
      posters: document.querySelectorAll('.tv-poster').length,
      gridTop: r(grid)?.top || 0,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }
  })()`)
  console.log('首页:', JSON.stringify(home))
  await page.screenshot(join(OUT, 'tv-local-home.png'))
  console.log('影视首页 →', join(OUT, 'tv-local-home.png'))

  /* ---------- 2. 点入口 → 选文件 → 播放页 ---------- */
  await page.evaluate(`document.querySelector('.tv__local').click(); true`)
  await sleep(400)
  // 点击后 pickLocalVideos 在 DOM 里留了一个隐藏 input（change 时才移除）。
  const hasInput = await page.evaluate(`!!document.querySelector('input[type=file][accept="video/*"]')`)
  console.log('隐藏 file input 已创建:', hasInput)

  const obj = await page.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=file][accept="video/*"]')`,
  })
  await page.send('DOM.setFileInputFiles', {
    files: [FIXTURE],
    objectId: obj.result.objectId,
  })

  // 等路由跳转 + 画面起播
  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(`(() => {
      const v = document.querySelector('video')
      return {
        href: location.pathname + location.search,
        ready: !!v && v.readyState >= 2,
        src: v ? String(v.currentSrc || v.src).slice(0, 5) : '',
      }
    })()`)
    if (ready.ready) {
      console.log('起播:', JSON.stringify(ready))
      break
    }
    await sleep(250)
  }

  const play = await page.evaluate(`(() => {
    const v = document.querySelector('video')
    if (v) { v.pause(); v.currentTime = 2 }
    return {
      url: location.pathname + location.search,
      blobSrc: v ? String(v.currentSrc || v.src).startsWith('blob:') : false,
      title: document.querySelector('.tv-play__name')?.textContent || '',
      hasCast: !!document.querySelector('.tv-play__top button[aria-label="投屏"]'),
      hasShare: [...document.querySelectorAll('.tv-play__action-label')].some(e => e.textContent === '分享'),
      epCount: document.querySelectorAll('.tv-play__ep-btn').length,
      fatal: document.querySelector('.tv-play__fatal-text')?.textContent || '',
    }
  })()`)
  console.log('播放页:', JSON.stringify(play))

  const box = await page.evaluate(`(() => {
    const b = document.querySelector('.tv-play__screen').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(600)
  await page.screenshot(join(OUT, 'tv-local-player.png'))
  console.log('本地播放页 →', join(OUT, 'tv-local-player.png'))

  /* ---------- 3. 返回：应该回到影视首页 ---------- */
  await page.evaluate(`document.querySelector('.tv-play__top button[aria-label="返回"]').click(); true`)
  await sleep(700)
  const back = await page.evaluate(`location.pathname`)
  console.log('返回后路由:', back)

  /* ---------- 4. 没有视频源时的空态：本地入口也在 ---------- */
  await page.evaluate(`localStorage.setItem('weread.tv.v1', JSON.stringify({ sources: [], history: [] })); true`)
  await page.goto(`${BASE}/tv`, 1200)
  const empty = await page.evaluate(`(() => ({
    emptyShown: !!document.querySelector('.tv__empty'),
    hasLocal: !!document.querySelector('.tv__local'),
    hasEmptyLink: !!document.querySelector('.tv__empty-link'),
  }))()`)
  console.log('空态:', JSON.stringify(empty))
  await page.screenshot(join(OUT, 'tv-local-empty.png'))
  console.log('无源空态 →', join(OUT, 'tv-local-empty.png'))
} catch (e) {
  console.error('FAILED:', e?.message || e)
  process.exitCode = 1
} finally {
  page.close()
  server.close()
  await sleep(200)
  process.exit(process.exitCode || 0)
}
