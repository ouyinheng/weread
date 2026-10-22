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
}

export interface Chapter {
  index: number
  title: string
  charOffset: number
  wordCount: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  pageMargin: number
  theme: ThemeId
  background: BackgroundId
  fontFamily: string
  turnPageType: TurnPageType
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
  /** Follow the OS dark-mode preference for the whole app. */
  followSystemTheme: boolean
}

export type ThemeId = 'white' | 'yellow' | 'green' | 'black'
export type BackgroundId = 'plain' | 'paper' | 'grid' | 'desert' | 'sky'
export type TurnPageType = 'horizontal' | 'vertical' | 'simulation' | 'cover'

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
  createdAt: number
}

export interface ReadingSession {
  bookId: string
  startedAt: number
  duration: number
}
