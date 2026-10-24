/**
 * 书源的网络层。
 *
 * 第三方站点不会给 Access-Control-Allow-Origin，WebView 里的 fetch 会被 CORS
 * 拦死，所以原生壳里一律走 CapacitorHttp（底层 OkHttp），只有浏览器开发态
 * 才退回 fetch。响应统一拿原始字节自己解编码：源站大量使用 GBK，让原生层按
 * UTF-8 解会得到一片乱码。
 */
import { CapacitorHttp } from '@capacitor/core'
import { detectEncoding } from '@/utils/parser'
import { isNativeShell } from '@/utils/native'
import { SourceError } from '@/types/source'

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

export interface HttpOptions {
  headers?: Record<string, string>
  referer?: string
  timeout?: number
  /** legado's rule URL options; defaults to GET. */
  method?: 'GET' | 'POST'
  /** Request body for POST (form-encoded). */
  body?: string
  /** Decode the response with this charset instead of sniffing it. */
  charset?: string
}

export interface HttpResult {
  status: number
  text: string
  url: string
}

export interface BinaryResult {
  bytes: ArrayBuffer
  contentType: string
}

/* ---------- 目标校验 ---------- */

/**
 * 书源是用户导入的第三方 JSON，别让它把设备变成内网扫描器。
 * 只允许 http(s)，且拒绝本机 / 局域网地址。
 */
function assertPublicUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new SourceError('NET_HTTP', '书源地址无效')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SourceError('NET_HTTP', '书源地址必须是 http(s)')
  }
  const h = u.hostname.toLowerCase()
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new SourceError('NET_HTTP', '不允许访问本机或内网地址')
  }
}

/* ---------- 并发 / 限流 ---------- */

/** 极简信号量：移动端网络栈和源站都承受不了无限并发。 */
export class Semaphore {
  private q: Array<() => void> = []
  private n: number

  constructor(n: number) {
    this.n = n
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n <= 0) await new Promise<void>(r => this.q.push(r))
    this.n--
    try {
      return await fn()
    } finally {
      this.n++
      this.q.shift()?.()
    }
  }
}

/** 全局并发 ≤ 6 */
export const globalGate = new Semaphore(6)

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  code: 'NET_TIMEOUT' | 'RULE_EMPTY' = 'NET_TIMEOUT',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SourceError(code, '请求超时')), ms)
    task.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/* ---------- 编码 ---------- */

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/**
 * 原生端 `responseType: 'arraybuffer'` 回传的是 base64 字符串，
 * Web 端是真正的 ArrayBuffer，这里统一成字节。
 */
function toBytes(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  if (typeof data === 'string' && data) {
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
      try { return base64ToBytes(data) } catch { return null }
    }
  }
  return null
}

function headerOf(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ''
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
  return key ? String(headers[key] ?? '') : ''
}

function decodeBody(
  data: unknown,
  headers: Record<string, string> | undefined,
  charset?: string,
): string {
  /*
   * CapacitorHttp 遇到 `Content-Type: application/json` 会无视 responseType，
   * 直接把响应解析成对象。书源合集正好是 JSON，这里必须序列化回文本，
   * 否则 JSON.parse 收到的是 "[object Object]"，表现为只有手机端导入失败。
   */
  if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    try { return JSON.stringify(data) } catch { return '' }
  }
  const bytes = toBytes(data)
  // 原生端已解成字符串（非 arraybuffer 路径）：直接用。
  if (!bytes) return typeof data === 'string' ? data : String(data ?? '')

  // 规则里声明的 charset 优先：不少源站的响应头写 utf-8，正文其实是 GBK。
  if (charset) {
    try { return new TextDecoder(charset).decode(bytes) } catch { /* 落到探测 */ }
  }

  const ct = headerOf(headers, 'content-type')
  const m = /charset=([\w-]+)/i.exec(ct)
  if (m) {
    try { return new TextDecoder(m[1]).decode(bytes) } catch { /* 落到探测 */ }
  }
  const enc = detectEncoding(bytes)
  return new TextDecoder(enc === 'UNKNOWN' ? 'utf-8' : enc).decode(bytes)
}

/* ---------- 规则 URL ---------- */

/**
 * 拆开 legado 的 `url,{"method":"POST",...}` 形式。
 *
 * 书源的 `searchUrl` 常常不是一条纯 URL：搜索接口只接受 POST 表单，规则会写成
 * `"/search.php,{"method":"POST","body":"key={{key}}","charset":"GBK"}"`。
 * 早先这里没拆，整串被当路径拼进 URL、还按 GET 发送 —— 搜索接口当然回 404，
 * 表现为「这个源不能用」。
 */
export interface UrlRule {
  url: string
  options: HttpOptions
}

