/**
 * 规则解释器单测。
 *
 * 覆盖方案 §7 的四类语法和三个实测踩过的坑：
 *  - `a.0` 是索引而不是 class（没剥离时 querySelectorAll 静默返回空）
 *  - `chapterUrl: "href"` 是裸属性名，作用于元素自身
 *  - `@` 可以串联（`.w_pic@img@src`）
 */
import { Window } from 'happy-dom'
import {
  absUrl,
  extract,
  extractAll,
  query,
  stripIndex,
} from '../src/utils/source/selector.ts'

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
const BASE = 'https://www.wtzw.com'

const doc = win.document
doc.body.innerHTML = `
  <ul class="w_picTxt_lr">
    <li data-id="one">
      <a class="cover" href="/book/1.html"><img src="/cover/1.jpg"></a>
      <a class="name" href="/book/1.html">水车简史</a>
      <span class="author">范剑鸣<span class="tag">（著）</span></span>
      <span>连载</span>
      <span>第52章 后记</span>
      <span class="lastChapter">第52章 后记</span>
      <span>12万字</span>
      <span class="kind">历史</span>
      <span class="intro">一部关于水车的简史</span>
    </li>
    <li data-id="two">
      <a class="name" href="/book/2.html">第二本</a>
      <span class="author">另一位</span>
    </li>
  </ul>
  <div class="box"><p>p0</p><p>p1</p><p>p2</p><p>p3</p></div>
  <span class="n">s0</span><span class="n">s1</span><span class="n">s2</span><span class="n">s3</span><span class="n">s4</span>
  <div class="pick"><em>a</em></div><div class="pick"><em>b</em></div>
  <div class="article"><p>第一段<br>换行</p><p>第二段</p></div>
`
const firstItem = doc.querySelector('.w_picTxt_lr li')

/* ---------- 索引剥离 ---------- */
{
  eq('stripIndex a.0', stripIndex('a.0'), { css: 'a', ranges: [[0, 0]] })
  eq('stripIndex span.4:2', stripIndex('span.4:2'), { css: 'span', ranges: [[4, 2]] })
  eq('stripIndex p[2,3]', stripIndex('p[2,3]'), { css: 'p', ranges: [[2, 3]] })
  eq('stripIndex 保留普通 class', stripIndex('.w_picTxt_lr li'), { css: '.w_picTxt_lr li', ranges: [] })
  eq('stripIndex 保留数字 class', stripIndex('.col-2'), { css: '.col-2', ranges: [] })
  eq('stripIndex 段式', stripIndex('div.x > p.1'), { css: 'div.x > p', ranges: [[1, 1]] })
}

/* ---------- 查询 ---------- */
{
  eq('纯 CSS 列表', query(doc, '.w_picTxt_lr li').length, 2)
  eq('子代选择器', query(doc, '.w_picTxt_lr > li').length, 2)
  eq('索引 a.0 取第一本', extract(firstItem, 'a.name.0@href', BASE), `${BASE}/book/1.html`)
  eq('索引 a.1 取第二本', extract(firstItem, 'a.1@text'), '水车简史')
  eq('索引范围 p[2,3]', query(doc, 'p[2,3]').length, 2)
  eq('索引 span.4:2 升序切片', query(doc, 'span.n.4:2').length, 3)
  eq('非法选择器返回空', query(doc, 'div[').length, 0)
  eq('空规则返回空数组', query(doc, '').length, 0)
}

/* ---------- 取法 ---------- */
{
  eq('@text', extract(firstItem, '.author@text'), '范剑鸣（著）')
  eq('@textNodes 只取直接子节点', extract(firstItem, '.author@textNodes'), '范剑鸣')
  eq('@html 保留标签', extract(doc.querySelector('.article'), 'p.0@html'), '第一段<br>换行')
  eq('@href 相对地址补全', extract(firstItem, '.name@href', BASE), `${BASE}/book/1.html`)
  eq('裸属性名 href', extract(firstItem.querySelector('.name'), 'href', BASE), `${BASE}/book/1.html`)
  eq('裸属性名 textNodes', extract(firstItem.querySelector('.author'), 'textNodes'), '范剑鸣')
  eq('串联 @img@src', extract(firstItem, 'a.cover@img@src', BASE), `${BASE}/cover/1.jpg`)
  {
    const chained = extract(firstItem, 'a.cover@img@src##/cover/', BASE)
    check('串联 @ 后应用净化', chained.includes('1.jpg') && !chained.includes('/cover/'), chained)
  }
}

/* ---------- 组合语法 ---------- */
{
  eq('a||b 取第一个非空', extract(firstItem, '.missing@text||.kind@text'), '历史')
  eq('a&&b 拼接', extract(firstItem, '.author@textNodes&&.kind@text'), '范剑鸣历史')
  eq('## 正则删除', extract(firstItem, '.kind@text##历'), '史')
  eq('## 替换支持 $1', extract(firstItem, '.kind@text##(历)(史)##$2$1'), '史历')
  const clean = extract(firstItem, '.lastChapter@text##\\s..:.*')
  eq('## 删除后缀', clean, '第52章 后记')
}

/* ---------- 列表规则 ---------- */
{
  eq('extractAll 列表', extractAll(doc, '.w_picTxt_lr li').length, 2)
  eq('extractAll 或分支', extractAll(doc, '.nope||.pick').length, 2)
  eq('extractAll 空规则', extractAll(doc, undefined).length, 0)
}

/* ---------- 边界 ---------- */
{
  eq('undefined 规则', extract(doc, undefined), '')
  eq('空字符串规则', extract(doc, ''), '')
  eq('JS 规则跳过', extract(firstItem, '@js:result', BASE), '')
  eq('{{}} 模板跳过', extract(firstItem, '{{@.kind@text}}'), '')
  eq('absUrl 已是绝对地址', absUrl('https://x.test/a', BASE), 'https://x.test/a')
  eq('absUrl 协议相对地址', absUrl('//x.test/a', BASE), 'https://x.test/a')
}

/* ---------- XPath（浏览器有 evaluate；happy-dom 没有时跳过） ---------- */
{
  const hasXPath = typeof doc.evaluate === 'function'
  if (hasXPath) {
    eq('XPath //li', query(doc, '//li').length, 2)
    eq('XPath 属性条件', query(doc, '//li[@data-id="two"]').length, 1)
  } else {
    console.log('skip XPath：当前环境没有 document.evaluate')
  }
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
