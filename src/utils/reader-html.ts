/**
 * 正文排版瘦身：把源文件里用「空段落 / 连续换行」凑出来的空行去掉。
 *
 * 采集站和不少 epub 转换工具用 `<p>&nbsp;</p>`、`<p><br/></p>`、段末两个
 * `<br>` 来表示「段落之间空一行」。阅读页的段落间距本来就是 0（靠 2em 缩进
 * 分开），这些块于是各自渲染成整行空白，看起来就是段落之间空了一两行 —— 用户
 * 说的「换行太多」。
 *
 * 空块用 `display:none`（`.reader__blank`）隐藏，而不是从 HTML 里删掉：
 * 划线和阅读进度都按正文 `textContent` 的字符偏移保存，删字符会让它们整体
 * 前移。`<br>` 本身不占字符，删掉是安全的。
 */

/** 会撑出整行空白的块级容器。 */
const BLOCK_SELECTOR =
  'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,aside,header,footer,td'

/** 块里有这些元素就说明它不是空行，只是内容不产生文字（插图、分隔线、代码块）。 */
const KEEP_CONTENT = 'img,svg,video,audio,canvas,hr,pre,code,table,figure,input,math'

export const BLANK_CLASS = 'reader__blank'

/** `\s` 已覆盖 \u3000 / \u00a0 / \ufeff；零宽字符要单独列。 */
const INVISIBLE = /[\s\u200b\u200c\u200d]/g

/**
 * 去掉正文里的空行噪声。
 *
 * 只有含 `<br>` 或 `&nbsp;` 时才走 DOM 解析：绝大多数本地 TXT 章节一个都
 * 没有，直接原样返回。
 */
export function tidyChapterHtml(html: string): string {
  if (!html || !/<br\b|&nbsp;|&#160;/i.test(html)) return html
  if (typeof DOMParser === 'undefined') return html

  const doc = new DOMParser().parseFromString(`<div id="wr-tidy">${html}</div>`, 'text/html')
  const root = doc.getElementById('wr-tidy')
  if (!root) return html

  for (const el of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
    if (el.closest('pre')) continue
    if (el.querySelector(KEEP_CONTENT)) continue
    if (el.textContent?.replace(INVISIBLE, '')) continue
    el.classList.add(BLANK_CLASS)
  }

  for (const block of [root, ...Array.from(root.querySelectorAll(BLOCK_SELECTOR))]) {
    if (block.closest('pre')) continue
    dropEdgeBreaks(block, 'start')
    dropEdgeBreaks(block, 'end')
    collapseBreaks(block)
  }

  return root.innerHTML
}

/**
 * 块首/块尾的 `<br>` 不换出任何可见的行，只会白白多占一行位置。
 */
function dropEdgeBreaks(block: Element, where: 'start' | 'end'): void {
  const kids = Array.from(block.childNodes)
  for (const node of where === 'start' ? kids : kids.reverse()) {
    if (node.nodeType === 3) {
      if (!(node as Text).data.trim()) continue
      break
    }
    if (node.nodeType === 1 && (node as Element).tagName === 'BR') {
      node.parentNode?.removeChild(node)
      continue
    }
    break
  }
}

/** 连续多个 `<br>` 只保留一个：两行换行就是一行空白，用户要的是一个。 */
function collapseBreaks(block: Element): void {
  let prevBreak = false
  for (const node of Array.from(block.childNodes)) {
    if (node.nodeType === 3) {
      if ((node as Text).data.trim()) prevBreak = false
      continue
    }
    if (node.nodeType !== 1) continue
    if ((node as Element).tagName === 'BR') {
      if (prevBreak) node.parentNode?.removeChild(node)
      prevBreak = true
    } else {
      prevBreak = false
    }
  }
}
