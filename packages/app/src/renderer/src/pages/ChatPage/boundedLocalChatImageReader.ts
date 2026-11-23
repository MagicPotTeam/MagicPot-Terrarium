/**
 * Bounded reading of an already-fetched response. chatRequestUtils uses it for
 * every un-managed request image whose response has a body, with a hard
 * per-image byte cap counted on bytes received. It does not classify URLs,
 * authorize their use, constrain a producer's prefetch, count multiple images,
 * or bound later base64/IPC/JSON copies.
 */
// The chunk limit bounds the read loop's work, not memory (small chunks are
// coalesced below). It scales with the byte cap so that a slow producer which
// delivers small chunks (a slow link: TCP-segment sized or smaller) still gets a
// valid image through, as response.blob() did; 8192 is the floor.
const MIN_SOURCE_CHUNKS = 8192
const MIN_AVERAGE_CHUNK_BYTES = 256
// Chunks below this size are copied into shared owned segments of this size, so
// many tiny chunks do not cost one ArrayBuffer each.
const SEGMENT_BYTES = 64 * 1024

// %TypedArray%.prototype[Symbol.toStringTag] reads the internal [[TypedArrayName]]
// slot: it works across realms (a platform Response's chunk can come from another
// realm, where instanceof fails) and, unlike Object.prototype.toString, cannot be
// forged with an own Symbol.toStringTag. If it is missing, every chunk is refused.
// The byteLength getter likewise reads the internal length, which is what set()
// copies, so an own byteLength property cannot make the byte count disagree with
// the bytes kept.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
// The Blob type is the MIME essence (type/subtype, lowercase, no parameters), as
// response.blob() gives it: a raw 'image/png; charset=binary' header would otherwise
// become a non-canonical data: URL prefix that MAIN refuses. Of several combined
// values the last valid one wins; an unusable header gives '' (no type).
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+"
const MIME_ESSENCE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`)
const mimeEssence = (header: string | null | undefined): string => {
  const values = String(header ?? '').split(',')
  for (let index = values.length - 1; index >= 0; index--) {
    const essence = values[index].split(';', 1)[0].trim().toLowerCase()
    if (MIME_ESSENCE.test(essence) && essence !== '*/*') return essence
  }
  return ''
}

// The chunk's internal byte length, or -1 unless it is a genuine Uint8Array.
const uint8ArrayChunkLength = (chunk: unknown): number => {
  try {
    if (!typedArrayByteLength || typedArrayTag?.call(chunk) !== 'Uint8Array') return -1
    const length: unknown = typedArrayByteLength.call(chunk)
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : -1
  } catch {
    return -1
  }
}

// Deterministic format/size failures are distinct from reader.read() rejecting with a transport error.
export class InvalidChatImageSourceError extends Error {}

export async function readBoundedLocalChatImageBlob(
  response: Response,
  options: { maxBytes: number; signal?: AbortSignal }
): Promise<Blob> {
  const { maxBytes, signal } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('Invalid image source limit.')
  const maxChunks = Math.max(MIN_SOURCE_CHUNKS, Math.ceil(maxBytes / MIN_AVERAGE_CHUNK_BYTES))

  const cancellation = (): Error => {
    const reason = signal?.reason
    if (reason instanceof Error) return reason
    const error = new Error(typeof reason === 'string' ? reason : 'Image source read was aborted.')
    error.name = 'AbortError'
    return error
  }
  const check = (): void => {
    if (signal?.aborted) throw cancellation()
  }
  check()
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new InvalidChatImageSourceError('Image source did not provide a readable body.')
  }

  const reader = response.body.getReader()
  let cancelled = false
  let completed = false
  const cancel = (): void => {
    if (cancelled || completed) return
    cancelled = true
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      /* best effort */
    }
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
      if (signal.aborted) {
        abortRead()
        return
      }
      try {
        reader.read().then(
          (result) => finish(() => resolve(result)),
          (error) => finish(() => reject(error))
        )
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  try {
    check()
    const parts: Uint8Array<ArrayBuffer>[] = []
    let segment: Uint8Array<ArrayBuffer> | null = null
    let segmentUsed = 0
    const flushSegment = (): void => {
      if (segment && segmentUsed) parts.push(segment.subarray(0, segmentUsed))
      segment = null
      segmentUsed = 0
    }
    let size = 0
    let chunkCount = 0
    while (true) {
      const result = await read()
      check()
      if (result.done) {
        completed = true
        break
      }
      if (++chunkCount > maxChunks)
        throw new InvalidChatImageSourceError('Image source exceeds the chunk limit.')
      const chunk = result.value
      const length = uint8ArrayChunkLength(chunk)
      if (length < 0)
        throw new InvalidChatImageSourceError('Image source returned an invalid chunk.')
      if (length > maxBytes - size)
        throw new InvalidChatImageSourceError('Image source exceeds the per-image byte limit.')
      if (!length) continue
      // Every accepted byte is copied into a buffer the reader owns.
      if (length >= SEGMENT_BYTES) {
        flushSegment()
        const owned = new Uint8Array(length)
        owned.set(chunk)
        parts.push(owned)
      } else {
        if (segment && SEGMENT_BYTES - segmentUsed < length) flushSegment()
        if (!segment) segment = new Uint8Array(SEGMENT_BYTES)
        segment.set(chunk, segmentUsed)
        segmentUsed += length
      }
      size += length
    }
    flushSegment()
    check()
    const blob = new Blob(parts, { type: mimeEssence(response.headers?.get('content-type')) })
    check()
    return blob
  } finally {
    cancel()
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* an uncooperative reader may remain pending */
    }
  }
}
