/**
 * 本地视频：从系统文件选择器挑出来的片子，只活在本次会话里。
 *
 * 用 blob URL 挂在模块单例上，而不是塞进 IndexedDB：
 *  - 视频动辄几百兆，存进库既慢又吃配额，还不该跟着书库备份一起走；
 *  - blob URL 只在创建它的 document 内有效，刷新即失效。所以这里不做
 *    「记住上次看的文件」这种假承诺，失效后由上层提示重新选择。
 *
 * 单例的用处是跨路由：影视首页选完文件 → 跳播放页，SPA 内不换 document，
 * URL 仍然可用，播放页直接取列表就能放。
 */
import type { TvEpisode } from './types'

export interface LocalVideo {
  /** 去掉扩展名的文件名，当标题用。 */
  name: string
  /** 指向 File 的 blob URL。 */
  url: string
  size: number
}

let list: LocalVideo[] = []

export function localVideos(): LocalVideo[] {
  return list
}

/** 换一批文件：先释放旧的 blob URL，再为新的建 URL。 */
export function takeLocalVideos(files: File[]): LocalVideo[] {
  releaseLocalVideos()
  list = files.map(f => ({
    name: fileTitle(f.name),
    url: URL.createObjectURL(f),
    size: f.size,
  }))
  return list
}

export function releaseLocalVideos(): void {
  for (const v of list) URL.revokeObjectURL(v.url)
  list = []
}

/** 交给播放页的形状，跟「线路 / 集」对齐，播放核心不用分叉。 */
export function localEpisodes(): TvEpisode[] {
  return list.map(v => ({ name: v.name, url: v.url }))
}

export function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name
}

/**
 * 打开系统文件选择器。
 *
 * 必须同步地在点击回调里调用：浏览器和 Android WebView 都只允许在用户手势
 * 内弹出文件框。跟书籍导入那边同一条路子（那边 accept 是文本格式）。
 */
export function pickLocalVideos(onPicked: (videos: LocalVideo[]) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*'
  input.multiple = true
  // 有些 WebView 只对挂在文档里的 input 触发 change，所以先塞进去再点。
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.onchange = () => {
    const files = Array.from(input.files || [])
    input.remove()
    if (files.length) onPicked(takeLocalVideos(files))
  }
  document.body.appendChild(input)
  input.click()
}
