/**
 * 播放页参考图对比截图（竖屏播放页 + 横屏全屏播放器）。
 *
 * 参考图在 docs/evidence/视频播放/，是 400dp 手机的 @3x 截图（1200×2670）。
 * 这里用同一组几何参数出图（Emulation.setDeviceMetricsOverride 400×890 @3x，
 * 横屏 890×400 @3x），两边可以直接叠着看。
 *
 * 跑法：node tests/tv-player-shots.mjs
 * 自带一个最小静态服务：dist/ + mock 苹果 CMS 接口 + 一段样例 mp4，
 * 不用真源、不碰外网。产物写到 assets/screenshots/tv-player-*.png。
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
  '.m3u8': 'application/vnd.apple.mpegurl',
}

/** 苹果 CMS V10 形状的假详情：一部 6 集的剧，正片地址指向本地样例 mp4。 */
function cmsPayload() {
  // 苹果 CMS 的 vod_play_url：`集名$地址` 用 `#` 分隔多集。
  const eps = [1, 2, 3, 4, 5, 6]
    .map((n) => `第${n}集$${API_BASE}/sample.mp4`)
    .join('#')
  return {
    code: 1,
    msg: '数据列表',
    list: [
      {
        vod_id: '1',
        vod_name: '虚颜',
        vod_pic: '',
        vod_year: '2022',
        vod_area: '内地',
        vod_remarks: '全6集',
        type_name: '微短剧',
        vod_content: '画师与心机千金交换容颜，一桩替嫁风波把两个女子的命运缠在一起。',
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
    // 静态资源；其余路径回落到 index.html（history 路由）。
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
const PORT = 8931
const BASE = `http://127.0.0.1:${PORT}`
/*
 * httpGet 会拒掉 127./10./192.168. 等内网主机名（书源 SSRF 防护）。localtest.me
 * 是公共 DNS 里指到 127.0.0.1 的测试域名，字符串过得了校验、连接还是打到本机
 * 这个 mock 服务上。页面本身照旧用 127.0.0.1 打开。
 */
const API_BASE = `http://localtest.me:${PORT}`

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，先跑一次 vite build')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const server = await startServer(PORT)
const chrome = await launch()
const page = await newPage('about:blank')

try {
  /* ---------- 竖屏：400×890 @3x ---------- */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 890,
    deviceScaleFactor: 3,
    mobile: true,
  })
  // 参考图是浅色主题；别让 headless Chrome 的系统偏好把页面带进深色。
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })

  // localStorage 是按源隔离的：先落到应用源上把源配置写好，再进播放页，
  // 这样 store.load() 一读就有（addScriptToEvaluateOnNewDocument 在 about:blank
  // 上注册不保证落到目标源，索性用「先到后写再导航」这条老实路）。
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
  await page.goto(`${BASE}/tv/play?source=mock&id=1&g=0&e=0`, 2500)

  // 等画面起播，再暂停 + 显一次控制层，截图里的控件才是「可见」状态。
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(`(() => {
      const v = document.querySelector('video')
      return !!v && v.readyState >= 2
    })()`)
    if (ready) break
    await sleep(250)
  }
  await page.evaluate(`(() => {
    const v = document.querySelector('video')
    if (v) { v.pause(); v.currentTime = 3 }
    return true
  })()`)
  // 点一下画面让控制层露出（artplayer 单击显隐）。
  const box = await page.evaluate(`(() => {
    const b = document.querySelector('.tv-play__screen').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(600)
  await page.screenshot(join(OUT, 'tv-player-portrait.png'))
  console.log('竖屏播放页 →', join(OUT, 'tv-player-portrait.png'))

  // 暂停态多截一张：核对 MorphIcon 在播放/暂停两种状态下的图标（桌面端单击
  // 会顺带切播放，上面这张是「播放中 = ‖」，这张是「已暂停 = ▶」）。
  await page.evaluate(`(() => { const v = document.querySelector('video'); if (v) v.pause(); return true })()`)
  await sleep(500)
  await page.screenshot(join(OUT, 'tv-player-portrait-paused.png'))
  console.log('竖屏暂停态 →', join(OUT, 'tv-player-portrait-paused.png'))

  // 顺便截一张「更多」菜单（倍速）展开的样子。
  await page.evaluate(`document.querySelector('.tv-play__top button[aria-label="更多"]')?.click(); true`)
  await sleep(400)
  await page.screenshot(join(OUT, 'tv-player-menu.png'))
  await page.evaluate(`document.querySelector('.tv-play__top button[aria-label="更多"]')?.click(); true`)
  await sleep(300)

  /* ---------- 横屏全屏：890×400 @3x ---------- */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 890,
    height: 400,
    deviceScaleFactor: 3,
    mobile: true,
  })
  // 全屏入口在竖屏控制条上；布局已经切到横屏几何，直接点按钮走真实全屏流程。
  await sleep(400)
  await page.evaluate(`(() => {
    const btn = document.querySelector('.tv-play__bar--mini button[aria-label="全屏"]')
    if (btn) btn.click()
    return !!btn
  })()`)
  await sleep(800)
  // 再显一次控制层（全屏重建后可能已自动隐藏）。
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 445, y: 200, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 445, y: 200, button: 'left', clickCount: 1 })
  await sleep(600)
  await page.screenshot(join(OUT, 'tv-player-landscape.png'))
  console.log('横屏全屏 →', join(OUT, 'tv-player-landscape.png'))

  // 倍速浮层：验它在画面之上、点得到（曾经被 .art-video 的 z-index:10 压住）
  await page.evaluate(`[...document.querySelectorAll('.tv-play__txt')].find(b => b.textContent.includes('倍速'))?.click(); true`)
  await sleep(400)
  await page.screenshot(join(OUT, 'tv-player-landscape-rate.png'))
  const rateVisible = await page.evaluate(`(() => {
    const el = document.querySelector('.tv-play__rates')
    if (!el) return 'absent'
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { inViewport: r.width > 0, hitIsRates: hit === el || el.contains(hit) }
  })()`)
  console.log('倍速浮层命中测试:', JSON.stringify(rateVisible))
  await page.evaluate(`document.querySelector('.tv-play__rate--on')?.click(); true`)
  await sleep(300)

  // 全屏下打开选集抽屉：验它没被 :fullscreen 层盖住
  await page.evaluate(`document.querySelector('.tv-play__bar--full button[aria-label="选集"]')?.click
    ? document.querySelector('.tv-play__bar--full button[aria-label="选集"]').click()
    : [...document.querySelectorAll('.tv-play__txt')].find(b => b.textContent.includes('选集'))?.click(); true`)
  await sleep(500)
  await page.screenshot(join(OUT, 'tv-player-landscape-drawer.png'))
  console.log('全屏选集抽屉 →', join(OUT, 'tv-player-landscape-drawer.png'))
  await page.evaluate(`document.querySelector('.tv-play__drawer-close')?.click(); true`)
  await sleep(400)

  // 锁屏态：控制层应收起，只剩左侧开锁按钮。
  // 控制层 3 秒不动会自动隐藏，先晃一下鼠标把它们叫出来（桌面端 hover 即显）。
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 445, y: 200 })
  await sleep(300)
  await page.evaluate(`document.querySelector('.tv-play__lock')?.click(); true`)
  await sleep(500)
  await page.screenshot(join(OUT, 'tv-player-landscape-locked.png'))
  console.log('全屏锁屏态 →', join(OUT, 'tv-player-landscape-locked.png'))
  await page.evaluate(`document.querySelector('.tv-play__lock')?.click(); true`)
  await sleep(300)

  const state = await page.evaluate(`(() => ({
    isFull: !!document.fullscreenElement,
    hasFullBar: !!document.querySelector('.tv-play__bar--full'),
    fatal: document.querySelector('.tv-play__fatal-text')?.textContent || '',
  }))()`)
  console.log('状态:', JSON.stringify(state))
} finally {
  page.close()
  server.close()
  await sleep(200)
  process.exit(0)
}