export function splitUrlRule(raw: string): UrlRule {
  const text = String(raw || '')
  // 选项块从第一个 `,{` 开始，一直到结尾（JSON 里可能有嵌套的 `{}`）。
  const at = text.indexOf(',{')
  if (at < 0) return { url: text, options: {} }

  const head = text.slice(0, at)
  const tail = text.slice(at + 1)
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(tail)
  } catch {
    // 不是合法 JSON：宁可整串当 URL（旧行为），也不要吞掉规则。
    return { url: text, options: {} }
  }

  const options: HttpOptions = {}
  const method = String(parsed.method || '').toUpperCase()
  if (method === 'POST') options.method = 'POST'
  const body = parsed.body ?? parsed.form
  if (typeof body === 'string' && body) options.body = body
  if (typeof parsed.charset === 'string' && parsed.charset) options.charset = parsed.charset
  if (parsed.headers && typeof parsed.headers === 'object') {
    options.headers = parsed.headers as Record<string, string>
  }
  return { url: head, options }
}

/* ---------- 请求 ---------- */

function mergedHeaders(opts: HttpOptions): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS, ...(opts.headers || {}) }
  if (opts.referer) headers.Referer = opts.referer
  if (opts.method === 'POST' && opts.body) {
    // 表单提交：没有这个头，多数源站会把 body 当查询串忽略。
    const hasType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type')
    if (!hasType) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return headers
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  assertPublicUrl(url)
  const headers = mergedHeaders(opts)
  const timeout = opts.timeout ?? 20000
  const method = opts.method === 'POST' ? 'POST' : 'GET'

  try {
    if (isNativeShell()) {
      const r = await CapacitorHttp.request({
        url,
        method,
        headers,
        ...(method === 'POST' && opts.body ? { data: opts.body } : {}),
        responseType: 'arraybuffer',
        connectTimeout: 15000,
        readTimeout: timeout,
      })
      return { status: r.status, text: decodeBody(r.data, r.headers, opts.charset), url: r.url || url }
    }

    // 浏览器开发态：第三方站点多半不给 CORS 头，只适合调试内置源。
    // 调试第三方源请用 `--disable-web-security` 启动的浏览器。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? opts.body : undefined,
        signal: ctrl.signal,
      })
      const buf = await r.arrayBuffer()
      const rec: Record<string, string> = {}
      r.headers.forEach((v, k) => { rec[k] = v })
      return { status: r.status, text: decodeBody(buf, rec, opts.charset), url }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    if (e instanceof SourceError) throw e
    const msg = String((e as Error)?.message || e)
    if (/abort|timeout|timed out/i.test(msg)) throw new SourceError('NET_TIMEOUT')
    throw new SourceError('NET_HTTP', `请求失败：${msg}`)
  }
}

export function httpGet(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  return httpRequest(url, { ...opts, method: 'GET', body: undefined })
}

/** 二进制请求：封面用，绝不能过 TextDecoder（图片会变成乱码字符串）。 */
export async function httpGetBinary(
  url: string,
  timeout = 15000,
  headers: Record<string, string> = {},
): Promise<BinaryResult> {
  assertPublicUrl(url)
  const h = mergedHeaders({ headers })

  try {
    if (isNativeShell()) {
      const r = await CapacitorHttp.request({
        url,
        method: 'GET',
        headers: h,
        responseType: 'arraybuffer',
        connectTimeout: 10000,
        readTimeout: timeout,
      })
      if (r.status !== 200) throw new SourceError('NET_HTTP', `封面 HTTP ${r.status}`)
      const bytes = toBytes(r.data)
      if (!bytes) throw new SourceError('NET_HTTP', '封面响应为空')
      return { bytes, contentType: headerOf(r.headers, 'content-type') }
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(url, { headers: h, signal: ctrl.signal })
      if (!r.ok) throw new SourceError('NET_HTTP', `封面 HTTP ${r.status}`)
      return { bytes: await r.arrayBuffer(), contentType: headerOfString(r.headers.get('content-type')) }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    if (e instanceof SourceError) throw e
    throw new SourceError('NET_HTTP', '封面下载失败')
  }
}

function headerOfString(v: string | null): string {
  return v || ''
}

/* ---------- HTML ---------- */

/** DOMParser 不执行脚本、不加载图片，解析第三方页面本身是安全的。 */
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** 书源自带 header 字段（JSON 字符串），优先级高于默认头。 */
export function sourceHeaders(raw: Record<string, any> | undefined): Record<string, string> {
  const v = raw?.header
  if (!v) return {}
  if (typeof v === 'object') return v as Record<string, string>
  try {
    const parsed = JSON.parse(String(v))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/* ---------- 封面 ---------- */

function sniffMime(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes.slice(0, 12))
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return 'image/jpeg'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => reject(new Error('image timeout')), 8000)
    img.onload = () => { clearTimeout(timer); resolve(img) }
    img.onerror = () => { clearTimeout(timer); reject(new Error('image error')) }
    img.src = src
  })
}

/**
 * 封面压成 dataURL。与本地书保持一致：blob: 会随文档失效，不能落库。
 */
export async function shrinkToDataUrl(
  bytes: ArrayBuffer,
  contentType: string,
  maxWidth = 480,
): Promise<string> {
  const mime = contentType && /^image\//i.test(contentType) ? contentType.split(';')[0] : sniffMime(bytes)
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const w0 = img.naturalWidth || img.width
    const h0 = img.naturalHeight || img.height
    const scale = Math.min(1, maxWidth / Math.max(1, w0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}
