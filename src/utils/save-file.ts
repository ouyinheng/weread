/**
 * Deliver a generated file to the user.
 *
 * Inside the Android shell a WebView `<a download>` goes nowhere and
 * `navigator.share` is not guaranteed, so the bytes are streamed through the
 * native bridge into the system 下载 collection. Browsers fall back to Web
 * Share, then to a normal download.
 */
export interface SaveResult {
  mode: 'saved' | 'shared' | 'downloaded'
  /** Where the native shell put the file (only for `mode === 'saved'`). */
  path?: string
}

interface NativeFileBridge {
  beginFile?: (name: string, mimeType: string) => string
  appendFile?: (chunk: string) => boolean
  endFile?: (ok: boolean) => string
}

function nativeBridge(): NativeFileBridge | undefined {
  return (window as unknown as { AndroidSystemBars?: NativeFileBridge }).AndroidSystemBars
}

/** Base64 of a byte range, built in slices so a large chunk cannot blow the stack. */
function chunkToBase64(bytes: Uint8Array): string {
  let binary = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(binary)
}

export async function saveFile(blob: Blob, filename: string, mime: string): Promise<SaveResult> {
  const native = nativeBridge()
  if (native?.beginFile && native.appendFile && native.endFile) {
    try {
      const path = native.beginFile(filename, mime)
      if (path) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const CHUNK = 256 * 1024
        let ok = true
        for (let i = 0; i < bytes.length; i += CHUNK) {
          if (!native.appendFile(chunkToBase64(bytes.subarray(i, i + CHUNK)))) {
            ok = false
            break
          }
        }
        const saved = native.endFile(ok)
        if (ok && saved) return { mode: 'saved', path: saved }
      }
    } catch {
      /* fall through to the web paths */
    }
  }

  const file = new File([blob], filename, { type: mime })
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean
  }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file] })
    return { mode: 'shared' }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the download a moment to start before the blob is freed.
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  return { mode: 'downloaded' }
}
