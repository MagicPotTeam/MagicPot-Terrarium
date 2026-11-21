/**
 * Retries of a canvas image load that failed while main could not answer for it.
 *
 * Main answers a `local-media:` request with 503 when it could not check the path in time: the
 * drive did not answer, or its per-image breaker held the request back while another place had
 * stalled or its queue was full. That passes, so such an image is loaded again a few times,
 * later each time, instead of staying broken for the session. A refusal (403) or a missing file
 * (404) is never retried, nor is any other kind of source.
 */
export const CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 8_000, 30_000]

/** Whether a load of `src` that just failed may succeed later. */
export type CanvasImageLoadRetryProbe = (src: string) => Promise<boolean>

/**
 * Asks main again, without reading the image: a 503 means "not now", and a success means the
 * failure has passed already (the breaker let it through since). Anything else is final.
 */
export const probeCanvasImageLoadRetry: CanvasImageLoadRetryProbe = async (src) => {
  if (!/^local-media:/iu.test(src)) return false
  try {
    const response = await fetch(src, { method: 'HEAD', cache: 'no-store' })
    return response.status === 503 || response.ok
  } catch {
    return false
  }
}

type RetryEntry = {
  src: string
  /** Retries scheduled so far for this source. */
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

export class CanvasImageLoadRetries {
  private readonly entries = new Map<string, RetryEntry>()

  constructor(
    /** Called when the item should load `src` again. */
    private readonly retry: (itemId: string, src: string) => void,
    private readonly options: {
      probe?: CanvasImageLoadRetryProbe
      delaysMs?: readonly number[]
    } = {}
  ) {}

  /**
   * A load of `src` for the item failed: asks whether it may load later and, if so, schedules
   * the next retry. After the last delay the item stays failed until its source changes.
   */
  noteFailure(itemId: string, src: string): void {
    if (!src) return
    const delays = this.options.delaysMs ?? CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS
    const previous = this.entries.get(itemId)
    if (previous?.timer) clearTimeout(previous.timer)
    const attempts = previous?.src === src ? previous.attempts : 0
    const entry: RetryEntry = { src, attempts, timer: null }
    this.entries.set(itemId, entry)
    if (attempts >= delays.length) return
    entry.attempts += 1
    const probe = this.options.probe ?? probeCanvasImageLoadRetry
    void probe(src).then(
      (retryable) => {
        if (!retryable || this.entries.get(itemId) !== entry) return
        entry.timer = setTimeout(() => {
          entry.timer = null
          if (this.entries.get(itemId) === entry) this.retry(itemId, src)
        }, delays[attempts])
      },
      () => undefined
    )
  }

  /** The item loaded, or left the board: its next failure starts over. */
  forget(itemId: string): void {
    const entry = this.entries.get(itemId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(itemId)
  }

  /** Forgets every item that is not in `itemIds`. */
  retain(itemIds: ReadonlySet<string>): void {
    for (const itemId of Array.from(this.entries.keys())) {
      if (!itemIds.has(itemId)) this.forget(itemId)
    }
  }

  /** Cancels every pending retry (the layer unmounts); later failures are noted afresh. */
  dispose(): void {
    for (const itemId of Array.from(this.entries.keys())) this.forget(itemId)
  }
}
