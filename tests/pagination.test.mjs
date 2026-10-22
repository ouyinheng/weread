// Mirror of the guarded pagination logic in ReaderView.
function pagesOf(scrollW, boxW) {
  if (!boxW || !isFinite(boxW) || boxW <= 0 || !scrollW || !isFinite(scrollW)) return 1
  return Math.max(1, Math.round(scrollW / boxW))
}
function goPage(page, pages) {
  return Math.max(0, Math.min(pages - 1, page))
}
let fail = 0
const eq = (n, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  console.log(ok ? 'ok  ' : 'FAIL', n, JSON.stringify(a), ok ? '' : `want ${JSON.stringify(b)}`)
  if (!ok) fail++
}
eq('exact fit', pagesOf(350, 350), 1)
eq('3 pages', pagesOf(1050, 350), 3)
eq('round down', pagesOf(840, 350), 2)
eq('round up', pagesOf(910, 350), 3)
eq('zero box', pagesOf(500, 0), 1)
eq('NaN box', pagesOf(500, NaN), 1)
eq('zero scroll', pagesOf(0, 350), 1)
eq('NaN scroll', pagesOf(NaN, 350), 1)
eq('clamp low', goPage(-5, 10), 0)
eq('clamp high', goPage(99, 10), 9)
eq('clamp mid', goPage(4, 10), 4)
eq('single page clamp', goPage(3, 1), 0)
process.exit(fail ? 1 : 0)
