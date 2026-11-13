/**
 * Bounded reading of an already-fetched response. This is an unconnected
 * candidate: it does not classify URLs, authorize their use, constrain a
 * producer's prefetch, count multiple images, or bound later base64/JSON copies.
 */
const MAX_SOURCE_CHUNKS = 8192

export async function readBoundedLocalChatImageBlob(
  response: Response,
  options: { maxBytes: number; signal?: AbortSignal }
): Promise<Blob> {
  const { maxBytes, signal } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Invalid image source limit.')

  const cancellation = (): Error => {
    const reason = signal?.reason
    if (reason instanceof Error) return reason
    const error = new Error(typeof reason === 'string' ? reason : 'Image source read was aborted.')
    error.name = 'AbortError'
    return error
  }
  const check = (): void => { if (signal?.aborted) throw cancellation() }
  check()
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Image source did not provide a readable body.')
  }

  const reader = response.body.getReader()
  let cancelled = false
  let completed = false
  const cancel = (): void => {
    if (cancelled || completed) return
    cancelled = true
    try { void reader.cancel().catch(() => undefined) } catch { /* best effort */ }
  }
  const onAbort = (): void => cancel()
  signal?.addEventListener('abort', onAbort, { once: true })

  // Unlike awaiting read() alone, an ignored cancel must not hold the caller or
  // permit a late result to be retained. The underlying producer can still be
  // alive; cancellation is best-effort, not proof of resource release.
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    check()
    if (!signal) return reader.read()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abortRead)
        callback()
      }
      const abortRead = (): void => finish(() => reject(cancellation()))
      signal.addEventListener('abort', abortRead, { once: true })
      if (signal.aborted) { abortRead(); return }
      try {
        reader.read().then(
          result => finish(() => resolve(result)),
          error => finish(() => reject(error))
        )
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  try {
    check()
    const chunks: ArrayBuffer[] = []
    let size = 0
    let chunkCount = 0
    while (true) {
      const result = await read()
      check()
      if (result.done) { completed = true; break }
      if (++chunkCount > MAX_SOURCE_CHUNKS) throw new Error('Image source exceeds the chunk limit.')
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) throw new Error('Image source returned an invalid chunk.')
      if (chunk.byteLength > maxBytes - size) throw new Error('Image source exceeds the per-image byte limit.')
      if (!chunk.byteLength) continue
      const owned = new ArrayBuffer(chunk.byteLength)
      new Uint8Array(owned).set(chunk)
      chunks.push(owned)
      size += chunk.byteLength
    }
    check()
    const blob = new Blob(chunks, { type: response.headers?.get('content-type') || '' })
    check()
    return blob
  } finally {
    cancel()
    signal?.removeEventListener('abort', onAbort)
    try { reader.releaseLock() } catch { /* an uncooperative reader may remain pending */ }
  }
}
