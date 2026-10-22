import { parseEpub } from '../src/utils/parser.ts'
import { readFileSync } from 'fs'

let fail = 0
const check = (n, cond, extra='') => { console.log(cond?'ok  ':'FAIL', n, cond?'':extra); if(!cond) fail++ }

const path = '/Users/ouyinheng/Documents/GitHub/weread/docs/evidence/epub/pg79784-images-3.epub'
const buf = readFileSync(path)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

const book = await parseEpub(ab, 'little-black-quibba.epub')
console.log('title:', book.title)
console.log('author:', book.author)
console.log('chapters:', book.chapters.length)
console.log('words:', book.totalWords)
console.log('cover:', book.cover ? 'yes' : 'no')

check('title parsed', !!book.title && book.title !== 'little-black-quibba', book.title)
check('author parsed', !!book.author, book.author)
check('chapters > 0', book.chapters.length > 0, String(book.chapters.length))
check('words > 0', book.totalWords > 0, String(book.totalWords))
check('chapter has html', book.chapters[0]?.html?.length > 0)
check('chapter has text', book.chapters[0]?.text?.length > 0)
check('no script tags', !book.chapters.some(c => /<script/i.test(c.html)))


// --- XHTML body extraction regressions ---
const { extractBodyHtml } = await import('../src/utils/parser.ts')

const doc = `<?xml version="1.0"?><!DOCTYPE html><html><head><title>"Cover"</title>
<link href="pgepub.css" rel="stylesheet"/><meta charset="utf-8"/></head>
<body class="x"><div><p>Hello <em>world</em></p></div></body></html>`
const body = extractBodyHtml(doc)
check('drops xml prolog', !body.includes('<?xml'), body.slice(0, 80))
check('drops doctype', !/doctype/i.test(body), body.slice(0, 80))
check('drops <title>', !/<title/i.test(body), body.slice(0, 120))
check('drops <link>', !/<link/i.test(body), body.slice(0, 120))
check('drops <meta>', !/<meta/i.test(body), body.slice(0, 120))
check('keeps body content', body.includes('Hello') && body.includes('<em>world</em>'), body)
check('no literal "Cover" title text leaks', !body.includes('"Cover"'), body)

const withSvg = extractBodyHtml('<html><body><div><svg viewBox="0 0 1 1"><image href="c.jpg"/></svg></div><p>text</p></body></html>')
check('drops inline svg', !/<svg/i.test(withSvg) && !/image href/.test(withSvg), withSvg)
check('keeps text after svg', withSvg.includes('<p>text</p>'), withSvg)

const unsafe = extractBodyHtml('<body><p onclick="alert(1)" style="margin-left:1em">x</p><script>evil()</script><iframe src="x"></iframe></body>')
check('strips event handlers', !/onclick/i.test(unsafe), unsafe)
check('strips script body', !/evil\(\)/.test(unsafe), unsafe)
check('strips iframe', !/<iframe/i.test(unsafe), unsafe)
// Structural spacing is allowed; colour is not (the reader owns typography).
check('keeps safe inline style', /style="margin-left:1em"/.test(unsafe), unsafe)
check('drops unsafe colour style', !/color/.test(unsafe), unsafe)

const imgs = extractBodyHtml('<body><p>a</p><img src="pic.png" alt="图" onerror="hack()"/><img/></body>')
check('keeps img with src+alt', imgs.includes('src="pic.png"') && imgs.includes('alt="图"'), imgs)
check('drops img without src', (imgs.match(/<img/g) || []).length === 1, imgs)
check('strips img onerror', !/onerror/i.test(imgs), imgs)

const plain = extractBodyHtml('<body>line one\nline two\nline three</body>')
check('wraps plain text lines in <p>', (plain.match(/<p>/g) || []).length === 3, plain)

const nested = extractBodyHtml('<body><custom-tag>keep me</custom-tag><p>para</p></body>')
check('unwraps unknown tags but keeps text', nested.includes('keep me') && !/<custom-tag/.test(nested), nested)

const entities = extractBodyHtml('<body><p>a &amp; b &lt; c</p></body>')
check('preserves entities', entities.includes('&amp;') && entities.includes('&lt;'), entities)



// --- EPUB images must be inlined, not left as zip-relative src ---
const inlineImgs = book.chapters.flatMap(c => [...c.html.matchAll(/<img[^>]*src="([^"]*)"/g)].map(m => m[1]))
check('epub has images', inlineImgs.length > 0, inlineImgs.length)
check('all images are data URLs', inlineImgs.every(s => s.startsWith('data:image/')),
  inlineImgs.filter(s => !s.startsWith('data:image/')).slice(0, 3))
check('no zip-relative image paths', !inlineImgs.some(s => /^\.{0,2}\//.test(s) || s.startsWith('http')),
  inlineImgs.filter(s => /^\.{0,2}\//.test(s)).slice(0, 3))

// resolveSrc hook: unresolvable paths are dropped rather than rendered broken
const dropped = extractBodyHtml('<body><p>a</p><img src="missing.png"/></body>', () => null)
check('unresolvable image dropped', !/<img/.test(dropped), dropped)
const kept = extractBodyHtml('<body><p>a</p><img src="x.png"/></body>', () => 'data:image/png;base64,AAA')
check('resolved image kept', kept.includes('src="data:image/png;base64,AAA"'), kept)

// --- reader owns typography: publisher styling must not leak through ---
const centred = extractBodyHtml('<body><p style="text-align:center">x</p></body>')
check('strips text-align from book', !/text-align/i.test(centred), centred)
const coloured = extractBodyHtml('<body><p style="color:red;font-size:3em;line-height:4">x</p></body>')
check('strips colour/font/line-height', !/color|font-size|line-height/i.test(coloured), coloured)
const spacing = extractBodyHtml('<body><p style="margin-top:1em">x</p></body>')
check('keeps harmless spacing', /margin-top/.test(spacing), spacing)
const bg = extractBodyHtml('<body><p style="background:#fff">x</p></body>')
check('strips background', !/background/i.test(bg), bg)

