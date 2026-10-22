/**
 * legado 规则解释器（P0/P1 子集）。
 *
 * 一条规则是 `选择器@取法##正则##替换`：
 *  - 选择器：CSS / XPath(//...)，可带 legado 索引后缀 `.N` / `.N:M` / `[N,M]`
 *  - 取法：text / textNodes / html / href / src / 任意属性名；裸属性名作用于元素自身
 *  - 组合：`a||b` 取第一个非空；`a&&b` 结果拼接；`##` 净化
 *
 * 实测过的三个坑都在这里兜住：
 *  1. `a.0` 的 `.0` 是索引，不是 class（不剥离时 querySelectorAll 静默返回空）
 *  2. `chapterUrl: "href"` 是裸属性名，不能当标签去查
 *  3. `@` 可以串联（`.w_pic@img@src`），不能只按最后一个 @ 切
 */
const IDX_RE = /(?<=[A-Za-z0-9_*\]\)])\.(\d+)(?::(\d+))?(?=[\s>+~]|$)/g
const RANGE_RE = /\[(\d+(?:\s*,\s*\d+)+)\]/g
const BARE_ATTR = /^[A-Za-z][A-Za-z0-9_]*$/

export interface StrippedSelector {
  css: string
  ranges: [number, number][]
}

const DOCUMENT_NODE = 9

export function stripIndex(sel: string): StrippedSelector {
  const ranges: [number, number][] = []
  let css = sel.replace(IDX_RE, (_m, a: string, b?: string) => {
    ranges.push([Number(a), b ? Number(b) : Number(a)])
    return ''
  })
  css = css.replace(RANGE_RE, (_m, nums: string) => {
    const n = nums.split(',').map(Number)
    ranges.push([n[0], n[n.length - 1]])
    return ''
  })
  return { css: css.trim(), ranges }
}

/** 按索引后缀逐层收敛（索引作用在当次查询结果上，升序切片）。 */
function pick(elems: Element[], ranges: [number, number][]): Element[] {
  let out = elems
  for (const [a, b] of ranges) {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    out = out.slice(lo, hi + 1)
  }
  return out
}

function ownerDoc(scope: ParentNode): Document | null {
  if ((scope as Node).nodeType === DOCUMENT_NODE) return scope as Document
  return (scope as Node).ownerDocument
}

function xpath(expr: string, scope: ParentNode): Element[] {
  const doc = ownerDoc(scope)
  if (!doc || typeof doc.evaluate !== 'function') return []
  try {
    const root = (scope as Node).nodeType === DOCUMENT_NODE ? doc : (scope as Node)
    // ORDERED_NODE_SNAPSHOT_TYPE = 7；写常量，免得依赖 XPathResult 全局。
    const r = doc.evaluate(expr, root, null, 7, null)
    const out: Element[] = []
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i)
      if (n && (n as Node).nodeType === 1) out.push(n as Element)
    }
    return out
  } catch {
    return []
  }
}

/** 在 scope 上查一段选择器（CSS / XPath），并应用 legado 索引后缀。 */
export function query(scope: ParentNode, sel: string): Element[] {
  const { css, ranges } = stripIndex(sel)
  if (!css) return []

  let out: Element[]
  if (css.startsWith('//') || css.startsWith('(//')) {
    out = xpath(css, scope)
  } else {
    try {
      out = Array.from(scope.querySelectorAll(css))
    } catch {
      // 非法选择器不抛到调用方：一条坏规则只让这一条取不到值。
      return []
    }
  }
  return pick(out, ranges)
}

/**
 * `div.a > p.1` 这类串联：`@` 分隔的每一段依次向内查询。
 *
 * 单段就是普通查询；`.w_pic@img` 先取 `.w_pic`，再在其内部取 `img`。
 */
function selectChain(scope: ParentNode, chain: string): Element[] {
  const segs = chain.split('@').map(s => s.trim()).filter(Boolean)
  if (!segs.length) return []
  let out: Element[] = []
  let current: ParentNode[] = [scope]
  for (const seg of segs) {
    out = []
    for (const c of current) out.push(...query(c, seg))
    if (!out.length) return []
    current = out
  }
  return out
}

