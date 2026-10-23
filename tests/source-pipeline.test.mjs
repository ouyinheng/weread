/**
 * 四段管线单测：搜索 / 详情 + 目录 / 正文。
 *
 * `SourceCtx.doc()` 由 fixture 注入，不碰真实网络；这里验证的是规则映射、
 * tocUrl 为空时用详情页、目录翻页、正文分页防环，以及净化后的正文形状。
 */
import { Window } from 'happy-dom'
import { fillTemplate, loadBook, loadChapter, search } from '../src/utils/source/pipeline.ts'
import { SourceError } from '../src/types/source.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(ok ? 'ok  ' : 'FAIL', name, JSON.stringify(actual), ok ? '' : `want ${JSON.stringify(expected)}`)
  if (!ok) fail++
}

const win = new Window()
const BASE = 'https://site.test'

function makeSource(rawPatch = {}, ruleToc = {}) {
  return {
    id: BASE,
    name: '测试源',
    url: BASE,
    group: '',
    type: 0,
    enabled: true,
    health: 0,
    lastCheckAt: 0,
    lastError: '',
    createdAt: 0,
    raw: {
      searchUrl: '/search-{{key}}.html?p={{page}}',
      ruleSearch: {
        bookList: '.list li',
        name: 'a@text',
        author: 'span@text',
        bookUrl: 'a@href',
        coverUrl: 'img@src',
      },
      ruleBookInfo: {
        name: '.name@text',
        author: '.author@text',
        coverUrl: '.cover@src',
        tocUrl: '',
      },
      ruleToc: {
        chapterList: '.toc li a',
        chapterName: 'textNodes',
        chapterUrl: 'href',
        ...ruleToc,
      },
      ruleContent: { content: '.article@html' },
      ...rawPatch,
    },
  }
}

function ctxFor(source, pages) {
  let fetched = 0
  return {
    source,
    vars: {},
    get fetched() { return fetched },
    async doc(url) {
      fetched++
      const html = pages.get(url)
      if (html == null) throw new Error(`unexpected url: ${url}`)
      return new win.DOMParser().parseFromString(html, 'text/html')
    },
  }
}

/* ---------- fillTemplate ---------- */
{
  eq(
    'key 编码、page 不编码',
    fillTemplate('/search-{{key}}.html?p={{page}}', { key: '水车简史', page: '2' }, BASE),
    `${BASE}/search-%E6%B0%B4%E8%BD%A6%E7%AE%80%E5%8F%B2.html?p=2`,
  )
}

/* ---------- 搜索 ---------- */
{
  const source = makeSource()
  const url = fillTemplate(source.raw.searchUrl, { key: '水车简史', page: '1' }, BASE)
  const ctx = ctxFor(source, new Map([[url, `
    <ul class="list">
      <li><a href="/book/1.html">水车简史</a><span>范剑鸣</span><img src="/c/1.jpg"></li>
      <li><a>没有详情链接</a></li>
    </ul>
  `]]))
  const hits = await search(ctx, '水车简史')
  eq('命中数', hits.length, 1)
  eq('书名', hits[0]?.title, '水车简史')
  eq('作者', hits[0]?.author, '范剑鸣')
  eq('bookUrl 绝对地址', hits[0]?.bookUrl, `${BASE}/book/1.html`)
  eq('coverUrl 绝对地址', hits[0]?.coverUrl, `${BASE}/c/1.jpg`)
}

/* ---------- 详情 + 目录（tocUrl 为空 → 详情页即目录页） ---------- */
{
  const source = makeSource()
  const bookUrl = `${BASE}/book/1.html`
  const ctx = ctxFor(source, new Map([[bookUrl, `
    <h1 class="name">水车简史</h1>
    <span class="author">范剑鸣</span>
    <img class="cover" src="/cover.jpg">
    <ul class="toc">
      <li><a href="/ch/1.html">第1章 直播</a></li>
      <li><a href="/ch/2.html">第2章 开端</a></li>
    </ul>
  `]]))
  const { info, chapters } = await loadBook(ctx, bookUrl)
  eq('tocUrl 回落到详情页', info.tocUrl, bookUrl)
  eq('书名', info.title, '水车简史')
  eq('作者', info.author, '范剑鸣')
  eq('封面', info.coverUrl, `${BASE}/cover.jpg`)
  eq('章数', chapters.length, 2)
  eq('首章标题', chapters[0].title, '第1章 直播')
  eq('首章地址', chapters[0].url, `${BASE}/ch/1.html`)
}

