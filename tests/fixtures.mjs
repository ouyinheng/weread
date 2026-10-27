/**
 * 测试样本（合成，不依赖仓库外的文件）。
 *
 * 以前这几个用例读的是本机 `docs/evidence/` 下的真书：一份 22MB 的 TXT 和一份
 * 6MB 的 EPUB。`docs/` 在 .gitignore 里，所以 macOS 上跑得通、CI 上直接
 * `readFileSync` 抛 ENOENT——`npm test` 在 GitHub Actions 里红了一次。
 *
 * 现在改成按需生成：同样的规模（上千章、上百万字）和同样的结构（EPUB3 +
 * 封面 + 章内嵌图），但不带任何二进制进仓库，两边跑的是同一份数据。
 */
import JSZip from 'jszip'

/** 1×1 的 JPEG，用来测「图片必须内联成 data URL」这条断言。 */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

/**
 * 合成一本「上千章、上百万字」的 TXT。
 *
 * 规模是刻意留的：`import.test.mjs` 断言的就是「上千章仍然解析得动、批量写库
 * 不超过 5 秒」，拿一本小书测不出这个问题。
 */
export function makeTxtBuffer({ chapters = 1500, paragraphs = 6, charsPerParagraph = 145 } = {}) {
  const parts = []
  for (let c = 1; c <= chapters; c++) {
    parts.push(`第${c}章 测试章节${c}`)
    parts.push('')
    for (let p = 0; p < paragraphs; p++) {
      // 用不同长度的重复文本拼段落，避免被当成重复章节合并
      const seed = `第${c}章第${p}段。`
      const body = (seed + '他抬头看了看天，风里带着一点土腥味。').repeat(
        Math.ceil(charsPerParagraph / (seed.length + 20))
      )
      parts.push(body.slice(0, charsPerParagraph))
      parts.push('')
    }
  }
  const bytes = new TextEncoder().encode(parts.join('\n'))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/**
 * 合成一本 EPUB3。
 *
 * 断言里写死的书名/作者来自原来那本真书（The story of Little Black Quibba /
 * Helen Bannerman），这里保持不变，剩下的用例就不用改。
 */
export async function makeEpubBuffer() {
  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  )

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-fixture</dc:identifier>
    <dc:title>The story of Little Black Quibba</dc:title>
    <dc:creator>Helen Bannerman</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>
    <item id="pic" href="pic.jpg" media-type="image/jpeg"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
  )

  const chapter = (title, body, img = '') =>
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title>
<link href="style.css" rel="stylesheet"/><meta charset="utf-8"/></head>
<body><h1>${title}</h1>${img}<p>${body}</p><p>Second paragraph of ${title}.</p></body></html>`

  zip.file('OEBPS/ch1.xhtml', chapter('Chapter One', 'Quibba went out to find her father.'))
  zip.file(
    'OEBPS/ch2.xhtml',
    chapter(
      'Chapter Two',
      'The little black Quibba met a very large elephant on the road.',
      '<img src="pic.jpg" alt="elephant"/>'
    )
  )
  zip.file('OEBPS/cover.jpg', TINY_JPEG_BASE64, { base64: true })
  zip.file('OEBPS/pic.jpg', TINY_JPEG_BASE64, { base64: true })

  return await zip.generateAsync({ type: 'arraybuffer' })
}
