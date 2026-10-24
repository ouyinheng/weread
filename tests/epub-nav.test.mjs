// EPUB3 ships a nav document instead of (or alongside) NCX. Books that only
// carry nav used to get "Chapter 1 / Chapter 2" for every chapter.
import JSZip from 'jszip'
import { parseEpub } from '../src/utils/parser.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip')
zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>导航测试</dc:title><dc:creator>作者</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`)
zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="landmarks"><ol><li><a href="text/ch1.xhtml">无关的导航</a></li></ol></nav>
  <nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">第一章 开端</a></li>
    <li><a href="text/ch2.xhtml#part2">第二章 转折</a></li>
  </ol></nav>
</body></html>`)
zip.file('OEBPS/text/ch1.xhtml', '<html><body><p>第一章正文</p></body></html>')
zip.file('OEBPS/text/ch2.xhtml', '<html><body><p>第二章正文</p></body></html>')

const bytes = await zip.generateAsync({ type: 'arraybuffer' })
const book = await parseEpub(bytes, 'nav-only.epub')

check('both chapters parsed', book.chapters.length === 2, String(book.chapters.length))
check('first title comes from nav', book.chapters[0]?.title === '第一章 开端', book.chapters[0]?.title)
check('fragment anchor still matches its chapter', book.chapters[1]?.title === '第二章 转折', book.chapters[1]?.title)
check('landmarks nav is not mistaken for the toc', !book.chapters.some(c => c.title === '无关的导航'))

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail ? 1 : 0)
