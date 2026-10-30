import type { FetchImpl } from './clients'
import { normalizeModelConnectionError } from './modelConnectionError'

export const OPENAI_CHAT_DEADLINE_MS = 120_000
// Interactive reasoning may be silent for minutes. Bound inactivity, not a whole live turn.
export const OPENAI_INTERACTIVE_IDLE_TIMEOUT_MS = 600_000
export class ModelRequestTimeoutError extends Error {
  readonly code = 'MODEL_REQUEST_TIMEOUT'
  constructor(message = 'OpenAI request deadline exceeded.') {
    super(message)
    this.name = 'TimeoutError'
  }
}
export const OPENAI_IMAGE_DEADLINE_MS = 600_000
export const OPENAI_MAX_DEADLINE_MS = 900_000
export const OPENAI_JSON_MAX_BYTES = 64 * 1024 * 1024
export const OPENAI_IMAGE_JSON_MAX_BYTES = 128 * 1024 * 1024
export const OPENAI_ERROR_MAX_BYTES = 64 * 1024

// Non-OpenAI providers use the same bounded request lifecycle. Keep the
// OpenAI-named constants as compatibility aliases for existing callers.
export const PROVIDER_CHAT_DEADLINE_MS = OPENAI_CHAT_DEADLINE_MS
export const PROVIDER_MAX_DEADLINE_MS = OPENAI_MAX_DEADLINE_MS
export const PROVIDER_JSON_MAX_BYTES = OPENAI_JSON_MAX_BYTES
export const PROVIDER_ERROR_MAX_BYTES = OPENAI_ERROR_MAX_BYTES

const cancelBody = (response: Response): void => {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    /* best effort */
  }
}
const cancellationReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The request was cancelled.')
  error.name = 'AbortError'
  return error
}

/** Per-call control, never stored on the client: concurrent chats have separate lifetimes. */
export class ProviderRequestControl {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private expiresAt: number
  private timer: ReturnType<typeof setTimeout>
  private readonly duration: number
  private readonly responses = new Set<Response>()
  private readonly readers = new Set<() => void>()
  private readonly parentAbort: () => void
  private disposed = false

