/**
 * README 预览图生成：书架 / 阅读 / 影视详情 / 播放，四张拼成一张 overview.png。
 *
 * 为什么不是手工截：README 上那张要长期保持「和当前版本一致」，手工截一次就过时。
 * 这里用和 `tv-player-shots.mjs` 同一套办法（静态 dist + mock 影视接口 + 样例 mp4），
 * 再用 CDP 的 `DOM.setFileInputFiles` 把几本样例书塞进真实的导入链路，
 * 最后在页面里用 flex 把四张拼起来截一张 —— 不依赖 ImageMagick。
 *
 * 跑法：node tests/readme-shots.mjs
 * 产物：assets/screenshots/overview.png（单张 4 合一）
 * 中间件：/tmp/readme-shots/*.png（不留在仓库里）
 */
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { extname, join } from 'path'
import { deflateSync } from 'zlib'
import { execFileSync } from 'child_process'
import { launch, newPage } from './cdp.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'assets/screenshots')
const TMP = '/tmp/readme-shots'
const BOOKS = '/tmp/readme-books'
const FIXTURE = '/tmp/tvfix/sample.mp4'
const PORT = 8933
const BASE = `http://127.0.0.1:${PORT}`
/* httpGet 会拒内网主机名（书源/视频源的 SSRF 防护），localtest.me 解析到 127.0.0.1。 */
const API_BASE = `http://localtest.me:${PORT}`

/* ---------------- 样例书 ---------------- */

const PROSE = {
  intro: [
    '雨落在瓦上，声音细密得像有人在远处翻书。',
    '他坐在窗边的旧藤椅里，膝盖上摊着一本没有封皮的册子。纸页被翻得发了毛，边角卷起来，像被反复折叠过的地图。',
    '院子里的石榴树今年结得晚。果子还青着，压弯了枝条，风一过就轻轻磕在墙上，笃、笃，像有人在敲门，又像没有人。',
    '他抬起头，看见天光从屋檐下面漏进来，落在册子的中缝上。那道光很薄，薄到几乎看不出颜色，却把纸上的字照得格外清楚。',
    '翻过去的一页写着一句没头没尾的话：所有远行都从门口开始。他看了很久，忽然记不起这句话是自己划的，还是原来就印在那里。',
    '檐上的水开始往下滴。一滴，又一滴，落在台阶的石窝里，声音慢慢地连成了一条线。',
  ],
  middle: [
    '天快亮的时候，巷口的豆浆摊支起了棚子。白汽从锅里升上来，在路灯下面散成一团软光。',
    '他记得小时候也这样等过天亮。那时候等的是过年，是鞭炮，是父亲从外地带回来的一包糖；现在等的东西说不清了，只知道天亮之后要往前走一段路。',
    '摊主把碗推过来，问他要不要加糖。他想了一会儿，说不用了。',
    '巷子很窄，两边的墙皮剥落了一半，露出里面深灰色的砖。有人推开一扇门，端着盆出来倒水，水在地上摊开，很快就被清晨的风吹干了。',
    '他沿着巷子往外走。路过邮局的时候，卷帘门只拉起来一半，里面有人在分拣信件，纸页翻动的声音从门缝里传出来，和昨夜雨打瓦片的声音有点像。',
    '他在门口站了一会儿，把册子换到另一只手上，然后继续往前走。',
  ],
  end: [
    '回到屋里，他把册子合上，压在镇纸下面。',
    '书里写的是一座他从未去过的城：城门朝南，河上有三座桥，桥边的柳树在春天被人折得只剩枝条。写书的人后来去了哪里，没有人知道。',
    '他忽然想，读一本书大概就是这样——你借别人的眼睛看了一段路，然后把眼睛还回去，自己接着走。',
    '窗台上的水痕已经干了，只留下一点浅浅的白。他把窗户推开一条缝，风进来，把桌上的纸吹起一个角，又落回去。',
    '院子里的石榴终于有一个熟了，红得很慢，像是不想让人看出来。他伸手够了一下，没够着，就由它挂在枝上。',
    '天色沉下来。他没有起身去开灯，只是坐着，听屋檐上的水一滴一滴落进夜里。',
  ],
}

function bookText(title, author, chapterTitles) {
  const lines = [title, author, '']
  chapterTitles.forEach((name, i) => {
    lines.push(name, '')
    const pool = [PROSE.intro, PROSE.middle, PROSE.end]
    const body = pool[i % pool.length]
    for (const p of body) lines.push('　　' + p, '')
  })
  return lines.join('\n')
}

