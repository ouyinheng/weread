/**
 * 影视模块的数据模型。
 *
 * 源模型直接对齐 LibreTV / TVBox 的惯例：一个源 = 苹果 CMS V10 的 `provide/vod`
 * 接口根地址，搜索与详情都靠 `?ac=videolist` 这一套查询参数。字段名保持
 * `SourceConfig` 的形状（name/url），导入 LibreTV 导出的源列表时不用做映射。
 */

export interface TvSource {
  id: string
  name: string
  /** 苹果 CMS V10 接口根地址，如 https://example.com/api.php/provide/vod/ */
  api: string
  enabled: boolean
  addedAt: number
}

export interface TvItem {
  id: string
  name: string
  pic?: string
  year?: string
  area?: string
  typeName?: string
  remarks?: string
  sourceId: string
  sourceName: string
}

export interface TvEpisode {
  name: string
  url: string
}

/** 一条播放线路。CMS 的 vod_play_url 用 `$$$` 分隔多条线路。 */
export interface TvPlayGroup {
  name: string
  episodes: TvEpisode[]
}

export interface TvDetail {
  id: string
  name: string
  pic?: string
  desc?: string
  year?: string
  area?: string
  typeName?: string
  remarks?: string
  groups: TvPlayGroup[]
  source: TvSource
}

/** 观看记录：按「源 + 影片」去重，只保留最后一次看到的位置。 */
export interface TvHistoryEntry {
  key: string
  sourceId: string
  sourceName: string
  vodId: string
  name: string
  pic?: string
  /** 线路下标，恢复播放时要用 */
  groupIndex: number
  episodeIndex: number
  episodeName: string
  /** 秒 */
  position: number
  /** 秒；0 表示时长未知 */
  duration: number
  updatedAt: number
}
