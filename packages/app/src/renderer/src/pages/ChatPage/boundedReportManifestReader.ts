/**
 * An unwired, per-operation manifest stream reader. The caller must authorize
 * every URL and provide a trusted fetcher; this module grants no file, network,
 * window or conversation access. It does not bound producer prefetch, JSON
 * parsing/entry expansion, other request data or actual renderer memory peaks.
 * A failed accepted read poisons the operation; partial text is never returned.
 */
type ManifestReaderOptions = {
  perManifestBytes: number
  totalBytes: number
  maxManifests: number
  maxChunksPerManifest: number
  fetchResponse: (url: string, signal?: AbortSignal) => Promise<Response>
  signal?: AbortSignal
}

const MAX_PER_MANIFEST_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_MANIFESTS = 128
const MAX_CHUNKS_PER_MANIFEST = 8192

type ManifestReaderErrorCode =
  | 'MANIFEST_INVALID_OPTIONS'
  | 'MANIFEST_BUSY'
  | 'MANIFEST_FAILED'
  | 'MANIFEST_COUNT_LIMIT'
  | 'MANIFEST_BYTE_LIMIT'
  | 'MANIFEST_TOTAL_BYTE_LIMIT'
  | 'MANIFEST_CHUNK_LIMIT'
  | 'MANIFEST_INVALID_UTF8'
  | 'MANIFEST_INVALID_RESPONSE'
  | 'MANIFEST_IO_ERROR'

const ownErrors = new WeakSet<Error>()
const unavailable = (code: ManifestReaderErrorCode): Error & { code: ManifestReaderErrorCode } => {
  const error = Object.assign(new Error('Unable to read report manifest.'), { code })
  ownErrors.add(error)
  return error
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason
  const tag = Object.prototype.toString.call(reason)
  if (reason instanceof Error || tag === '[object Error]' || tag === '[object DOMException]') {
    return reason as Error
  }
  const error = new Error(
    typeof reason === 'string' ? reason : 'Report manifest reading was aborted.'
  )
  error.name = 'AbortError'
  return error
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function awaitAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void =>
      finish(() => {
        try {
          onAbort?.()
        } catch {
          /* Best effort only; still settle the caller. */
        }
        reject(abortReason(signal))
      })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

function discardResponse(response: Response): void {
  try {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
  } catch {
    // Producer cleanup is best effort and is not evidence of resource release.
  }
}

/**
 * All limits are caller-selected positive safe integers bounded by the constants
 * above. Budgets apply to actual chunks observed by this reader across accepted,
 * sequential calls. Overlapping calls are rejected without starting a fetch.
 */
export function createBoundedReportManifestReader(
  options: ManifestReaderOptions
): (url: string) => Promise<string> {
  const {
    perManifestBytes,
    totalBytes,
    maxManifests,
    maxChunksPerManifest,
    fetchResponse,
    signal
  } = options
  const valid = (value: number, max: number): boolean =>
    Number.isSafeInteger(value) && value > 0 && value <= max
  if (
    !valid(perManifestBytes, MAX_PER_MANIFEST_BYTES) ||
    !valid(totalBytes, MAX_TOTAL_BYTES) ||
    !valid(maxManifests, MAX_MANIFESTS) ||
    !valid(maxChunksPerManifest, MAX_CHUNKS_PER_MANIFEST) ||
    typeof fetchResponse !== 'function'
  )
    throw unavailable('MANIFEST_INVALID_OPTIONS')

  let bytesUsed = 0
  let manifestsStarted = 0
  let busy = false
  let failed = false

  return async (url: string): Promise<string> => {
    checkAbort(signal)
    // Rejecting an overlapping caller does not disturb the accepted operation.
    if (busy) throw unavailable('MANIFEST_BUSY')
    if (failed) throw unavailable('MANIFEST_FAILED')
    if (manifestsStarted >= maxManifests) throw unavailable('MANIFEST_COUNT_LIMIT')
    if (bytesUsed >= totalBytes) throw unavailable('MANIFEST_TOTAL_BYTE_LIMIT')
    if (typeof url !== 'string' || !url) throw unavailable('MANIFEST_INVALID_OPTIONS')
    busy = true
    manifestsStarted += 1
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let completed = false
    let cancelled = false
    const cancelReader = (): void => {
      if (!reader || completed || cancelled) return
      cancelled = true
      try {
        void reader.cancel().catch(() => undefined)
      } catch {
        /* Best effort only. */
      }
    }

    try {
      // If an uncooperative fetch returns after an abort, its body must not be
      // consumed or retained by this operation. Cancellation is best effort.
      const fetching = Promise.resolve().then(() => {
        checkAbort(signal)
        return fetchResponse(url, signal)
      })
      void fetching.then(
        (late) => {
          if (signal?.aborted) discardResponse(late)
        },
        () => undefined
      )
      response = await awaitAbortable(fetching, signal)
      checkAbort(signal)
      if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
        throw unavailable('MANIFEST_INVALID_RESPONSE')
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const parts: string[] = []
      let manifestBytes = 0
      let chunks = 0
      while (true) {
        checkAbort(signal)
        const item = await awaitAbortable(reader.read(), signal, cancelReader)
        checkAbort(signal)
        if (item.done) {
          completed = true
          break
        }
        chunks += 1
        if (chunks > maxChunksPerManifest) throw unavailable('MANIFEST_CHUNK_LIMIT')
        if (!(item.value instanceof Uint8Array)) throw unavailable('MANIFEST_INVALID_RESPONSE')
        const size = item.value.byteLength
        if (size > perManifestBytes - manifestBytes) throw unavailable('MANIFEST_BYTE_LIMIT')
        if (size > totalBytes - bytesUsed) throw unavailable('MANIFEST_TOTAL_BYTE_LIMIT')
        // TextDecoder consumes the view synchronously, before a subsequent read
        // could reuse/mutate it. Never retain producer-owned chunk references.
        manifestBytes += size
        bytesUsed += size
        try {
          parts.push(decoder.decode(item.value, { stream: true }))
        } catch {
          throw unavailable('MANIFEST_INVALID_UTF8')
        }
      }
      try {
        parts.push(decoder.decode())
      } catch {
        throw unavailable('MANIFEST_INVALID_UTF8')
      }
      checkAbort(signal)
      return parts.join('')
    } catch (error) {
      failed = true
      checkAbort(signal)
      if (error instanceof Error && ownErrors.has(error)) throw error
      throw unavailable('MANIFEST_IO_ERROR')
    } finally {
      if (reader) {
        cancelReader()
        try {
          reader.releaseLock()
        } catch {
          /* A producer may leave a read pending. */
        }
      } else if (response) {
        discardResponse(response)
      }
      busy = false
    }
  }
}
