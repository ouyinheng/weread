import type { BackgroundId } from '@/types'

/**
 * Font stacks mirroring WeRead's font picker.
 *
 * WeRead ships licensed CJK families (仓耳 / 方正 / 汉仪 …) inside the APK.
 * Those binaries cannot be redistributed here, so this list is honest about
 * what a device actually has: the platform UI face plus the system CJK
 * families that render differently. Everything shown in the picker really
 * resolves to a distinct face on at least one platform.
 */
export type FontGroup = 'sans' | 'serif' | 'kai' | 'mono'

export interface FontOption {
  id: string
  label: string
  stack: string
  group: FontGroup
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'system',
    label: '系统字体',
    stack: `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`,
    group: 'sans',
  },
  {
    id: 'sans',
    label: '思源黑体',
    stack: `'Source Han Sans SC', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', 'Heiti SC', '黑体', sans-serif`,
    group: 'sans',
  },
  {
    id: 'heiti',
    label: '黑体',
    stack: `'Heiti SC', 'SimHei', '黑体', 'Noto Sans CJK SC', sans-serif`,
    group: 'sans',
  },
  {
    id: 'serif',
    label: '思源宋体',
    stack: `'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', 'STSong', 'SimSun', '宋体', serif`,
    group: 'serif',
  },
  {
    id: 'songti',
    label: '宋体',
    stack: `'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', '宋体', serif`,
    group: 'serif',
  },
  {
    id: 'kai',
    label: '楷体',
    stack: `'Kaiti SC', 'STKaiti', 'KaiTi', '楷体', 'Kaiti TC', serif`,
    group: 'kai',
  },
  {
    id: 'fangsong',
    label: '仿宋',
    stack: `'STFangsong', 'FangSong', '仿宋', 'Songti SC', serif`,
    group: 'kai',
  },
  {
    id: 'mono',
    label: '等宽字体',
    stack: `'SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Noto Sans Mono CJK SC', monospace`,
    group: 'mono',
  },
]

export const FONT_GROUPS: { id: FontGroup; label: string }[] = [
  { id: 'sans', label: '黑体' },
  { id: 'serif', label: '宋体' },
  { id: 'kai', label: '楷仿' },
  { id: 'mono', label: '等宽' },
]

export function fontStackOf(id: string): string {
  return (FONT_OPTIONS.find(f => f.id === id) || FONT_OPTIONS[0]).stack
}

export function fontLabelOf(id: string): string {
  return (FONT_OPTIONS.find(f => f.id === id) || FONT_OPTIONS[0]).label
}

/** Theme palettes — values taken from WeRead's reader_background_* selectors. */
export const THEMES = {
  white:  { bg: '#FFFFFF', text: '#333333', secondary: '#999999', divider: '#EEEEEE', panel: '#FFFFFF' },
  yellow: { bg: '#F5ECD9', text: '#5B4636', secondary: '#A08B72', divider: '#DDD0B8', panel: '#F5ECD9' },
  green:  { bg: '#C8E6C9', text: '#2E5E31', secondary: '#6B9E6F', divider: '#A8CFAA', panel: '#C8E6C9' },
  black:  { bg: '#1A1A1A', text: '#BBBBBB', secondary: '#666666', divider: '#333333', panel: '#2A2A2A' },
} as const

export type ThemeKey = keyof typeof THEMES

/** Page textures — single source of truth for settings page and reader panel. */
export interface BackgroundOption {
  id: BackgroundId
  label: string
  /** CSS background-image; empty means "flat colour from the theme". */
  css: string
  /**
   * True when the texture paints an opaque light surface — 纸张/沙丘/天空 lay a
   * solid gradient over the theme colour, so light ink becomes unreadable and
   * the body must switch to the dark pair. 网格 is a translucent line overlay
   * that leaves the theme colour showing through, so it is *not* light.
   */
  light: boolean
}

export const BACKGROUND_OPTIONS: BackgroundOption[] = [
  { id: 'plain',  label: '纯色', css: '', light: false },
  { id: 'paper',  label: '纸张', css: 'linear-gradient(#F7F3EA, #F2ECDF)', light: true },
  { id: 'grid',   label: '网格', css: 'repeating-linear-gradient(0deg, rgba(0,0,0,.045) 0 1px, transparent 1px 22px), repeating-linear-gradient(90deg, rgba(0,0,0,.045) 0 1px, transparent 1px 22px)', light: false },
  { id: 'desert', label: '沙丘', css: 'linear-gradient(#F3E2C7, #E5CBA5)', light: true },
  { id: 'sky',    label: '天空', css: 'linear-gradient(#DCEBF7, #BBD8EE)', light: true },
]

export function backgroundOf(id: string): BackgroundOption {
  return BACKGROUND_OPTIONS.find(b => b.id === id) || BACKGROUND_OPTIONS[0]
}

export function backgroundCssOf(id: string): string {
  return backgroundOf(id).css
}