const BOOK_FILES = [
  ['山海旧闻 - 沈砚.txt', ['第一章 雨落在瓦上', '第二章 天亮以前', '第三章 还书的人']],
  ['长夜灯 - 周迟.txt', ['第一章 灯下', '第二章 巷口', '第三章 归途']],
  ['北窗随笔 - 陆知行.txt', ['第一章 北窗', '第二章 旧册子']],
  ['霜降之后 - 林未.txt', ['第一章 霜降', '第二章 石榴']],
  ['云上邮局 - 顾南.txt', ['第一章 一封没寄出的信', '第二章 邮差']],
]

function writeBooks() {
  mkdirSync(BOOKS, { recursive: true })
  return BOOK_FILES.map(([name, chapters]) => {
    const path = join(BOOKS, name)
    const title = name.replace(/\.txt$/, '').split(' - ')[0]
    const author = name.replace(/\.txt$/, '').split(' - ')[1]
    const chapterTitles = chapters.map((c, i) => (i === 0 ? c : c))
    writeFileSync(path, bookText(title, author, chapterTitles), 'utf8')
    return path
  })
}

/* ---------------- 海报（程序生成一张渐变 PNG，避免引入外部图片） ---------------- */

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 深蓝 → 紫的斜向渐变，右下角压一层暗角，当作竖版海报。 */
function posterPng(w = 360, h = 540) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.45 + (y / h) * 0.55
      const vignette = 1 - 0.35 * Math.hypot(x / w - 0.5, y / h - 0.45)
      const r = Math.round((26 + 120 * t) * vignette)
      const g = Math.round((38 + 58 * t) * vignette)
      const b = Math.round((78 + 128 * t) * vignette)
      const i = row + 1 + x * 3
      raw[i] = Math.min(255, r)
      raw[i + 1] = Math.min(255, g)
      raw[i + 2] = Math.min(255, b)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- mock 影视接口 ---------------- */

