/**
 * End-to-end test in real Chrome against the dev server.
 * Covers what unit tests cannot: real pagination (CSS multicol), tab switching,
 * gesture taps, font-size relayout keeping the same character, progress restore.
 *
 * Requires the dev server on 127.0.0.1:5173.
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

  /* ---------- 1. shell renders ---------- */
  const shell = await page.evaluate(`(() => ({
    title: document.title,
    hasApp: !!document.querySelector('.app'),
    tabbarCount: document.querySelectorAll('.tabbar__item').length,
    tabs: [...document.querySelectorAll('.tabbar__label')].map(e => e.textContent.trim()),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }))()`)
  check('title is 微信读书', shell.title === '微信读书', shell.title)
  check('app mounted', shell.hasApp, '')
  check('tabbar has 3 tabs', shell.tabbarCount === 3, shell.tabbarCount)
  check('no dead 有声书 tab', !shell.tabs.includes('有声书'), JSON.stringify(shell.tabs))

  /* ---------- 2. seed data through the app's own IndexedDB ---------- */
  const seeded = await page.evaluate(`(async () => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
      r.onupgradeneeded = () => {}
    })
    const db = await open()
    const now = Date.now()
    const put = (store, value) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite')
      const r = t.objectStore(store).put(value)
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    for (const b of [
      { id: 'e1', title: '端到端测试书', author: '测试', format: 'txt', cover: null,
        wordCount: 6000, fileSize: 999, importedAt: now, lastReadAt: now, progress: 33,
        lastChapterIndex: 1, lastCharOffset: 400, finished: false },
      { id: 'e2', title: '另一本', author: '李四', format: 'txt', cover: null,
        wordCount: 3000, fileSize: 888, importedAt: now - 1000, lastReadAt: now - 500,
        progress: 90, lastChapterIndex: 0, lastCharOffset: 0, finished: false },
    ]) await put('books', b)
    for (let i = 0; i < 4; i++) {
      await put('chapters', {
        bookId: 'e1', index: i, title: '第' + (i + 1) + '章 测试章节',
        html: '<p>' + ('这是第' + (i + 1) + '章的测试正文内容，用于验证分页与进度。').repeat(120) + '</p>',
        text: 'x', charOffset: 0, wordCount: 2000,
      })
    }
    return { ok: true, bookCount: 2 }
  })()`)
  check('seeded via IndexedDB', seeded.ok, JSON.stringify(seeded))

  /* ---------- 3. shelf lists the books ---------- */
  await page.goto(`${BASE}/shelf`, 1200)
  const shelf = await page.evaluate(`(() => ({
    items: document.querySelectorAll('.shelf__item').length,
    titles: [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim()),
    sortTabs: [...document.querySelectorAll('.shelf__tab')].map(e => e.textContent.trim()),
    progressBadges: document.querySelectorAll('.shelf__badge').length,
  }))()`)
  check('shelf shows seeded books', shelf.items === 2, shelf.items)
  check('shelf titles correct', shelf.titles.includes('端到端测试书'), JSON.stringify(shelf.titles))
  check('shelf shows progress badges', shelf.progressBadges >= 1, shelf.progressBadges)
  check('shelf sort tabs functional set', shelf.sortTabs.length === 7, JSON.stringify(shelf.sortTabs))

  /* ---------- 4. sort tabs actually reorder ---------- */
  const sorted = await page.evaluate(`(async () => {
    const before = [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim())
    const tabs = [...document.querySelectorAll('.shelf__tab')]
    const nameTab = tabs.find(t => t.textContent.trim() === '书名')
    nameTab.click()
    await new Promise(r => setTimeout(r, 300))
    const after = [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim())
    const active = document.querySelector('.shelf__tab--active')?.textContent.trim()
    const progressTab = tabs.find(t => t.textContent.trim() === '进度')
    progressTab.click()
    await new Promise(r => setTimeout(r, 300))
    const byProgress = [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim())
    return { before, after, active, byProgress }
  })()`)
  check('sort tab becomes active', sorted.active === '书名', sorted.active)
  // localeCompare('zh') uses pinyin: 端(duan) sorts before 另(ling).
  check('sort by name reorders', sorted.after[0] === '端到端测试书', JSON.stringify(sorted.after))
  check('sort by progress reorders', sorted.byProgress[0] === '另一本', JSON.stringify(sorted.byProgress))

  /* ---------- 5. search works ---------- */
  const search = await page.evaluate(`(async () => {
    document.querySelector('.shelf__search').click()
    await new Promise(r => setTimeout(r, 200))
    const input = document.querySelector('.shelf__search--active input')
    if (!input) return { found: false }
    input.value = '端到端'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    const titles = [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim())
    const cancel = document.querySelector('.shelf__search-cancel')
    cancel.click()
    await new Promise(r => setTimeout(r, 300))
    const restored = [...document.querySelectorAll('.shelf__item-title')].map(e => e.textContent.trim())
    return { found: true, filtered: titles, restored }
  })()`)
  check('search input appears', search.found, JSON.stringify(search))
  check('search filters to one book', search.filtered?.length === 1 && search.filtered[0] === '端到端测试书', JSON.stringify(search.filtered))
  check('search cancel restores list', search.restored?.length === 2, JSON.stringify(search.restored))

  /* ---------- 6. reader paginates with real layout ---------- */
  await page.goto(`${BASE}/reader/e1`, 1600)
  const reader = await page.evaluate(`(() => {
    const pages = document.querySelector('.reader__pages')
    const cs = pages ? getComputedStyle(pages) : null
    return {
      hasPages: !!pages,
      columnWidth: cs?.columnWidth,
      scrollWidth: pages?.scrollWidth,
      clientWidth: pages?.clientWidth,
      textLength: (pages?.textContent || '').length,
      // Chapter name lives in the opener heading; the status strip carries only
      // the position, matching WeRead.
      status: document.querySelector('.reader__ch')?.textContent.replace(/\s+/g, ' ').trim(),
      percent: document.querySelector('.reader__status-right')?.textContent.trim(),
      transform: pages?.style.transform,
    }
  })()`)
  check('reader content rendered', reader.hasPages && reader.textLength > 1000, JSON.stringify({ ...reader, textLength: reader.textLength }))
  check('multi-column layout active', !!reader.columnWidth && reader.columnWidth !== 'auto', reader.columnWidth)
  check('reader paginated into pages', reader.scrollWidth > reader.clientWidth, `${reader.scrollWidth} vs ${reader.clientWidth}`)
  check('reader restored chapter 2', (reader.status || '').includes('第2章'), reader.status)
  check('reader shows percent', /%$/.test(reader.percent || ''), reader.percent)

  /* ---------- 6b. pagination geometry: whole lines, no clipped text ---------- */
  const geom = await page.evaluate(`(() => {
    const el = document.querySelector('.reader__pages')
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight)
    const pageH = el.getBoundingClientRect().height
    const w = parseFloat(cs.columnWidth)
    const gap = parseFloat(cs.columnGap)
    const pages = Math.round((el.scrollWidth + gap) / (w + gap))
    return { pageH, lh, lines: pageH / lh, remainder: pageH % lh, w, gap, pages,
             scrollW: el.scrollWidth }
  })()`)
  check('page height is a whole number of lines', Math.abs(geom.remainder) < 0.5 || Math.abs(geom.remainder - geom.lh) < 0.5,
    JSON.stringify(geom))
  check('page fits >= 10 full lines', geom.lines >= 10, geom.lines)
  check('column gap is part of the stride', geom.gap > 0, JSON.stringify({ w: geom.w, gap: geom.gap }))
  const strideCoverage = geom.pages * (geom.w + geom.gap) - geom.gap
  check('page count covers content width', Math.abs(strideCoverage - geom.scrollW) < geom.w + geom.gap,
    JSON.stringify({ strideCoverage, scrollW: geom.scrollW }))

  /* ---------- 7. tapping right advances a page ---------- */
  const firstTransform = reader.transform
  const tapResult = await page.evaluate(`(async () => {
    const vp = document.querySelector('.reader__viewport')
    const r = vp.getBoundingClientRect()
    const before = document.querySelector('.reader__pages').style.transform
    const opts = { bubbles: true, clientX: r.right - 20, clientY: r.top + r.height / 2 }
    vp.dispatchEvent(new MouseEvent('click', opts))
    await new Promise(r2 => setTimeout(r2, 500))
    const after = document.querySelector('.reader__pages').style.transform
    return { before, after }
  })()`)
  check('right tap turns page', tapResult.before !== tapResult.after, JSON.stringify(tapResult))
  check('page transform is offset px', /translateX\(-\d+(\.\d+)?px\)/.test(tapResult.after || ''), tapResult.after)

  /* ---------- 8. font-size change keeps the reader on the same character ---------- */
  const relayout = await page.evaluate(`(async () => {
    const pagesEl = () => document.querySelector('.reader__pages')
    const settingsKey = 'reader'
    // Character offset implied by the current page transform.
    const readState = () => {
      const el = pagesEl()
      const m = /translateX\\((-?[\\d.]+)px\\)/.exec(el.style.transform || 'translateX(0px)')
      const w = parseFloat(getComputedStyle(el).columnWidth)
      const page = m ? Math.round(Math.abs(parseFloat(m[1])) / w) : 0
      const pages = Math.max(1, Math.round(el.scrollWidth / w))
      return { page, pages, w }
    }
    const before = readState()
    // Bump font size the way the panel does (store → IndexedDB → reactive).
    const openMenu = () => {
      const vp = document.querySelector('.reader__viewport')
      const r = vp.getBoundingClientRect()
      vp.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
    }
    openMenu()
    await new Promise(r => setTimeout(r, 400))
    const fontBtn = [...document.querySelectorAll('.bottombar__item')].find(b => b.getAttribute('aria-label') === '字体')
    if (!fontBtn) return { error: 'font button not found' }
    fontBtn.click()
    await new Promise(r => setTimeout(r, 400))
    const bigger = document.querySelector('.fp-a--lg')
    if (!bigger) return { error: 'font size + not found' }
    for (let i = 0; i < 6; i++) { bigger.click(); await new Promise(r => setTimeout(r, 120)) }
    await new Promise(r => setTimeout(r, 600))
    const after = readState()
    const fontSize = getComputedStyle(pagesEl()).fontSize
    return { before, after, fontSize }
  })()`)
  check('relayout produced state', !relayout.error, JSON.stringify(relayout))
  check('font size actually increased', parseFloat(relayout.fontSize) > 19, relayout.fontSize)
  check('relayout changed pagination', relayout.after?.pages !== relayout.before?.pages || relayout.after?.w !== relayout.before?.w,
    JSON.stringify({ before: relayout.before, after: relayout.after }))

  /* ---------- 9. menu opens and catalog jumps chapters ---------- */
  const catalog = await page.evaluate(`(async () => {
    const catalogBtn = [...document.querySelectorAll('.bottombar__item')].find(b => b.getAttribute('aria-label') === '目录')
    if (!catalogBtn) return { error: 'catalog button missing' }
    catalogBtn.click()
    await new Promise(r => setTimeout(r, 400))
    const drawer = document.querySelector('.catalog-mask')
    const items = [...document.querySelectorAll('.catalog__row')]
    if (items.length < 3) return { error: 'catalog items missing', count: items.length }
    items[2].click()
    await new Promise(r => setTimeout(r, 700))
    return {
      drawerOpened: !!drawer,
      itemCount: items.length,
      // The chapter opener carries the name now; the status strip is empty by
      // design (WeRead shows only the position there).
      status: document.querySelector('.reader__ch')?.textContent.replace(/\s+/g, ' ').trim(),
    }
  })()`)
  check('catalog drawer opens', catalog.drawerOpened, JSON.stringify(catalog))
  check('catalog lists chapters', catalog.itemCount === 4, catalog.itemCount)
  check('catalog jump moves to chapter 3', (catalog.status || '').includes('第3章'), catalog.status)

  /* ---------- 10. progress persists and restores ---------- */
  await page.evaluate(`(async () => {
    await new Promise(r => setTimeout(r, 900))
    return true
  })()`)
  const saved = await page.evaluate(`(async () => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const db = await open()
    const book = await new Promise((res, rej) => {
      const t = db.transaction('books', 'readonly')
      const r = t.objectStore('books').get('e1')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    return { lastChapterIndex: book?.lastChapterIndex, lastCharOffset: book?.lastCharOffset, progress: book?.progress }
  })()`)
  check('progress saved chapter index', saved.lastChapterIndex === 2, JSON.stringify(saved))
  check('progress saved non-zero char offset', typeof saved.lastCharOffset === 'number', JSON.stringify(saved))

  await page.goto(`${BASE}/reader/e1`, 1600)
  const restored = await page.evaluate(`(() => ({
    status: document.querySelector('.reader__ch')?.textContent.replace(/\\s+/g, ' ').trim(),
    percent: document.querySelector('.reader__status-right')?.textContent.trim(),
  }))()`)
  check('reload restores saved chapter', (restored.status || '').includes('第3章'), JSON.stringify(restored))

  /* ---------- 11. themes apply ---------- */
  const theme = await page.evaluate(`(async () => {
    localStorage.setItem('theme-test', '1')
    const settings = indexedDB.open('weread')
    const db = await new Promise((res, rej) => {
      settings.onsuccess = () => res(settings.result)
      settings.onerror = () => rej(settings.error)
    })
    await new Promise((res, rej) => {
      const t = db.transaction('settings', 'readwrite')
      const r = t.objectStore('settings').put({ key: 'reader', fontSize: 19, lineHeight: 1.8, pageMargin: 22, theme: 'black', background: 'plain', fontFamily: 'system', turnPageType: 'horizontal', firstLineIndent: true, brightness: -1, showStatusBar: false, volumeKeyTurn: false, landscape: false, noAutoLock: false })
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    location.reload()
    return { reloading: true }
  })()`).catch(() => ({ reloading: true }))
  await new Promise(r => setTimeout(r, 1800))
  const themed = await page.evaluate(`(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.querySelector('.reader') || document.body).backgroundColor,
  }))()`)
  check('theme persisted to DOM', themed.attr === 'black', JSON.stringify(themed))
  check('dark theme background applied', themed.bg === 'rgb(26, 26, 26)', themed.bg)

  /* ---------- 12. vertical scroll mode ---------- */
  await page.evaluate(`(async () => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const db = await open()
    await new Promise((res, rej) => {
      const t = db.transaction('settings', 'readwrite')
      const r = t.objectStore('settings').put({ key: 'reader', fontSize: 19, lineHeight: 1.8, pageMargin: 22, theme: 'white', background: 'plain', fontFamily: 'system', turnPageType: 'vertical', firstLineIndent: true, brightness: -1, showStatusBar: false, volumeKeyTurn: false, landscape: false, noAutoLock: false })
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    location.reload()
  })()`).catch(() => {})
  await new Promise(r => setTimeout(r, 1800))
  const scrollMode = await page.evaluate(`(() => {
    const vp = document.querySelector('.reader__viewport')
    const pages = document.querySelector('.reader__pages')
    return {
      scrollClass: vp?.classList.contains('reader__viewport--scroll'),
      pagesScroll: pages?.classList.contains('reader__pages--scroll'),
      overflowY: vp ? getComputedStyle(vp).overflowY : '',
      scrollHeight: vp?.scrollHeight,
      clientHeight: vp?.clientHeight,
    }
  })()`)
  check('scroll mode class applied', scrollMode.scrollClass && scrollMode.pagesScroll, JSON.stringify(scrollMode))
  check('scroll mode container scrolls', scrollMode.overflowY === 'auto', scrollMode.overflowY)

  /* ---------- 12b. settings cards are not clipped by flex shrink ---------- */
  await page.goto(`${BASE}/settings`, 1200)
  const settingsLayout = await page.evaluate(`(() => {
    return [...document.querySelectorAll('.settings-group')].map(g => {
      const r = g.getBoundingClientRect()
      return { h: Math.round(r.height), scrollH: g.scrollHeight,
               clipped: g.scrollHeight > Math.ceil(r.height) + 1 }
    })
  })()`)
  check('settings rendered cards', settingsLayout.length >= 2, settingsLayout.length)
  check('no settings card is clipped', settingsLayout.every(g => !g.clipped),
    JSON.stringify(settingsLayout.filter(g => g.clipped)))
  // Typography (including background) moved into the reader's 亮度 panel.
  // Verify it is reachable there and that the settings page no longer
  // duplicates it — the whole point of splitting the two pages.
  const typographySplit = await page.evaluate(`(() => {
    const page = document.querySelector('.settings-page')
    const settingsText = page?.textContent || ''
    return {
      // Look for the actual *controls*, not prose: the hint paragraph names
      // 字体/字号/背景 on purpose to point users at the reader panel.
      settingsHasFontSize: !!page?.querySelector('input[type="range"]'),
      settingsHasBackground: !!page?.querySelector('.bg-row, .tp-bgs'),
      keptToggles: ['阅读时显示时间和电量','使用音量键翻页','阅读时允许横屏','阅读时不自动锁屏']
        .filter(t => settingsText.includes(t)).length,
    }
  })()`)
  check('settings drops typography controls', !typographySplit.settingsHasFontSize && !typographySplit.settingsHasBackground,
    JSON.stringify(typographySplit))
  check('settings keeps the four reading toggles', typographySplit.keptToggles === 4, JSON.stringify(typographySplit))

  /* ---------- 12c. background picker lives in the reader panel ---------- */
  await page.goto(`${BASE}/shelf`, 900)
  await page.evaluate(`document.querySelector('.shelf__item')?.click()`)
  await new Promise(r => setTimeout(r, 1400))
  await page.evaluate(`(async () => {
    const vp = document.querySelector('.reader__viewport')
    if (!vp) return
    const r = vp.getBoundingClientRect()
    vp.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
  })()`)
  await new Promise(r => setTimeout(r, 400))
  await page.evaluate(`document.querySelector('[aria-label="亮度"]')?.click()`)
  await new Promise(r => setTimeout(r, 400))

  const bgButtons = await page.evaluate(`(() => {
    const row = document.querySelector('.tp-bgs')
    return {
      count: row ? row.querySelectorAll('.tp-bg').length : 0,
      active: row ? row.querySelectorAll('.tp-bg.active').length : 0,
      labelled: row ? [...row.querySelectorAll('.tp-bg')].every(b => !!b.title) : false,
      hasThemes: document.querySelectorAll('.tp-theme').length,
      hasBrightness: !!document.querySelector('.tp-row .capsule'),
    }
  })()`)
  check('background picker in reader panel', bgButtons.count === 5, JSON.stringify(bgButtons))
  check('exactly one background selected', bgButtons.active === 1, JSON.stringify(bgButtons))
  check('background options are labelled', bgButtons.labelled, JSON.stringify(bgButtons))
  check('brightness slider present', bgButtons.hasBrightness, JSON.stringify(bgButtons))
  check('four colour themes present', bgButtons.hasThemes === 4, JSON.stringify(bgButtons))

  const readerChrome = await page.evaluate(`(() => {
    const bar = document.querySelector('.topbar')
    const labels = [...document.querySelectorAll('.topbar__action')].map(b => b.getAttribute('aria-label'))
    return {
      // The gear must not exist anywhere in the reader chrome.
      hasGearButton: !!bar?.querySelector('[aria-label="设置"]'),
      hasGearIcon: /M19\.4 15/.test(bar?.innerHTML || ''),
      entryLabels: labels,
      backButtons: document.querySelectorAll('.topbar__btn').length,
      bottomLabels: [...document.querySelectorAll('.bottombar__item')].map(b => b.getAttribute('aria-label')),
    }
  })()`)
  check('no settings gear in reader top bar', !readerChrome.hasGearButton && !readerChrome.hasGearIcon, JSON.stringify(readerChrome))
  check('reader top bar has book actions', JSON.stringify(readerChrome.entryLabels) === JSON.stringify(['想法','分享','更多']), JSON.stringify(readerChrome.entryLabels))
  check('reader bottom bar matches WeRead', JSON.stringify(readerChrome.bottomLabels) === JSON.stringify(['目录','笔记','进度','亮度','字体']), JSON.stringify(readerChrome.bottomLabels))

  /* ---------- 13. screenshots for visual proof ---------- */
  await page.evaluate(`(async () => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open('weread')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const db = await open()
    await new Promise((res, rej) => {
      const t = db.transaction('settings', 'readwrite')
      const r = t.objectStore('settings').put({ key: 'reader', fontSize: 19, lineHeight: 1.8, pageMargin: 22, theme: 'white', background: 'plain', fontFamily: 'system', turnPageType: 'horizontal', firstLineIndent: true, brightness: -1, showStatusBar: false, volumeKeyTurn: false, landscape: false, noAutoLock: false })
      r.onsuccess = () => res()
      r.onerror = () => rej(r.error)
    })
    location.reload()
  })()`).catch(() => {})
  await new Promise(r => setTimeout(r, 1800))
  await page.screenshot('/tmp/wr-reader.png')
  await page.goto(`${BASE}/shelf`, 1200)
  await page.screenshot('/tmp/wr-shelf.png')
  await page.goto(`${BASE}/settings`, 1000)
  await page.screenshot('/tmp/wr-settings.png')
  await page.goto(`${BASE}/catalog/e1`, 1200)
  await page.screenshot('/tmp/wr-catalog.png')

  /* ---------- 14. 导入 opens the picker in one tap ---------- */
  // The old flow was 导入 → sheet → /import → 选择文件. Now the tap itself must
  // raise the system dialog, with no navigation and no intermediate sheet.
  // The dialog itself is asserted through the file input's own click() call:
  // the Page domain is not enabled in this harness (see tests/cdp.mjs), so
  // Page.fileChooserOpened is not available.
  await page.goto(`${BASE}/shelf`, 1200)
  const importClick = await page.evaluate(`(async () => {
    const before = location.pathname
    let pickerCalls = 0
    let accept = ''
    const realClick = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') { pickerCalls++; accept = this.accept }
      return realClick.call(this)
    }
    const btn = [...document.querySelectorAll('.shelf__bar-btn')].find(b => b.textContent.includes('导入'))
    btn?.click()
    await new Promise(r => setTimeout(r, 250))
    HTMLInputElement.prototype.click = realClick
    return {
      before,
      after: location.pathname,
      sheet: !!document.querySelector('.sheet'),
      pickerCalls,
      accept,
    }
  })()`)
  check('导入 calls the file picker itself', importClick.pickerCalls === 1, JSON.stringify(importClick))
  check('导入 offers the parseable formats', importClick.accept.includes('.epub') && importClick.accept.includes('.txt'),
    JSON.stringify(importClick))
  check('导入 does not navigate anywhere', importClick.before === importClick.after, JSON.stringify(importClick))
  check('导入 no longer needs a sheet', !importClick.sheet, JSON.stringify(importClick))

  /* ---------- 15. reader status line shares the page surface ---------- */
  // The strip used to paint `var(--bg)` — a flat band with a shadowed seam over
  // any textured background. It must now be transparent so the page (colour and
  // texture) runs to the bottom edge.
  await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('weread'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    await new Promise((res, rej) => {
      const t = db.transaction('settings', 'readwrite')
      t.objectStore('settings').put({ key: 'reader', fontSize: 19, lineHeight: 1.8, pageMargin: 22,
        theme: 'white', background: 'paper', fontFamily: 'system', turnPageType: 'horizontal',
        firstLineIndent: true, brightness: -1, showStatusBar: false, volumeKeyTurn: false,
        landscape: false, noAutoLock: false })
      t.oncomplete = res; t.onerror = rej
    })
  })()`)
  await page.goto(`${BASE}/reader/e1`, 1500)
  const strip = await page.evaluate(`(() => {
    const s = document.querySelector('.reader__status')
    if (!s) return { error: 'no status line' }
    const cs = getComputedStyle(s)
    return {
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
      readerImage: getComputedStyle(document.querySelector('.reader')).backgroundImage,
      statusImage: cs.backgroundImage,
    }
  })()`)
  check('status line paints no background of its own', strip.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(strip))
  check('status line has no shadow seam', strip.shadow === 'none', JSON.stringify(strip))
  check('reader keeps its texture behind the status line',
    strip.readerImage !== 'none' && strip.statusImage === 'none', JSON.stringify(strip))

  /* ---------- 16. shelf select mode has bulk actions ---------- */
  await page.goto(`${BASE}/shelf`, 1200)
  const selectFlow = await page.evaluate(`(async () => {
    const btns = () => [...document.querySelectorAll('.shelf__bar-btn')]
    const open = () => btns().find(b => b.textContent.includes('选择'))?.click()
    open()
    await new Promise(r => setTimeout(r, 250))
    const entered = {
      heading: document.querySelector('.shelf__title--selecting')?.textContent.trim(),
      actionBar: !!document.querySelector('.shelf-actions'),
      // The tab bar must give the action bar its place, not stack under it.
      tabbar: !!document.querySelector('.tabbar'),
      actions: [...document.querySelectorAll('.shelf-actions__btn')].map(b => b.textContent.trim()),
    }
    document.querySelectorAll('.shelf__item')[0]?.click()
    document.querySelectorAll('.shelf__item')[1]?.click()
    await new Promise(r => setTimeout(r, 200))
    const selected = {
      heading: document.querySelector('.shelf__title--selecting')?.textContent.trim(),
      rings: document.querySelectorAll('.shelf__item--selected').length,
    }
    // Select-all toggles: both books are ticked already, so the first press
    // clears, the second re-selects the whole shelf.
    const selectAllBtn = () => [...document.querySelectorAll('.shelf-actions__btn')][0]
    selectAllBtn()?.click()
    await new Promise(r => setTimeout(r, 200))
    const afterClear = document.querySelectorAll('.shelf__item--selected').length
    selectAllBtn()?.click()
    await new Promise(r => setTimeout(r, 200))
    const afterSelectAll = document.querySelectorAll('.shelf__item--selected').length
    const danger = [...document.querySelectorAll('.shelf-actions__btn')].find(b => b.textContent.includes('移出书架'))
    danger?.click()
    await new Promise(r => setTimeout(r, 260))
    const dialog = {
      open: !!document.querySelector('.dialog-card'),
      title: document.querySelector('.dialog-title')?.textContent.trim() || '',
      buttons: [...document.querySelectorAll('.dialog-btn')].map(b => b.textContent.trim()),
    }
    // Cancel first: the books must stay.
    document.querySelector('.dialog-btn')?.click()
    await new Promise(r => setTimeout(r, 260))
    const afterCancel = document.querySelectorAll('.shelf__item').length
    // Then confirm the real removal.
    danger?.click()
    await new Promise(r => setTimeout(r, 260))
    document.querySelector('.dialog-btn--primary')?.click()
    await new Promise(r => setTimeout(r, 700))
    return {
      entered,
      selected,
      afterClear,
      afterSelectAll,
      dialog,
      afterCancel,
      remaining: document.querySelectorAll('.shelf__item').length,
      exited: !document.querySelector('.shelf-actions'),
      tabbarBack: !!document.querySelector('.tabbar'),
    }
  })()`
  )
  check('select mode shows a count', selectFlow.entered.heading === '已选 0 本', JSON.stringify(selectFlow.entered))
  check('select mode has an action bar', selectFlow.entered.actionBar, JSON.stringify(selectFlow.entered))
  check('select mode hides the tab bar', selectFlow.entered.tabbar === false, JSON.stringify(selectFlow.entered))
  check('action bar offers 全选/移出书架/取消',
    JSON.stringify(selectFlow.entered.actions.map(a => a.replace(/全选|取消全选/, '全选'))) === JSON.stringify(['全选', '移出书架', '取消']),
    JSON.stringify(selectFlow.entered.actions))
  check('tapping books ticks them', selectFlow.selected.rings === 2 && selectFlow.selected.heading === '已选 2 本',
    JSON.stringify(selectFlow.selected))
  check('全选 toggles the whole shelf', selectFlow.afterClear === 0 && selectFlow.afterSelectAll === 2,
    JSON.stringify({ afterClear: selectFlow.afterClear, afterSelectAll: selectFlow.afterSelectAll }))
  check('remove uses the app dialog', selectFlow.dialog?.open && selectFlow.dialog?.title === '移出书架',
    JSON.stringify(selectFlow.dialog))
  check('dialog offers cancel/remove', JSON.stringify(selectFlow.dialog?.buttons) === JSON.stringify(['取消', '移出']),
    JSON.stringify(selectFlow.dialog?.buttons))
  check('cancel keeps the books', selectFlow.afterCancel === 2, selectFlow.afterCancel)
  check('移出书架 deletes the selection', selectFlow.remaining === 0 && selectFlow.exited && selectFlow.tabbarBack,
    JSON.stringify({ remaining: selectFlow.remaining, exited: selectFlow.exited, tabbar: selectFlow.tabbarBack }))

  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
} finally {
  page.close()
  chrome.kill()
}

process.exit(fail === 0 ? 0 : 1)
