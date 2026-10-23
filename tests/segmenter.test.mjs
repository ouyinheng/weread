import { segmentText, toCharOffset, DEFAULT_MAX_LEN } from '../src/audio/segmenter.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/* ---------- basic splitting ---------- */
{
  const text = '第一句。第二句！第三句？'
  const s = segmentText(text)
  check('splits on 。！？', s.length === 3, JSON.stringify(s.map(x => x.text)))
  check('sentence 1 text', s[0].text === '第一句。', s[0]?.text)
  check('sentence 2 text', s[1].text === '第二句！', s[1]?.text)
  check('sentence 3 text', s[2].text === '第三句？', s[2]?.text)
  // The whole point of carrying offsets: they must address the same string.
  check('offsets address source', s.every(x => text.slice(x.start, x.end) === x.text),
    JSON.stringify(s))
  check('offsets are ordered', s[0].end <= s[1].start && s[1].end <= s[2].start)
}

/* ---------- newline is a boundary (paragraphs are units) ---------- */
{
  const s = segmentText('第一段没有句号\n第二段也没有')
  check('newline splits', s.length === 2, JSON.stringify(s.map(x => x.text)))
  check('newline part 1', s[0].text === '第一段没有句号', s[0]?.text)
}

/* ---------- closing quotes stay with their sentence ---------- */
{
  const s = segmentText('他说：“走吧。”然后离开了。')
  check('closing quote attached', s[0].text === '他说：“走吧。”', s[0]?.text)
  check('next sentence starts clean', s[1].text === '然后离开了。', s[1]?.text)
}

/* ---------- ellipsis / consecutive terminators ---------- */
{
  const s = segmentText('等等……不会吧？！真的。')
  check('ellipsis run is one sentence', s[0].text === '等等……', s[0]?.text)
  check('mixed terminators stay together', s[1].text === '不会吧？！', s[1]?.text)
  check('prose after', s[2].text === '真的。', s[2]?.text)
}

/* ---------- over-long run breaks at a soft stop ---------- */
{
  const long = '甲，'.repeat(150) // 300 chars, only soft stops
  const s = segmentText(long, 100)
  check('long run is split', s.length >= 3, s.length)
  check('every piece within limit', s.every(x => x.text.length <= 100),
    JSON.stringify(s.map(x => x.text.length)))
  check('break lands after a comma', s.slice(0, -1).every(x => x.text.endsWith('，')),
    JSON.stringify(s.map(x => x.text.slice(-1))))
}

/* ---------- no punctuation at all: hard cut ---------- */
{
  const run = '汉'.repeat(500)
  const s = segmentText(run, 100)
  check('unpunctuated still splits', s.length === 5, s.length)
  check('unpunctuated respects limit', s.every(x => x.text.length <= 100))
  check('unpunctuated keeps all text', s.map(x => x.text).join('') === run)
}

/* ---------- non-speech segments dropped ---------- */
{
  const s = segmentText('正文。\n\n——\n\n***\n\n又一段。')
  check('rules dropped', s.length === 2, JSON.stringify(s.map(x => x.text)))
  check('only prose survived', s.every(x => /[\p{L}]/u.test(x.text)))
}

/* ---------- edge cases ---------- */
check('empty input', segmentText('').length === 0)
check('whitespace only', segmentText('   \n\n  ').length === 0)
check('single sentence no terminator', segmentText('没有标点的一句话').length === 1)
{
  // Default ceiling: a normal chapter must not produce a 100k-char utterance.
  const chapter = '这是一个句子。'.repeat(500)
  const s = segmentText(chapter)
  check('default limit respected', s.every(x => x.text.length <= DEFAULT_MAX_LEN),
    Math.max(...s.map(x => x.text.length)))
}

/* ---------- toCharOffset: DOM text → progress coordinate ---------- */
{
  const bodyText = '第一段\n第二段\n第三段'
  // Progress counts non-whitespace characters, so two newlines before the
  // third paragraph must not shift the offset.
  check('dom offset 0', toCharOffset(bodyText, 0) === 0)
  check('dom offset after newline', toCharOffset(bodyText, 4) === 3, toCharOffset(bodyText, 4))
  check('dom offset at end', toCharOffset(bodyText, bodyText.length) === 9,
    toCharOffset(bodyText, bodyText.length))
  check('dom offset beyond end clamps', toCharOffset(bodyText, 999) === 9)
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
