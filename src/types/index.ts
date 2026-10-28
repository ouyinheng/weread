export interface Book {
  id: string
  title: string
  author: string
  format: 'txt' | 'epub'
  cover: string | null
  wordCount: number
  fileSize: number
  importedAt: number
  lastReadAt: number
  progress: number
  lastChapterIndex: number
  lastCharOffset: number
  finished: boolean
  /** Parser generation that produced the stored chapters. */
  parserVersion?: number
  /** Original filename, needed to re-parse from the stored source bytes. */
  sourceName?: string
  /** SHA-256 of the imported bytes, so the same file cannot land twice. */
  fingerprint?: string

  /* ---------- 在线书（sourceId 存在即在线书，format 仍是 txt） ---------- */
  /** 来源书源 id；本地导入的书为 undefined */
  sourceId?: string
  /** 在线书在源站的详情页 */
  remoteBookUrl?: string
  /** 在线书目录页（可能等于详情页） */
  remoteTocUrl?: string
  /** 已落库正文的章节数，用于显示缓存进度 */
  cachedChapterCount?: number
  /** 上次阅读位置对应的源站章节 URL，用于目录变动后重新定位 */
  lastRemoteUrl?: string
}

export interface Chapter {
  index: number
  title: string
  charOffset: number
  wordCount: number
  /** 在线章节的源站 URL；本地书为 undefined。正文为空时凭它去抓 */
  remoteUrl?: string
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  pageMargin: number
  theme: ThemeId
  background: BackgroundId
  fontFamily: string
  turnPageType: TurnPageType
  /** 自动翻页间隔（秒）。 */
  autoPageSeconds: number
  firstLineIndent: boolean
  /**
   * Extra space between paragraphs. WeRead offers this as a switch under
   * 首行缩进 and defaults it off — paragraphs separate by the 2em indent alone.
   */
  paragraphSpacing: boolean
  brightness: number
  showStatusBar: boolean
  volumeKeyTurn: boolean
  landscape: boolean
  noAutoLock: boolean
  /* ---- 听书 ---- */
  /** Speech rate, 0.5–3.0. */
  listenRate: number
  /** Engine voice name; empty means the engine default. */
  listenVoice: string
  /** Roll into the next chapter when the current one is finished. */
  listenAutoNext: boolean
  /** Paint the follow-along highlight and turn the page with the voice. */
  listenFollow: boolean
}

/**
 * App-level appearance, separate from the reader's typography.
 *
 * The reader owns how *body text* looks (size, leading, theme) because those
 * must be judged against the page. Everything else in the app shares one scale,
 * which lives here.
 */
export interface AppSettings {
  /** Base font scale for app chrome (1 = 100%). */
  fontScale: number
  /** Chrome font family id, from FONT_OPTIONS. */
  fontFamily: string
  /** Whole-app colour scheme; the reader's own theme stays independent. */
  theme: AppTheme
  /** Show the 书架 tab in the bottom bar. On by default; the library stays reachable either way. */
  showShelfTab: boolean
  /** Show the 影视 tab in the bottom bar. Off by default; sources keep working either way. */
  showTvTab: boolean
}

export type AppTheme = 'system' | 'light' | 'dark'
export type ThemeId = 'white' | 'yellow' | 'green' | 'black'
export type BackgroundId = 'plain' | 'paper' | 'grid' | 'desert' | 'sky'
export type TurnPageType = 'horizontal' | 'vertical' | 'simulation' | 'cover'
/** 划线颜色；老记录没有 color，按 blue 处理。 */
export type HighlightColor = 'blue' | 'yellow' | 'green' | 'pink'

export interface Bookmark {
  id: string
  bookId: string
  chapterIndex: number
  charOffset: number
  excerpt: string
  createdAt: number
}

/**
 * 划线 / 想法 — a selected range inside a chapter's body text.
 *
 * Offsets count characters of the chapter body only (the rendered chapter
 * heading is chrome and is not included), so a highlight survives a font-size
 * change and a re-parse that keeps the same body text.
 */
export interface Highlight {
  id: string
  bookId: string
  chapterIndex: number
  start: number
  end: number
  text: string
  /** User's thought on the passage; empty for a plain 划线. */
  note: string
  /** 划线颜色；缺省为 blue（老数据）。 */
  color?: HighlightColor
  createdAt: number
}

export interface ReadingSession {
  bookId: string
  startedAt: number
  duration: number
}
