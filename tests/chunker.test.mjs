import { buildChunks, buildPlan, sentenceAt, CHUNK_CHARS, HEAD_CHUNK_CHARS } from '../src/audio/chunker.ts'
import { segmentText } from '../src/audio/segmenter.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- consecutive sentences are glued into one utterance ---------- */
{
  const list = segmentText('第一句。第二句。第三句。')
  const chunks = buildChunks(list)
  check('short chapter is one chunk', chunks.length === 1, chunks.length)
  check('chunk holds every sentence', chunks[0].from === 0 && chunks[0].to === 2,
    JSON.stringify(chunks[0]))
  check('text keeps the sentences in order',
    chunks[0].text === '第一句。\n第二句。\n第三句。', JSON.stringify(chunks[0].text))
  check('sentence offsets are exact',
    JSON.stringify(chunks[0].starts) === JSON.stringify([0, 5, 10]),
    JSON.stringify(chunks[0].starts))
}

/* ---------- chunks stay under the limit and never cut a sentence ---------- */
{
  const para = '这是一句用来凑字数的话。'
  const list = segmentText(para.repeat(12))
  const chunks = buildChunks(list)
  let covered = 0
  for (const c of chunks) {
    covered += c.to - c.from + 1
    check(`chunk ${c.from}-${c.to} under the ceiling`,
      c.text.length <= CHUNK_CHARS + 24, c.text.length)
  }
  check('every sentence lands in exactly one chunk', covered === list.length, covered)
  check('more than one chunk for a long chapter', chunks.length > 1, chunks.length)
  check('chunks are contiguous',
    chunks.every((c, i) => i === 0 || c.from === chunks[i - 1].to + 1), '')
}

/* ---------- a single over-long sentence gets a chunk of its own ---------- */
{
  const list = segmentText('没有任何标点的一大段文字'.repeat(14))
  const chunks = buildChunks(list, 0, 40)
  check('one sentence, one chunk', chunks.length === list.length, chunks.length)
  check('the long sentence is not split', chunks[0].text === list[0].text, '')
}

/* ---------- the plan starts with a short head ---------- */
{
  const list = segmentText('这一句很短。'.repeat(30))
  const plan = buildPlan(list)
  const bare = (c) => c.text.replace(/\n/g, '')
  check('head is short so the first word starts fast',
    bare(plan[0]).length <= HEAD_CHUNK_CHARS, bare(plan[0]).length)
  check('head still holds whole sentences', plan[0].starts.length >= 1 && plan[0].from === 0, '')
  check('the rest of the chapter follows the head',
    plan.slice(1).every(c => bare(c).length <= CHUNK_CHARS), '')
  check('plan covers every sentence exactly once',
    plan.reduce((n, c) => n + (c.to - c.from + 1), 0) === list.length, plan.length)
  check('plan is contiguous',
    plan.every((c, i) => i === 0 || c.from === plan[i - 1].to + 1), '')
  check('plan respects the starting sentence', buildPlan(list, 7)[0].from === 7,
    buildPlan(list, 7)[0].from)
}

/* ---------- starting mid-chapter (seek / resume) ---------- */
{
  const list = segmentText('第一句。第二句。第三句。第四句。')
  const chunks = buildChunks(list, 2)
  check('starts at the requested sentence', chunks[0].from === 2, chunks[0].from)
  check('covers the rest', chunks.at(-1).to === 3, chunks.at(-1).to)
}

/* ---------- range → sentence mapping ---------- */
{
  const list = segmentText('第一句。第二句。第三句。')
  const chunk = buildChunks(list)[0]
  check('offset 0 is the first sentence', sentenceAt(chunk, 0) === 0, sentenceAt(chunk, 0))
  check('offset inside the first sentence', sentenceAt(chunk, 3) === 0, sentenceAt(chunk, 3))
  check('offset on the join still belongs to the sentence that just ended',
    sentenceAt(chunk, 4) === 0, sentenceAt(chunk, 4))
  check('offset 5 is the next sentence', sentenceAt(chunk, 5) === 1, sentenceAt(chunk, 5))
  check('offset inside the last sentence', sentenceAt(chunk, chunk.text.length - 1) === 2,
    sentenceAt(chunk, chunk.text.length - 1))
  check('out-of-range offset clamps to the last sentence', sentenceAt(chunk, 9999) === 2, '')
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