function cmsPayload() {
  const eps = [1, 2, 3, 4, 5, 6].map(n => `第${n}集$${API_BASE}/sample.mp4`).join('#')
  return {
    code: 1,
    msg: '数据列表',
    list: [
      {
        vod_id: '1',
        vod_name: '雾港',
        vod_pic: `${API_BASE}/poster.png`,
        vod_year: '2024',
        vod_area: '内地',
        vod_remarks: '全6集',
        type_name: '悬疑 / 短剧',
        vod_content:
          '一座常年有雾的港口，一艘十五年没有靠岸的船。船员名单上多出一个谁也没见过的名字，而港口的灯，每晚都准点亮起。',
        vod_play_url: eps,
        vod_play_from: '高清线路',
      },
    ],
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
}

function startServer() {
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
    const url = new URL(req.url || '/', BASE)
    if (url.pathname.startsWith('/api.php/provide/vod')) {
      res.writeHead(200, { ...cors, 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify(cmsPayload()))
      return
    }
    if (url.pathname === '/poster.png') {
      res.writeHead(200, { ...cors, 'Content-Type': MIME['.png'] })
      res.end(posterPng())
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
    // 中间产物（四张分图 + 拼图页），只给本地截图用
    if (url.pathname.startsWith('/shots/')) {
      const f = join(TMP, url.pathname.slice('/shots/'.length))
      if (existsSync(f)) {
        res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' })
        res.end(readFileSync(f))
        return
      }
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
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* 拼图卡片宽度：四张 400×890 的 @3x 截图并排，总宽压在 1800 左右。 */
const CARD = 420
const GAP = 10
const FRAME_PAD = 10

function frameHtml() {
  const names = ['shelf.png', 'reader.png', 'tv-detail.png', 'tv-player.png']
  const cards = names.map(n => `<img src="${n}" alt="">`).join('\n    ')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #ffffff; }
  .row { display: flex; gap: ${GAP}px; padding: ${FRAME_PAD}px; width: max-content; }
  .row img {
    width: ${CARD}px; height: auto; display: block;
    border-radius: 14px; border: 1px solid rgba(0, 0, 0, 0.07);
  }
</style></head>
<body><div class="row">
    ${cards}
</div></body></html>`
}

/* ---------------- 主流程 ---------------- */

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，先跑一次 vite build')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })
mkdirSync(TMP, { recursive: true })
const bookPaths = writeBooks()
writeFileSync(join(TMP, 'frame.html'), frameHtml(), 'utf8')

const server = await startServer()
await launch()
const page = await newPage('about:blank')

async function shot(name) {
  const path = join(TMP, name)
  await page.screenshot(path)
  console.log('  →', name)
  return path
}

/** 点一个选择器（走组件自己的 click 处理），返回是否点到了。 */
async function click(selector) {
  return page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
  )
}

/** 在页面坐标上真点一下（阅读页靠指针手势翻页，el.click() 不走这条路）。 */
async function tap(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function waitFor(expression, timeoutMs = 20000, label = expression) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true
    } catch {
      /* 导航中执行上下文会换掉 */
    }
    await sleep(200)
  }
  throw new Error('等待超时: ' + label)
}

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

  /* ---------- 1. 灌数据：影视源 + 五本书 ---------- */
  await page.goto(`${BASE}/shelf`, 1200)
  await page.evaluate(`(() => {
    localStorage.setItem('weread.tv.v1', JSON.stringify({
      sources: [{ id: 'mock', name: '示例源', api: '${API_BASE}/api.php/provide/vod/', enabled: true, addedAt: Date.now() }],
      history: [],
    }));
    return true
  })()`)

  // 走真实导入链路：点「导入」→ 隐藏 file input 出现 → CDP 塞文件。
  const opened = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.shelf__bar-btn')].find(b => b.textContent.includes('导入'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!opened) throw new Error('没找到书架上的「导入」按钮')
  await sleep(300)
  const handle = await page.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=file]')`,
  })
  if (!handle.result.objectId) throw new Error('导入没有创建 file input')
  await page.send('DOM.setFileInputFiles', { files: bookPaths, objectId: handle.result.objectId })
  await waitFor(`document.querySelectorAll('.shelf__item').length >= ${bookPaths.length}`, 60000, '导入完成')
  // 导入浮层收起 + 封面绘制 + 「已导入 N 本」提示自动消失（2.6s）
  await waitFor(`!document.querySelector('.import-overlay, .import')`, 15000, '浮层收起')
  await sleep(3200)

  /* ---------- 2. 书架 ---------- */
  await shot('shelf.png')

  /* ---------- 3. 阅读页（进入后默认收起菜单，正文满屏） ---------- */
  await click('.shelf__item')
  await waitFor(`!!document.querySelector('.reader__pages')`, 15000, '阅读页渲染')
  await sleep(1400)
  const menuOpen = await page.evaluate(`!!document.querySelector('.topbar, .reader__top')`)
  if (menuOpen) {
    await page.evaluate(`document.querySelector('.reader__pages')?.click(); true`)
    await sleep(400)
  }
  // 章节第一页是「书名 + 章节名」的扉页，翻一页才是正文。
  const pageText = () =>
    page.evaluate(`document.querySelector('.reader__pages')?.innerText.replace(/\\s/g, '').length || 0`)
  if ((await pageText()) < 120) {
    await tap(342, 445)
    await sleep(700)
  }
  if ((await pageText()) < 120) {
    await tap(342, 445)
    await sleep(700)
  }
  await shot('reader.png')

  /* ---------- 4. 影视详情 ---------- */
  await page.goto(`${BASE}/tv/detail?source=mock&id=1`, 2200)
  await waitFor(`!!document.querySelector('.tv-hero')`, 15000, '详情页渲染')
  await sleep(600)
  await shot('tv-detail.png')

  /* ---------- 5. 播放页（暂停在第 3 秒，控制层露出） ---------- */
  await page.goto(`${BASE}/tv/play?source=mock&id=1&g=0&e=0`, 2500)
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(
      `(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 2 })()`,
    )
    if (ready) break
    await sleep(250)
  }
  await page.evaluate(
    `(() => { const v = document.querySelector('video'); if (v) { v.pause(); v.currentTime = 3 } return true })()`,
  )
  const box = await page.evaluate(`(() => {
    const b = document.querySelector('.tv-play__screen').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })()`)
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await sleep(700)
  await shot('tv-player.png')

  /* ---------- 6. 拼成一张 4 合一 ---------- */
  const cardH = Math.round((CARD * 2670) / 1200)
  const width = CARD * 4 + GAP * 3 + FRAME_PAD * 2
  const height = cardH + FRAME_PAD * 2
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await page.goto(`${BASE}/shots/frame.html`, 1200)
  await sleep(600)
  const raw = join(TMP, 'overview@2x.png')
  await page.screenshot(raw)
  // 2x 出图再缩到 1x：文字边缘比浏览器直接 @1x 排要好
  const target = join(OUT, 'overview.png')
  execFileSync('sips', ['--resampleWidth', String(width), raw, '--out', target], { stdio: 'ignore' })
  console.log('4 合一 →', target)
  console.log(`尺寸 ${width}×${height}，文件 ${(readFileSync(target).length / 1024).toFixed(0)}KB`)
} finally {
  page.close()
  server.close()
}
