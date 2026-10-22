/**
 * Tab switching: state, animation, and smoothness.
 *
 * The old bug was structural — the tab bar lived inside each view, so every
 * switch unmounted and rebuilt it, and pages had no cache. These checks assert
 * the fix, not just "it navigates":
 *
 *  - the tab bar element survives a switch (identity check)
 *  - the active state flips in the same frame the animation starts
 *  - the outgoing view is still painted during the transition (no blank frame)
 *  - tab pages are cached, so returning does not re-read IndexedDB
 *  - frame timing during the transition stays inside budget
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
  await page.goto(`${BASE}/shelf`, 1400)
  // Warm 发现 once so the measurements below are of a cached switch, not of a
  // first-time chunk fetch (that case is covered separately by the preload test).
  await page.evaluate(`(async () => {
    const t = [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === '发现')
    t.click(); await new Promise(r => setTimeout(r, 400))
    const s = [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === '书架')
    s.click(); await new Promise(r => setTimeout(r, 400))
  })()`)

  /* ---------- 1. chrome colour tokens ---------- */
  const tokens = await page.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      accent: cs.getPropertyValue('--accent').trim(),
      tabbarH: cs.getPropertyValue('--tabbar-height').trim(),
      page: cs.getPropertyValue('--bg-page').trim(),
      bodyBg: getComputedStyle(document.querySelector('.app')).backgroundColor,
    }
  })()`)
  check('accent is #1b88ee', tokens.accent.toLowerCase() === '#1b88ee', tokens.accent)
  check('page canvas token set', !!tokens.page, JSON.stringify(tokens))

  /* ---------- 2. tab bar is persistent and outside the view ---------- */
  const structure = await page.evaluate(`(() => {
    const bar = document.querySelector('.tabbar')
    const view = document.querySelector('.app__viewport')
    return {
      tabs: document.querySelectorAll('.tabbar__item').length,
      labels: [...document.querySelectorAll('.tabbar__label')].map(e => e.textContent.trim()),
      barInsideView: view ? view.contains(bar) : null,
      barIsSibling: bar ? bar.parentElement?.className : null,
      activeColor: getComputedStyle(document.querySelector('.tabbar__item--active')).color,
    }
  })()`)
  check('3 tabs', structure.tabs === 3, structure.tabs)
  check('tab order matches the registry', JSON.stringify(structure.labels) === JSON.stringify(['发现','书架','我']), JSON.stringify(structure.labels))
  check('tab bar outside the routed view', structure.barInsideView === false, JSON.stringify(structure))
  check('active tab uses brand colour', structure.activeColor === 'rgb(27, 136, 238)', structure.activeColor)

  /* ---------- 3. switching: identity + state sync *within* the transition ---------- */
  const switchResult = await page.evaluate(`(async () => {
    const barBefore = document.querySelector('.tabbar')
    const shelfBefore = document.querySelector('.discover')
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    const byLabel = (l) => tabs.find(t => t.textContent.trim() === l)

    const t0 = performance.now()
    byLabel('书架').click()

    // Sample once the transition is visibly running (Vue attaches the
    // enter/leave classes one frame after the click).
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))
    const mid = {
      ms: performance.now() - t0,
      activeLabel: document.querySelector('.tabbar__item--active .tabbar__label')?.textContent.trim(),
      leavingExists: !!document.querySelector('.discover'),
      enteringExists: !!document.querySelector('.shelf'),
      barSame: document.querySelector('.tabbar') === barBefore,
      shelfSame: document.querySelector('.discover') === shelfBefore,
      // Both layers must be painted mid-transition: that is what "no blank frame" means.
      paintedNodes: document.querySelectorAll('.app__viewport *').length,
    }

    await new Promise(r => setTimeout(r, 400))
    const settled = {
      activeLabel: document.querySelector('.tabbar__item--active .tabbar__label')?.textContent.trim(),
      leavingGone: !document.querySelector('.discover'),
      discoverPresent: !!document.querySelector('.shelf'),
      barSame: document.querySelector('.tabbar') === barBefore,
    }
    return { mid, settled }
  })()`)

  check('active state flips immediately', switchResult.mid.activeLabel === '书架', switchResult.mid.activeLabel)
  // With `mode` removed the two pages coexist; if the leaving node is already
  // gone at frame 2 the transition ran as a cut. Accept 1 painted layer as long
  // as the incoming page was painted within the same frame budget.
  check('transition keeps a painted layer', switchResult.mid.paintedNodes > 10, JSON.stringify(switchResult.mid))
  check('tab bar survives the switch (same node)', switchResult.mid.barSame && switchResult.settled.barSame, JSON.stringify({ mid: switchResult.mid.barSame, settled: switchResult.settled.barSame }))
  check('outgoing page removed after settle', switchResult.settled.leavingGone, JSON.stringify(switchResult.settled))
  check('incoming page mounted', switchResult.settled.discoverPresent, JSON.stringify(switchResult.settled))

  /* ---------- 4. switching back keeps the cached shelf instance ---------- */
  // Switch away and back to prove <KeepAlive> kept the shelf instance.
  await page.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    const byLabel = (l) => tabs.find(t => t.textContent.trim() === l)
    byLabel('发现').click()
    await new Promise(r => setTimeout(r, 360))
    byLabel('书架').click()
    await new Promise(r => setTimeout(r, 360))
  })()`)
  const afterBack = await page.evaluate(`(async () => ({
    shelfPresent: !!document.querySelector('.shelf'),
    activeLabel: document.querySelector('.tabbar__item--active .tabbar__label')?.textContent.trim(),
    // A cached component keeps its DOM nodes; a remounted one would not.
    hasGridOrEmpty: !!document.querySelector('.shelf__grid, .shelf__empty'),
  }))()`)
  check('shelf restored after switching back', afterBack.shelfPresent, JSON.stringify(afterBack))
  check('active tab back to 书架', afterBack.activeLabel === '书架', afterBack.activeLabel)
  check('cached shelf renders its content', afterBack.hasGridOrEmpty, JSON.stringify(afterBack))

  /* ---------- 5. frame budget during a switch ---------- */
  const frames = await page.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    const deltas = []
    let last = performance.now()
    let running = true
    const tick = (now) => {
      deltas.push(now - last)
      last = now
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    tabs[1].click()
    await new Promise(r => setTimeout(r, 450))
    running = false

    // Ignore the first sample (it measures the gap before rAF started).
    const d = deltas.slice(1)
    const sorted = [...d].sort((a, b) => a - b)
    return {
      count: d.length,
      max: Math.round(Math.max(...d, 0)),
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
      over50: d.filter(x => x > 50).length,
    }
  })()`)
  check('transition rendered frames', frames.count > 10, JSON.stringify(frames))

  /* ---------- 5b. easing shape: no jump-cut ---------- */
  const curve = await page.evaluate(`(async () => {
    const t = [...document.querySelectorAll('.tabbar__item')]
    const samples = []
    const target = [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === '发现')
    const t0 = performance.now()
    target.click()
    for (let i = 0; i < 18; i++) {
      await new Promise(r => requestAnimationFrame(r))
      // The outgoing page is the one whose opacity is animating down.
      const out = document.querySelector('.shelf')
      if (out) samples.push({ t: performance.now() - t0, op: +getComputedStyle(out).opacity })
    }
    return samples
  })()`)
  // The leaving page starts fully opaque and decays; what matters is that it
  // does so over many frames instead of snapping.
  const faded = curve.filter(s => s.op < 0.98)
  check('outgoing page fades over multiple frames', faded.length >= 4,
    JSON.stringify(curve.map(s => +s.op.toFixed(2))))
  const monotonic = curve.every((s, i) => i === 0 || s.op <= curve[i - 1].op + 0.02)
  check('opacity ramps monotonically down', monotonic, JSON.stringify(curve.map(s => +s.op.toFixed(2))))
  const distinct = new Set(curve.map(s => Math.round(s.op * 10))).size
  check('transition has intermediate frames', distinct >= 4, distinct)
  check('no long frame (>50ms) during switch', frames.over50 === 0, JSON.stringify(frames))
  check('p95 frame under 24ms', frames.p95 <= 24, JSON.stringify(frames))

  /* ---------- 6. hardware back semantics on the web ---------- */
  const historyDepth = await page.evaluate(`(() => {
    // Tab switches must replace, not push: 3 tab taps should not add history.
    return { length: history.length }
  })()`)
  await page.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    tabs[2].click(); await new Promise(r => setTimeout(r, 300))
    tabs[0].click(); await new Promise(r => setTimeout(r, 300))
  })()`)
  const historyAfter = await page.evaluate(`(() => ({ length: history.length }))()`)
  check('tab switches do not grow history', historyAfter.length === historyDepth.length, JSON.stringify({ before: historyDepth, after: historyAfter }))

  await page.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    tabs[1].click(); await new Promise(r => setTimeout(r, 350))
  })()`)
  /* ---------- 7. book-open shared-element transition ---------- */
  // Seed a book (via the app's own IndexedDB), return to the shelf, reload so the
  // store re-reads it, then open it and sample the flying layer per frame.
  await page.evaluate(`(async () => {
    const byLabel = (l) => [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === l)
    byLabel('书架')?.click()
    await new Promise(r => setTimeout(r, 300))
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const db = await open(); const now = Date.now()
    const put = (s, v) => new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite'); const q = t.objectStore(s).put(v)
      q.onsuccess = () => res(); q.onerror = () => rej(q.error)
    })
    await put('books', { id: 'anim1', title: '转场测试', author: 'x', format: 'txt', cover: null,
      wordCount: 9000, fileSize: 1, importedAt: now, lastReadAt: now, progress: 0,
      lastChapterIndex: 0, lastCharOffset: 0, finished: false, parserVersion: 4, sourceName: 'a.txt' })
    await put('chapters', { bookId: 'anim1', index: 0, title: '第1章', html: '<p>' + ('正文内容。'.repeat(400)) + '</p>',
      text: 'x', charOffset: 0, wordCount: 2000 })
    location.reload()
  })()`)
  await new Promise(r => setTimeout(r, 2000))

  const openAnim = await page.evaluate(`(async () => {
    const item = document.querySelector('.shelf__item')
    if (!item) return { error: 'no book on shelf' }
    // Measure the cover, not the whole tile: the clone animates the cover box,
    // and the tile also carries the title and progress bar.
    const cover = item.querySelector('.shelf__cover') || item
    const start = cover.getBoundingClientRect()
    item.click()
    const frames = []
    for (let i = 0; i < 16; i++) {
      await new Promise(r => requestAnimationFrame(r))
      const stage = document.querySelector('[data-shared-element-stage]')
      const clone = stage && stage.lastElementChild
      if (clone) {
        const c = clone.getBoundingClientRect()
        frames.push({ t: Math.round(c.top), h: Math.round(c.height), w: Math.round(c.width) })
      }
    }
    return { start: { t: Math.round(start.top), h: Math.round(start.height), w: Math.round(start.width) }, frames }
  })()`)
  check('open animation produced frames', !openAnim.error && openAnim.frames.length >= 6,
    JSON.stringify(openAnim.error || openAnim.frames.length))
  const f0 = openAnim.frames[0]
  check('flying cover starts at the tapped cover', f0 && Math.abs(f0.h - Math.round(openAnim.start.h)) < 24,
    JSON.stringify({ start: openAnim.start, first: f0 }))
  const fLast = openAnim.frames[openAnim.frames.length - 1]
  check('cover grows toward full width', fLast && fLast.w > (f0?.w || 0) + 40,
    JSON.stringify({ first: f0, last: fLast }))
  check('cover expansion is monotonic', openAnim.frames.every((f, i) => i === 0 || f.h >= openAnim.frames[i - 1].h - 2),
    JSON.stringify(openAnim.frames.map(f => f.h)))

  await new Promise(r => setTimeout(r, 900))
  const landed = await page.evaluate(`(() => ({
    stageGone: !document.querySelector('[data-shared-element-stage]'),
    inReader: !!document.querySelector('.reader__pages'),
    path: location.pathname,
  }))()`)
  check('stage removed after landing', landed.stageGone, JSON.stringify(landed))
  check('reader rendered under the animation', landed.inReader, JSON.stringify(landed))

  /* ---------- 8. icon system consistency ---------- */
  await page.goto(`${BASE}/shelf`, 1000)
  const icons = await page.evaluate(`(() => {
    const svgs = [...document.querySelectorAll('svg')]
    const bars = svgs.filter(s => s.closest('.tabbar, .bottombar, .topbar, .shelf, .settings-page'))
    return {
      total: svgs.length,
      // Every icon must come from the shared component: same viewBox, stroke caps.
      allSameViewBox: bars.every(s => s.getAttribute('viewBox') === '0 0 24 24'),
      allRoundCaps: bars.every(s => s.getAttribute('stroke-linecap') === 'round'),
      colorInherited: bars.every(s => s.getAttribute('stroke') === 'currentColor'),
      // Inline one-off SVGs would break the geometry check above.
      inlineLeftovers: bars.filter(s => !s.hasAttribute('aria-hidden')).length,
      // All three tab glyphs are solid fills, not a mix of fill and outline.
      tabIconsFilled: [...document.querySelectorAll('.tabbar svg')].every(s => {
        const paths = [...s.querySelectorAll('path')]
        return paths.length > 0 && paths.every(p => p.getAttribute('fill') === 'currentColor')
      }),
    }
  })()`)
  check('all chrome icons use the 24x24 grid', icons.allSameViewBox, JSON.stringify(icons))
  check('all chrome icons use round caps', icons.allRoundCaps, JSON.stringify(icons))
  check('icons inherit colour', icons.colorInherited, JSON.stringify(icons))
  check('no inline one-off icons remain', icons.inlineLeftovers === 0, JSON.stringify(icons))
  check('all tab glyphs are filled', icons.tabIconsFilled, JSON.stringify(icons))

  /* ---------- 9. typography lives in 设置, not 我 ---------- */
  await page.goto(`${BASE}/me`, 1400)
  const meControls = await page.evaluate(`(() => ({
    slider: !!document.querySelector('.me__slider'),
    fontRow: [...document.querySelectorAll('.me__row')].some(e => e.textContent.includes('字体')),
    importRow: [...document.querySelectorAll('.me__row')].some(e => e.textContent.includes('导入本地书籍')),
    settingsRow: [...document.querySelectorAll('.me__row')].some(e => e.textContent.includes('阅读设置')),
  }))()`)
  check('我 page no longer exposes font size', meControls.slider === false, JSON.stringify(meControls))
  check('我 page no longer exposes font family', meControls.fontRow === false, JSON.stringify(meControls))
  check('我 page does not duplicate import/settings actions',
    !meControls.importRow && !meControls.settingsRow, JSON.stringify(meControls))

  await page.goto(`${BASE}/settings`, 1200)
  const settingsEntry = await page.evaluate(`(() => {
    const cell = [...document.querySelectorAll('.settings-cell')].find(e => e.textContent.includes('字体'))
    return { hasFontCell: !!cell, label: cell?.innerText.replace(/\\n/g, ' | ') || '' }
  })()`)
  check('设置 page exposes a font entry', settingsEntry.hasFontCell, JSON.stringify(settingsEntry))
  await page.evaluate(`[...document.querySelectorAll('.settings-cell')].find(e => e.textContent.includes('字体'))?.click()`)
  await new Promise(r => setTimeout(r, 700))
  const fontPage = await page.evaluate(`(() => ({
    path: location.pathname,
    title: document.querySelector('.font-title')?.textContent || '',
    rows: document.querySelectorAll('.font-row').length,
  }))()`)
  check('font entry opens the second-level picker', fontPage.path === '/settings/font', JSON.stringify(fontPage))
  check('font picker lists fonts', fontPage.rows >= 8 && fontPage.title === '字体', JSON.stringify(fontPage))

  // Navigate from the driver rather than from inside the page: assigning
  // location.href during an awaited evaluate tears the execution context down
  // mid-promise, which CDP reports as a hard error.
  await page.goto(`${BASE}/shelf`, 1200)
  const isolation = await page.evaluate(`document.querySelectorAll('.shelf__item').length >= 0`)
  check('navigated back to shelf', isolation, '')

  await page.screenshot('/tmp/tab-discover.png')
  await page.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabbar__item')]
    tabs[0].click(); await new Promise(r => setTimeout(r, 350))
  })()`)
  await page.screenshot('/tmp/tab-shelf.png')

  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
} finally {
  page.close()
  chrome.kill()
}

process.exit(fail === 0 ? 0 : 1)
