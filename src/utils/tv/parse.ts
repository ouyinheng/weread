/**
 * 影视模块的纯函数：地址归一化与播放地址解析。
 *
 * 单独成文件是为了能直接跑单测——`cms.ts` 会拉进网络层，`store.ts` 会拉进
 * Pinia 和数据库，这两条依赖链都不该出现在解析逻辑的测试里。
 */
import type { TvEpisode, TvPlayGroup } from './types'

/** 用户可能只填 `example.com/api.php/provide/vod`，补协议和结尾斜杠。 */
export function normalizeApi(raw: string): string {
  let api = String(raw || '').trim()
  if (!api) return ''
  if (!/^https?:\/\//i.test(api)) api = `https://${api}`
  if (!api.endsWith('/')) api += '/'
  return api
}

/**
 * 解析 `vod_play_url`。
 *
 * 形如 `第1集$https://a.m3u8#第2集$https://b.m3u8$$$线路2$...`：
 * `$$$` 分线路，`#` 分集，首个 `$` 分隔集名与地址。集名可能缺失，用序号兜底；
 * 非 http(s) 的条目（广告位、空占位）直接丢弃。
 */
export function parsePlayGroups(raw: string | undefined, from: string | undefined): TvPlayGroup[] {
  const text = String(raw || '').trim()
  if (!text) return []

  const fromNames = String(from || '').split('$$$')
  const groups: TvPlayGroup[] = []

  text.split('$$$').forEach((chunk, gi) => {
    const episodes: TvEpisode[] = []
    chunk.split('#').forEach((line, ei) => {
      const entry = line.trim()
      if (!entry) return
      const at = entry.indexOf('$')
      const name = (at > 0 ? entry.slice(0, at) : '').trim()
      const url = (at > 0 ? entry.slice(at + 1) : entry).trim()
      if (!/^https?:\/\//i.test(url)) return
      episodes.push({ name: name || `第${ei + 1}集`, url })
    })
    if (!episodes.length) return
    const label = (fromNames[gi] || '').trim()
    groups.push({ name: label || `线路 ${gi + 1}`, episodes })
  })

  return groups
}