/** 取法：把元素的某个面向取成字符串。 */
export function take(el: Element | null | undefined, attr = 'text', clean = ''): string {
  if (!el) return ''
  const a = (attr || 'text').toLowerCase()

  let v: string
  switch (a) {
    case 'text':
    case '':
      v = (el.textContent || '').replace(/\s+/g, ' ').trim()
      break
    case 'textnodes': {
      // 只取直接文本节点，不含后代元素的文字 —— 章名 / 作者常靠这个避开嵌套标签。
      v = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent || '')
        .join('')
        .trim()
      break
    }
    case 'html':
      v = el.innerHTML
      break
    case 'owntext':
      v = ((el as HTMLElement).innerText || el.textContent || '').trim()
      break
    default:
      v = (el.getAttribute(attr) || '').trim()
      // 懒加载图片：src 为空时退到 data-src；href 常见退到 data-href。
      if (!v && a === 'src') v = el.getAttribute('data-src') || ''
      if (!v && a === 'href') v = el.getAttribute('data-href') || ''
      break
  }

  return clean ? applyClean(v, clean) : v
}

/** `##正则` 删除；`##正则##替换` 替换（replacement 支持 $1）。 */
function applyClean(value: string, rule: string): string {
  const idx = rule.indexOf('##')
  try {
    if (idx >= 0) {
      const pat = rule.slice(0, idx)
      const rep = rule.slice(idx + 2)
      if (!pat) return value
      return value.replace(new RegExp(pat, 'gs'), rep)
    }
    if (!rule) return value
    return value.replace(new RegExp(rule, 'gs'), '')
  } catch {
    return value
  }
}

/** 相对地址补全；只对链接类取法生效。 */
function absValue(value: string, attr: string, base?: string): string {
  const a = (attr || '').toLowerCase()
  if (!base || (a !== 'href' && a !== 'src')) return value
  if (!value || /^(https?:|data:)/i.test(value)) return value
  try {
    return new URL(value, base).toString()
  } catch {
    return value
  }
}

export function absUrl(value: string, base?: string): string {
  return absValue(value, 'href', base)
}

function extractOne(scope: Element | Document, part: string, base?: string): string {
  const bare = !part.includes('@') && BARE_ATTR.test(part)
  if (bare) {
    // legado 约定：`chapterUrl: "href"` / `"textNodes"` 作用在 scope 自身。
    if (typeof (scope as Element).getAttribute !== 'function') return ''
    const v = take(scope as Element, part)
    return v ? absValue(v, part, base) : ''
  }

  const at = part.lastIndexOf('@')
  const sel = at >= 0 ? part.slice(0, at) : part
  const attr = at >= 0 ? (part.slice(at + 1) || 'text') : 'text'
  const els = sel ? selectChain(scope, sel) : [scope as Element]
  if (!els.length) return ''

  const v = take(els[0], attr)
  return v ? absValue(v, attr, base) : ''
}

/**
 * 执行一条完整规则，返回单个字符串（列表规则用 `extractAll`）。
 *
 * `a||b` 取第一个非空分支；同一分支里的 `a&&b` 结果拼接；`##` 净化作用于
 * 整个分支的结果。
 */
export function extract(scope: Element | Document, rule: string | undefined, base?: string): string {
  if (!rule) return ''

  for (const alt of String(rule).split('||')) {
    const r0 = alt.trim()
    if (!r0) continue
    // P0/P1 不支持 JS 规则与 {{}} 模板：跳过这一分支，不影响其它分支。
    if (r0.startsWith('@js:') || r0.startsWith('<js>') || r0.includes('{{')) continue

    const ci = r0.indexOf('##')
    const body = ci >= 0 ? r0.slice(0, ci) : r0
    const clean = ci >= 0 ? r0.slice(ci + 2) : ''

    const values: string[] = []
    for (const raw of body.split('&&')) {
      const part = raw.trim()
      if (!part) continue
      const v = extractOne(scope, part, base)
      if (v) values.push(v)
    }
    if (!values.length) continue

    const joined = values.join('')
    return clean ? applyClean(joined, clean) : joined
  }
  return ''
}

/** 列表规则（bookList / chapterList）：返回命中的元素，而不是字符串。 */
export function extractAll(scope: Element | Document, rule: string | undefined): Element[] {
  if (!rule) return []

  for (const alt of String(rule).split('||')) {
    let r = alt.trim()
    const ci = r.indexOf('##')
    if (ci >= 0) r = r.slice(0, ci)
    if (!r || r.startsWith('@js:') || r.startsWith('<js>') || r.includes('{{')) continue
    const els = selectChain(scope, r)
    if (els.length) return els
  }
  return []
}
