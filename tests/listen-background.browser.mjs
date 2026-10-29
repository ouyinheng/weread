/**
 * 听书常驻：离开阅读页之后朗读不能停。
 *
 * 这条要求是结构性的，单元测试看不到——它依赖「播放器属于 App，不属于页面」
 * 这个归属关系，以及迷你控件活在 `App.vue` 里这件事。所以只能在真浏览器里
 * 断言整条链路：
 *
 *  1. 阅读页点「听」→ 收起全屏页 → 正文出现跟读高亮（新偏移映射）
 *  2. 返回书架 → 阅读页已卸载，但引擎**还在被调用**
 *  3. 书面没有阅读页 DOM 时也能自动接下一章（会话自己从库里取正文）
 *  4. 书架上常驻迷你控件；点它回到那本书的听书页
 *  5. 「更多 → 退出听书」后控件消失、引擎静音
 *
 * 浏览器没有语音引擎，所以这里换上一个 200ms 就 `onend` 的假 `speechSynthesis`：
 * 播放器循环照真跑，"还在念吗" 就变成一个可数的数字。200ms 是给
 * 「一段话一次合成」留的余量——一次念得越少，整本书越快念完，
 * 而这个测试要观察的是「离开阅读页之后还在念」，书不能提前念完。
 *
 * 需要静态服务（dist/）在 127.0.0.1:5173。
 */
import { launch, newPage } from './cdp.mjs'

const BASE = 'http://127.0.0.1:5173'
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const chrome = await launch()
const page = await newPage(`${BASE}/shelf`)

