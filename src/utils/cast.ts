import { registerPlugin } from '@capacitor/core'

/**
 * 投屏（DLNA）。
 *
 * 厂商电视/盒子的「投屏」基本都是 UPnP AV 的 MediaRenderer，所以这里走
 * 「SSDP 发现 + SOAP 控制」这一条老路，而不是 Cast SDK：后者要 Google Play
 * 服务，国内设备大量缺失。
 *
 * 原生实现在 `android/.../CastPlugin.java`；网页端没有这个能力，`supported()`
 * 会返回 false，调用方据此隐藏入口而不是弹一个点了没反应的按钮。
 */
export interface CastDevice {
  id: string
  name: string
  model: string
  location: string
  controlUrl: string
}

interface CastApi {
  isAvailable(): Promise<{ available: boolean }>
  discover(): Promise<{ devices: CastDevice[] }>
  cast(o: { controlUrl: string; url: string; title?: string; name?: string }): Promise<{ ok: boolean }>
  stopCast(): Promise<{ ok: boolean }>
  status(): Promise<{ casting: boolean; name: string }>
}

const Cast = registerPlugin<CastApi>('Cast')

const isNative = typeof window !== 'undefined' && !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()

/** 只有装了原生插件的环境才有投屏。 */
export function castSupported(): boolean {
  return isNative
}

export async function discoverDevices(): Promise<CastDevice[]> {
  if (!castSupported()) throw new Error('unsupported')
  const res = await Cast.discover()
  return res?.devices ?? []
}

export async function castTo(device: CastDevice, url: string, title: string): Promise<void> {
  await Cast.cast({ controlUrl: device.controlUrl, url, title, name: device.name })
}

export async function stopCasting(): Promise<void> {
  if (!castSupported()) return
  try { await Cast.stopCast() } catch { /* 设备可能已经离线 */ }
}

export async function castStatus(): Promise<{ casting: boolean; name: string }> {
  if (!castSupported()) return { casting: false, name: '' }
  try { return await Cast.status() } catch { return { casting: false, name: '' } }
}
