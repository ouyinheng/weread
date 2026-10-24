import { splitUrlRule } from '../src/utils/source/net.ts'
import { fillVars, fillTemplate } from '../src/utils/source/pipeline.ts'

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) fail++
}

/*
 * legado's `searchUrl` is either a plain URL or `url,{jsonOptions}`. Getting the
 * split wrong sends the JSON as part of the path and turns a POST search
 * endpoint into a 404 — which reads to the user as "this source is broken".
 */

/* ---------- plain URL ---------- */
{
  const r = splitUrlRule('https://www.91zww.com/search/?searchkey={{key}}')
  check('plain url kept', r.url === 'https://www.91zww.com/search/?searchkey={{key}}', r.url)
  check('plain url no method', r.options.method === undefined)
}

/* ---------- POST with form body ---------- */
{
  const raw = '/modules/article/search.php,{\n  "body": "submit=搜索&searchkey={{key}}",\n  "charset": "GBK",\n  "method": "POST"\n}'
  const r = splitUrlRule(raw)
  check('post url peeled', r.url === '/modules/article/search.php', JSON.stringify(r.url))
  check('post method', r.options.method === 'POST', r.options.method)
  check('post body', r.options.body === 'submit=搜索&searchkey={{key}}', r.options.body)
  check('post charset', r.options.charset === 'GBK', r.options.charset)
  check('url keeps no json', !r.url.includes('{'), r.url)
}

/* ---------- GET with options only ---------- */
{
  const r = splitUrlRule('/search/,{"charset":"gbk"}')
  check('get url peeled', r.url === '/search/', r.url)
  check('get method stays default', r.options.method === undefined, r.options.method)
  check('get charset', r.options.charset === 'gbk', r.options.charset)
}

/* ---------- custom headers ---------- */
{
  const r = splitUrlRule('https://a.com/s,{"headers":{"X-Requested-With":"XMLHttpRequest"}}')
  check('headers lifted', r.options.headers?.['X-Requested-With'] === 'XMLHttpRequest',
    JSON.stringify(r.options.headers))
}

/* ---------- malformed options fall back to the old behaviour ---------- */
{
  const raw = 'https://a.com/s,{not json'
  const r = splitUrlRule(raw)
  check('malformed keeps whole string', r.url === raw, r.url)
  check('malformed has no options', r.options.method === undefined)
}

/* ---------- braces inside a template are not an options block ---------- */
{
  const raw = 'https://a.com/s?q={{key}}'
  const r = splitUrlRule(raw)
  check('template braces untouched', r.url === raw, r.url)
}

/* ---------- fillVars: body vs url encoding ---------- */
{
  check('fillVars encodes key', fillVars('searchkey={{key}}', { key: '剑 来' }) === 'searchkey=%E5%89%91%20%E6%9D%A5',
    fillVars('searchkey={{key}}', { key: '剑 来' }))
  check('fillVars leaves literals', fillVars('submit=搜索&searchkey={{key}}', { key: 'abc' }).startsWith('submit=搜索&'),
    fillVars('submit=搜索&searchkey={{key}}', { key: 'abc' }))
  check('fillVars page raw', fillVars('p={{page}}', { key: '', page: '2' }) === 'p=2')
}

/* ---------- fillTemplate still resolves relative URLs ---------- */
{
  const abs = fillTemplate('/search', { key: 'x' }, 'https://www.a.com')
  check('relative resolved', abs === 'https://www.a.com/search', abs)
  const abs2 = fillTemplate('https://b.com/s?q={{key}}', { key: 'a b' }, 'https://www.a.com')
  check('absolute kept', abs2 === 'https://b.com/s?q=a%20b', abs2)
}

/* ---------- a body template must not be URL-resolved ---------- */
{
  // The old code sent the body through fillTemplate, which turned
  // "submit=搜索&searchkey=x" into a URL-ish string.
  const body = fillVars('submit=搜索&searchkey={{key}}', { key: 'x' })
  check('body stays a form string', body === 'submit=搜索&searchkey=x', body)
  check('body is not absolute', !/^https?:/.test(body))
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
