/**
 * 在线书源（legado 规范）的数据模型。
 *
 * 一条书源就是一份 JSON 规则：怎么搜、怎么取详情、怎么取目录、怎么取正文。
 * `raw` 保留原始整包，站点改版时用户可以直接编辑 JSON，不必重新导入。
 */

/** 0 未知 / 1 可用 / 2 降级（能搜但读不到正文）/ 3 失效 */
export type SourceHealth = 0 | 1 | 2 | 3

export const HEALTH_LABEL: Record<number, string> = {
  0: '未检测',
  1: '可用',
  2: '降级',
  3: '失效',
}

export const HEALTH_COLOR: Record<number, string> = {
  0: '#9A9A9A',
  1: '#33B36B',
  2: '#E6A23C',
  3: '#E35B5B',
}

export interface BookSource {
  /** = bookSourceUrl 去掉 # 后缀，天然唯一 */
  id: string
  name: string
  /** 站点根地址，已去掉 # 备注后缀与尾部斜杠 */
  url: string
  group: string
  /** 0 文本 / 1 音频 / 2 图片 / 3 文件；只处理 0 */
  type: number
  enabled: boolean
  /** 原始 legado JSON，整包留着，规则升级 / 回滚不用重新导入 */
  raw: Record<string, any>
  health: number
  lastCheckAt: number
  lastError: string
  createdAt: number
}

export interface SearchHit {
  sourceId: string
  sourceName: string
  title: string
  author: string
  intro: string
  kind: string
  coverUrl: string | null
  bookUrl: string
  lastChapter: string
  wordCount: string
}

export interface RemoteChapter {
  title: string
  url: string
  index: number
}

export interface BookInfo {
  title: string
  author: string
  intro: string
  coverUrl: string | null
  tocUrl: string
}

export type SourceErrorCode =
  | 'SRC_NOT_FOUND'
  | 'SRC_DISABLED'
  | 'NET_TIMEOUT'
  | 'NET_HTTP'
  | 'RULE_EMPTY'
  | 'TOC_EMPTY'
  | 'CONTENT_EMPTY'
  | 'NO_SOURCE'

const CODE_TEXT: Record<SourceErrorCode, string> = {
  SRC_NOT_FOUND: '书源已删除，请换源',
  SRC_DISABLED: '网络书源已关闭',
  NET_TIMEOUT: '网络超时，请重试',
  NET_HTTP: '源站异常，请重试或换源',
  RULE_EMPTY: '该源规则已失效',
  TOC_EMPTY: '该源没有可读章节',
  CONTENT_EMPTY: '本章抓取失败，请重试',
  NO_SOURCE: '换个关键词，或检查书源',
}

export class SourceError extends Error {
  code: SourceErrorCode

  constructor(code: SourceErrorCode, message?: string) {
    super(message || CODE_TEXT[code])
    this.name = 'SourceError'
    this.code = code
  }
}

/** 在线书的唯一判据：有条来源书源。不要用 format 判断。 */
export function isOnlineBook(book: { sourceId?: string }): boolean {
  return !!book.sourceId
}
