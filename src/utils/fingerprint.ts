/**
 * Content fingerprint for import dedup.
 *
 * A book is identified by the bytes the user picked, not by its filename: the
 * same novel downloaded twice under different names is still one book, and two
 * different files that happen to share a name are two. The digest is cheap
 * (SHA-256 over the already-read buffer) and costs nothing extra at import —
 * the bytes are in memory either way.
 */
export async function fingerprintOf(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    // Non-secure contexts (plain http) have no SubtleCrypto. Dedup is a
    // convenience, not a correctness requirement: import without it.
    return ''
  }
  try {
    const digest = await subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}