/* ---------- 目录翻页 ---------- */
{
  const source = makeSource({}, { nextTocUrl: 'a.next@href' })
  const bookUrl = `${BASE}/book/9.html`
  const toc2 = `${BASE}/toc2.html`
  const ctx = ctxFor(source, new Map([
    [bookUrl, `
      <h1 class="name">分卷书</h1>
      <ul class="toc"><li><a href="/ch/1.html">第1章</a></li></ul>
      <a class="next" href="/toc2.html">下一页</a>
    `],
    [toc2, `<ul class="toc"><li><a href="/ch/2.html">第2章</a></li></ul>`],
  ]))
  const { chapters } = await loadBook(ctx, bookUrl)
  eq('追目录翻页后章数', chapters.length, 2)
  eq('末章来自第二页', chapters[1].url, `${BASE}/ch/2.html`)
}

/* ---------- 正文 ---------- */
{
  const chapterUrl = `${BASE}/ch/1.html`
  const ctx = ctxFor(makeSource(), new Map([[chapterUrl, `
    <div class="article">
      <p>第一段</p><p>第二段</p>
      <script>alert(1)</script>
      <img src="/img/a.png" onerror="steal()">
    </div>
  `]]))
  const body = await loadChapter(ctx, { title: '第1章', url: chapterUrl })
  check('正文保留段落', body.html.includes('<p>第一段</p>'), body.html)
  check('脚本被移除', !body.html.includes('<script'), body.html)
  check('事件属性被移除', !body.html.includes('onerror'), body.html)
  check('相对图片补全', body.html.includes(`${BASE}/img/a.png`), body.html)
  check('纯文本含正文', body.text.includes('第一段'), body.text)
}

/* ---------- 正文分页 ---------- */
{
  const page1 = `${BASE}/ch/p1.html`
  const page2 = `${BASE}/ch/p2.html`
  const source = makeSource({ ruleContent: { content: '.article@html', nextContentUrl: 'a.next@href' } })
  const ctx = ctxFor(source, new Map([
    [page1, `<div class="article"><p>上半段</p></div><a class="next" href="/ch/p2.html">下一页</a>`],
    [page2, `<div class="article"><p>下半段</p></div>`],
  ]))
  const body = await loadChapter(ctx, { title: '第1章', url: page1 })
  check('两页正文都拼进来', body.text.includes('上半段') && body.text.includes('下半段'), body.text)
  eq('抓取次数', ctx.fetched, 2)
}

/* ---------- 环形 nextContentUrl ---------- */
{
  const page1 = `${BASE}/ch/a.html`
  const page2 = `${BASE}/ch/b.html`
  const source = makeSource({ ruleContent: { content: '.article@html', nextContentUrl: 'a.next@href' } })
  const ctx = ctxFor(source, new Map([
    [page1, `<div class="article"><p>甲</p></div><a class="next" href="/ch/b.html">下一页</a>`],
    [page2, `<div class="article"><p>乙</p></div><a class="next" href="/ch/a.html">下一页</a>`],
  ]))
  const body = await loadChapter(ctx, { title: '第1章', url: page1 })
  check('防环：两页后停下', body.text.includes('甲') && body.text.includes('乙'), body.text)
  eq('防环：只抓两页', ctx.fetched, 2)
}

/* ---------- 错误码 ---------- */
{
  const source = makeSource({ ruleToc: {} })
  let code = ''
  try {
    await loadBook(ctxFor(source, new Map()), `${BASE}/book/1.html`)
  } catch (e) {
    code = e instanceof SourceError ? e.code : String(e)
  }
  eq('缺少目录规则 → RULE_EMPTY', code, 'RULE_EMPTY')
}

{
  const chapterUrl = `${BASE}/ch/empty.html`
  const source = makeSource({ ruleContent: { content: '.missing@html' } })
  const ctx = ctxFor(source, new Map([[chapterUrl, `<div class="article">没有正文规则命中的内容</div>`]]))
  let code = ''
  try {
    await loadChapter(ctx, { title: '第1章', url: chapterUrl })
  } catch (e) {
    code = e instanceof SourceError ? e.code : String(e)
  }
  eq('正文取空 → CONTENT_EMPTY', code, 'CONTENT_EMPTY')
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
