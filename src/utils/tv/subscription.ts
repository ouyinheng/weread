/**
 * 订阅导入：把 TVBOX 配置 / LibreTV 导出的 JSON / 裸数组里的接口地址挑出来。
 *
 * 参考 LibreTV 的 `tvbox-parser`：**只收「直连类」条目**，也就是苹果 CMS 的
 * JSON 接口。TVBOX 里大量的 `csp_xxx` / jar / js / py 是 Spider 引擎才跑得动的，
 * XML 接口和单仓 JSON 也不是一个 GET 能拿到的——这些一律跳过并计数，而不是
 * 塞进源列表里变成一堆点了就报错的死源。
 */

export interface ImportedSource {
  name?: string
  api: string
  /** 源列表里标注的清晰度（高度像素）；缺省表示未标注 */
  quality?: number
}

/** 跳过原因：给用户一句能看懂的解释，不写技术黑话。 */
export type SkipReason = 'spider' | 'xml' | 'disabled' | 'unsearchable' | 'invalid'

export interface ImportResult {
  sources: ImportedSource[]
  skipped: Record<SkipReason, number>
  /** 原始条目数（含跳过），用来在提示里说「从 N 条里收了 M 条」。 */
  total: number
}

/** Spider 特征：csp_ 前缀，或 jar / js / py 资源（可能带查询串）。 */
const SPIDER_PATTERN = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i
/** 相对路径 / 本地资源（./json/xxx.json）同样需要 TVBOX 引擎。 */
const LOCAL_ASSET_PATTERN = /^\.{0,2}\//
/** 苹果 CMS 直连接口特征；排除 XML 通道（/at/xml），那种我们解析不了。 */
const CMS_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i
const XML_PATTERN = /\/at\/xml(?:[/?#]|$)/i

const SITE_TYPE_XML = 0
const SITE_TYPE_JSON = 1

/** 源列表里常见的清晰度写法 → 视频高度（像素） */
const QUALITY_ALIASES: Record<string, number> = {
  '8k': 4320,
  '4k': 2160,
  '2k': 1440,
  '1080p': 1080,
  '720p': 720,
  '540p': 540,
  '480p': 480,
  '360p': 360,
}

/**
 * 归一化清晰度标注：`2160`、`"2160"`、`"4K"`、`"1080P"` 都收。
 *
 * 只认 120–4320 的高度值：低于 120 的多半是误填的宽高比，高于 8K 的明显是脏数据，
 * 一律当「未标注」处理（而不是显示一个错得离谱的档位）。
 */
export function normalizeQuality(raw: unknown): number | undefined {
  let value: number | undefined
  if (typeof raw === 'number') {
    value = raw
  } else if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    if (!text) return undefined
    const alias = QUALITY_ALIASES[text]
    if (alias) return alias
    const matched = text.match(/^(\d{3,4})\s*p?$/)
    if (!matched) return undefined
    value = Number(matched[1])
  }
  if (value === undefined || !Number.isFinite(value)) return undefined
  const height = Math.round(value)
  return height >= 120 && height <= 4320 ? height : undefined
}

function emptySkips(): Record<SkipReason, number> {
  return { spider: 0, xml: 0, disabled: 0, unsearchable: 0, invalid: 0 }
}

interface Candidate {
  name?: string
  api?: unknown
  type?: unknown
  searchable?: unknown
  disabled?: unknown
  quality?: unknown
}

/**
 * 判断一条 site 该怎么处理。
 *
 * `type` 缺失或写得不准的很多，所以不能只看 type：地址命中 CMS 特征才算数。
 */
function classify(row: Candidate): { ok: ImportedSource } | { skip: SkipReason } {
  const api = typeof row.api === 'string' ? row.api.trim() : ''
  if (!api) return { skip: 'invalid' }
  if (row.disabled === 1 || row.disabled === '1') return { skip: 'disabled' }

  if (SPIDER_PATTERN.test(api) || LOCAL_ASSET_PATTERN.test(api)) return { skip: 'spider' }
  if (Number(row.type) === SITE_TYPE_XML || XML_PATTERN.test(api)) return { skip: 'xml' }
  if (!/^https?:\/\//i.test(api)) return { skip: 'invalid' }
  // type=1 的 JSON 接口，或者地址本身就是 CMS 采集站（很多配置把 type 写成 0/缺省）
  const isCms = Number(row.type) === SITE_TYPE_JSON || CMS_PATTERN.test(api)
  if (!isCms) return { skip: 'invalid' }
  if (row.searchable === 0 || row.searchable === '0') return { skip: 'unsearchable' }

  const name = typeof row.name === 'string' ? row.name.trim() : ''
  return { ok: { name: name || undefined, api, quality: normalizeQuality(row.quality) } }
}

/**
 * 解析订阅内容。兼容四种结构：
 *  - TVBOX 配置： `{ sites: [{ key, name, type, api, searchable, disabled }] }`
 *  - LibreTV 导出：`{ customAPIs: [{ name, url }] }`
 *  - 本 App 导出：`{ sources: [{ name, url }] }`
 *  - 裸数组：     `[{ name, url | api }]`
 */
export function parseSubscription(text: string): ImportResult {
  const data = JSON.parse(text) as unknown
  const rows: Candidate[] = []
  const collect = (v: unknown): void => {
    if (!Array.isArray(v)) return
    for (const row of v) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      rows.push({
        name: (r.name ?? r.key) as string | undefined,
        api: r.api ?? r.url,
        type: r.type,
        searchable: r.searchable,
        disabled: r.disabled,
        quality: r.quality,
      })
    }
  }

  if (Array.isArray(data)) collect(data)
  else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    collect(obj.sites)
    if (!rows.length) collect(obj.customAPIs)
    if (!rows.length) collect(obj.sources)
  }

  const skipped = emptySkips()
  const sources: ImportedSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const result = classify(row)
    if ('skip' in result) {
      skipped[result.skip]++
      continue
    }
    // 同一个接口在配置里重复出现很常见（不同名字指向同一个站）
    if (seen.has(result.ok.api)) continue
    seen.add(result.ok.api)
    sources.push(result.ok)
  }

  return { sources, skipped, total: rows.length }
}

/** 跳过原因 → 一句人话，用在导入结果的提示里。 */
export function describeSkips(skipped: Record<SkipReason, number>): string {
  const labels: Array<[SkipReason, string]> = [
    ['spider', 'Spider 引擎'],
    ['xml', 'XML 接口'],
    ['unsearchable', '不支持搜索'],
    ['disabled', '已停用'],
    ['invalid', '地址不合法'],
  ]
  const parts = labels.filter(([k]) => skipped[k] > 0).map(([k, label]) => `${label} ${skipped[k]}`)
  return parts.join('、')
}