  constructor(
    private readonly fetchImpl: FetchImpl,
    private readonly parent?: AbortSignal,
    timeoutMs = PROVIDER_CHAT_DEADLINE_MS,
    private readonly options: { idleTimeout?: boolean; retryConnectionErrors?: boolean } = {},
    private readonly providerName = 'Provider'
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`${providerName} request deadline must be a positive finite number.`)
    }
    const duration = Math.min(PROVIDER_MAX_DEADLINE_MS, Math.max(1_000, timeoutMs))
    this.duration = duration
    this.expiresAt = performance.now() + duration
    this.parentAbort = () => this.abort(cancellationReason(parent!))
    this.timer = setTimeout(() => this.timeout(), duration)
    if (parent?.aborted) this.parentAbort()
    else parent?.addEventListener('abort', this.parentAbort, { once: true })
  }

  private abort(reason: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason)
    for (const cancel of this.readers) cancel()
    for (const response of this.responses) cancelBody(response)
  }
  private timeout(): void {
    this.abort(new ModelRequestTimeoutError(`${this.providerName} request deadline exceeded.`))
  }
  /** Only actual response progress resets an interactive wait, never polling or UI activity. */
  noteProgress(): void {
    this.check()
    if (!this.options.idleTimeout) return
    clearTimeout(this.timer)
    this.expiresAt = performance.now() + this.duration
    this.timer = setTimeout(() => this.timeout(), this.duration)
  }
  check(): void {
    // Also check the monotonic clock: already-resolved promises must not starve the timer.
    if (!this.signal.aborted && performance.now() >= this.expiresAt) this.timeout()
    if (this.signal.aborted) throw cancellationReason(this.signal)
    if (this.disposed) throw new Error(`${this.providerName} request has already finished.`)
  }

  wait<T>(promise: Promise<T>, onCancel?: () => void): Promise<T> {
    const safelyCancel = () => {
      try {
        onCancel?.()
      } catch {
        /* preserve the cause */
      }
    }
    try {
      this.check()
    } catch (error) {
      void promise.catch(() => undefined)
      safelyCancel()
      return Promise.reject(error)
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        this.signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = () => {
        finish(() => reject(cancellationReason(this.signal)))
        safelyCancel()
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          try {
            this.check()
            finish(() => resolve(value))
          } catch (error) {
            finish(() => reject(error))
            safelyCancel()
          }
        },
        (error) => finish(() => reject(error))
      )
    })
  }

  private rethrowTransportError = (error: unknown): never => {
    throw this.options.retryConnectionErrors ? normalizeModelConnectionError(error) : error
  }

  /** Callers pass the same operation signal; shorter hosted-file setup has its own control. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.check()
    const request = Promise.resolve()
      .then(() => {
        this.check()
        return this.fetchImpl(input, { ...init, signal: this.signal })
      })
      .catch(this.rethrowTransportError)
      .then((response) => {
        if (this.signal.aborted || this.disposed) cancelBody(response)
        else {
          this.responses.add(response)
          this.noteProgress()
        }
        return response
      })
    return this.wait(request)
  }

  async *chunks(response: Response, maxBytes: number): AsyncGenerator<Uint8Array> {
    this.check()
    const body = response.body
    if (!body) throw new Error('OpenAI response has no readable body.')
    const reader = body.getReader()
    let cancelled = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      try {
        void reader.cancel().catch(() => undefined)
      } catch {
        /* best effort */
      }
    }
    this.readers.add(cancel)
    let total = 0
    try {
      while (true) {
        this.check()
        const result = await this.wait(reader.read().catch(this.rethrowTransportError), cancel)
        if (result.done) return
        if (result.value.byteLength > maxBytes - total) {
          throw new Error(`${this.providerName} response body exceeds the ${maxBytes}-byte limit.`)
        }
        total += result.value.byteLength
        if (result.value.byteLength > 0) this.noteProgress()
        yield result.value
      }
    } finally {
      cancel()
      this.readers.delete(cancel)
      this.responses.delete(response)
      try {
        reader.releaseLock()
      } catch {
        /* cleanup cannot mask failure */
      }
    }
  }

  async text(response: Response, maxBytes: number, truncate = false): Promise<string> {
    if (!response.body) {
      const text = await this.wait(response.text().catch(this.rethrowTransportError), () =>
        cancelBody(response)
      )
      const bytes = new TextEncoder().encode(text)
      if (bytes.byteLength > maxBytes && !truncate)
        throw new Error(`${this.providerName} response body exceeds the ${maxBytes}-byte limit.`)
      const result = new TextDecoder().decode(bytes.subarray(0, maxBytes))
      this.check()
      return result
    }
    const decoder = new TextDecoder()
    let text = '',
      total = 0
    // Error bodies return a bounded prefix while retaining the authoritative HTTP status.
    for await (const bytes of this.chunks(
      response,
      truncate ? Number.MAX_SAFE_INTEGER : maxBytes
    )) {
      const count = Math.min(bytes.byteLength, maxBytes - total)
      text += decoder.decode(bytes.subarray(0, count), { stream: true })
      total += count
      if (truncate && total === maxBytes) break
    }
    const result = text + decoder.decode()
    this.check()
    return result
  }

  async json(response: Response, maxBytes = OPENAI_JSON_MAX_BYTES): Promise<unknown> {
    if (!response.body) {
      // Compatibility for injected/native adapters without a WHATWG stream; cannot
      // prevent their internal allocation, but still enforces time and result size.
      const payload = await this.wait(response.json().catch(this.rethrowTransportError), () =>
        cancelBody(response)
      )
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxBytes) {
        throw new Error(`${this.providerName} response body exceeds the ${maxBytes}-byte limit.`)
      }
      this.check()
      return payload
    }
    const text = await this.text(response, maxBytes)
    this.check()
    const payload: unknown = JSON.parse(text)
    this.check()
    return payload
  }

  async blob(response: Response, maxBytes: number): Promise<Blob> {
    if (!response.body) {
      const blob = await this.wait(response.blob(), () => cancelBody(response))
      if (blob.size > maxBytes)
        throw new Error(`${this.providerName} response body exceeds the ${maxBytes}-byte limit.`)
      this.check()
      return blob
    }
    const chunks: ArrayBuffer[] = []
    for await (const bytes of this.chunks(response, maxBytes)) {
      const owned = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(owned).set(bytes)
      chunks.push(owned)
    }
    const blob = new Blob(chunks, { type: response.headers?.get('content-type') || '' })
    this.check()
    return blob
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new Error(`${this.providerName} request control was disposed.`)
    error.name = 'AbortError'
    // Settle outstanding waiters before disabling their deadline/parent signal.
    // Already-established caller/timeout reasons remain authoritative.
    this.abort(error)
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.parentAbort)
    this.responses.clear()
    this.readers.clear()
  }
}

/** OpenAI compatibility wrapper retained for existing imports and tests. */
export class OpenAIRequestControl extends ProviderRequestControl {
  constructor(
    fetchImpl: FetchImpl,
    parent?: AbortSignal,
    timeoutMs = OPENAI_CHAT_DEADLINE_MS,
    options: { idleTimeout?: boolean; retryConnectionErrors?: boolean } = {}
  ) {
    super(fetchImpl, parent, timeoutMs, options, 'OpenAI')
  }
}
