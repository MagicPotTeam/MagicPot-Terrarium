/**
 * Reject a canvas decode at the deadline while still disposing a late result.
 * Browser image decoders may ignore AbortSignal and settle much later.
 */
export function withProjectCanvasWebGLTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let settled = false
  let timedOut = false
  const timeoutError = new Error(message)

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      timedOut = true
      try {
        onTimeout?.()
      } catch {
        // The timeout result is authoritative even if cancellation reporting fails.
      } finally {
        settled = true
        window.clearTimeout(timeoutId)
        reject(timeoutError)
      }
    }, timeoutMs)

    promise.then(
      (value) => {
        if (settled) {
          closeLateCanvasAsset(value)
          return
        }

        settled = true
        window.clearTimeout(timeoutId)
        if (timedOut) {
          closeLateCanvasAsset(value)
          reject(timeoutError)
          return
        }
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        reject(timedOut ? timeoutError : error)
      }
    )
  })
}

function closeLateCanvasAsset(value: unknown): void {
  if (typeof (value as { close?: unknown } | null | undefined)?.close === 'function') {
    ;(value as { close: () => void }).close()
  }
}