try {
  await page.goto(`${BASE}/shelf`, 1200)

  const seeded = await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const put = (store, value) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite')
      const r = t.objectStore(store).put(value)
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    const now = Date.now()
    await put('books', {
      id: 'listen1', title: '听书测试书', author: '作者', format: 'txt', cover: null,
      wordCount: 9000, fileSize: 1000, importedAt: now, lastReadAt: now,
      progress: 0, lastChapterIndex: 0, lastCharOffset: 0, finished: false,
    })
    for (let i = 0; i < 3; i++) {
      await put('chapters', {
        bookId: 'listen1', index: i, title: '第' + (i + 1) + '章 测试章节',
        html: '<p>' + '这一句话用来验证听书是否还在继续朗读，句号在这里。'.repeat(120) + '</p>',
        text: 'x', charOffset: 0, wordCount: 2400,
      })
    }
    return true
  })()`)
  check('种子数据写入', seeded)

  await page.goto(`${BASE}/shelf`, 1400)
  // 必须走 SPA 内部跳转：整页加载会在 history.back() 时重载文档，会话自然没了。
  const entered = await page.evaluate(`(async () => {
    const item = document.querySelector('.shelf__item')
    if (!item) return { error: 'no shelf item' }
    item.click()
    await new Promise(r => setTimeout(r, 1500))
    return { route: location.pathname, reader: !!document.querySelector('.reader') }
  })()`)
  check('从书架进入阅读页', entered.route === '/reader/listen1' && entered.reader, JSON.stringify(entered))

  await page.evaluate(`(() => {
    window.__spoken = 0
    const timers = new Set()
    const fake = {
      getVoices: () => [{ name: 'Fake', lang: 'zh-CN', localService: true }],
      speak: (u) => {
        window.__spoken++
        const t = setTimeout(() => { timers.delete(t); if (u.onend) u.onend() }, 200)
        timers.add(t)
      },
      cancel: () => { for (const t of timers) clearTimeout(t); timers.clear() },
      addEventListener() {}, removeEventListener() {},
      pause() {}, resume() {}, get speaking() { return true }, get pending() { return false },
    }
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true })
    return true
  })()`)

  const opened = await page.evaluate(`(async () => {
    const vp = document.querySelector('.reader__viewport')
    if (!vp) return { error: 'no viewport' }
    vp.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: innerWidth / 2, clientY: 300 }))
    await new Promise(r => setTimeout(r, 400))
    const fab = document.querySelector('.reader__listen-fab')
    if (!fab) return { error: 'no 听 button' }
    fab.click()
    await new Promise(r => setTimeout(r, 1200))
    return { listenView: !!document.querySelector('.lv'), spoken: window.__spoken }
  })()`)
  check('听书页打开', opened.listenView, JSON.stringify(opened))
  check('开始朗读', (opened.spoken || 0) > 0, JSON.stringify(opened))

  const collapsed = await page.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.lv__icon-btn')].find(b => b.getAttribute('aria-label') === '收起')
    if (!btn) return { error: 'no 收起' }
    btn.click()
    await new Promise(r => setTimeout(r, 700))
    return {
      listenView: !!document.querySelector('.lv'),
      rects: document.querySelectorAll('.reader__spoken').length,
      mini: !!document.querySelector('.mini'),
    }
  })()`)
  check('收起后回到正文', collapsed.listenView === false, JSON.stringify(collapsed))
  check('正文有跟读高亮', (collapsed.rects || 0) > 0, JSON.stringify(collapsed))
  check('阅读页内也显示迷你控件', collapsed.mini === true, JSON.stringify(collapsed))

  const before = await page.evaluate('window.__spoken')
  await page.evaluate('history.back()')
  await new Promise(r => setTimeout(r, 900))

  const shelf = await page.evaluate(`(async () => {
    const t0 = window.__spoken
    await new Promise(r => setTimeout(r, 700))
    return {
      route: location.pathname,
      readerMounted: !!document.querySelector('.reader'),
      mini: !!document.querySelector('.mini'),
      spokenBefore: t0,
      spokenAfter: window.__spoken,
    }
  })()`)
  check('回到书架', shelf.route === '/shelf', shelf.route)
  check('阅读页已卸载', !shelf.readerMounted, '')
  check('书架上仍有听书控件', shelf.mini, JSON.stringify(shelf))
  check('离开阅读页后仍在朗读',
    shelf.spokenAfter > before && shelf.spokenAfter > shelf.spokenBefore,
    JSON.stringify({ before, ...shelf }))

  // 没有阅读页 DOM 也要能接下一章：等 lastChapterIndex 被推到 1
  const advanced = await page.evaluate(`(async () => {
    const read = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => {
        const t = r.result.transaction('books', 'readonly')
        const q = t.objectStore('books').get('listen1')
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      }
      r.onerror = () => rej(r.error)
    })
    const t0 = Date.now()
    let b = await read()
    while (Date.now() - t0 < 22000) {
      b = await read()
      if (b && b.lastChapterIndex >= 1) break
      await new Promise(r => setTimeout(r, 500))
    }
    return { chapter: b && b.lastChapterIndex, progress: b && b.progress }
  })()`)
  check('后台自动接下一章', (advanced.chapter || 0) >= 1, JSON.stringify(advanced))
  check('听书进度写回书架', (advanced.progress || 0) > 0, JSON.stringify(advanced))

  const expanded = await page.evaluate(`(async () => {
    document.querySelector('.mini__body')?.click()
    await new Promise(r => setTimeout(r, 1000))
    return {
      route: location.pathname,
      search: location.search,
      listenView: !!document.querySelector('.lv'),
      mini: !!document.querySelector('.mini'),
    }
  })()`)
  check('控件可回到听书页',
    expanded.route === '/reader/listen1' && expanded.listenView, JSON.stringify(expanded))
  check('全屏听书页不叠迷你控件', expanded.mini === false, JSON.stringify(expanded))

  const closed = await page.evaluate(`(async () => {
    const more = [...document.querySelectorAll('.lv__icon-btn')].find(b => b.getAttribute('aria-label') === '更多')
    if (!more) return { error: 'no 更多' }
    more.click()
    await new Promise(r => setTimeout(r, 350))
    const exit = document.querySelector('.lv-sheet__danger')
    if (!exit) return { error: 'no 退出听书' }
    exit.click()
    await new Promise(r => setTimeout(r, 600))
    const t0 = window.__spoken
    await new Promise(r => setTimeout(r, 800))
    return {
      listenView: !!document.querySelector('.lv'),
      mini: !!document.querySelector('.mini'),
      t0,
      spokenAfter: window.__spoken,
    }
  })()`)
  check('退出听书后全屏页关闭', closed.listenView === false, JSON.stringify(closed))
  check('退出听书后控件消失', closed.mini === false, JSON.stringify(closed))
  check('退出听书后停止朗读', closed.spokenAfter === closed.t0, JSON.stringify(closed))
} finally {
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  page.close()
  chrome.kill('SIGKILL')
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
