/** A transport-owned failure, not text from a model, tool or HTTP error body. */
export class ModelConnectionError extends Error {
  readonly code = 'MODEL_CONNECTION_ERROR'

  constructor(message: string, cause: Error) {
    super(message, { cause })
    this.name = 'ModelConnectionError'
  }
}

const TRANSIENT_CODES = new Set([
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_EMPTY_RESPONSE',
  'ERR_NETWORK_CHANGED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET'
])

/** Called only at opted-in model fetch/body-read boundaries. Never inspect provider prose. */
export function normalizeModelConnectionError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ModelConnectionError) return error
  const seen = new Set<object>()
  let current: unknown = error
  let matched = false
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    if (!current || typeof current !== 'object' || seen.has(current)) return error
    seen.add(current)
    const item = current as Record<string, unknown>
    // A real HTTP response, cancellation, policy failure or partial result takes precedence.
    if (
      item.name === 'AbortError' ||
      item.name === 'TimeoutError' ||
      item.retryBlocked === true ||
      item.status !== undefined ||
      item.statusCode !== undefined ||
      item.body !== undefined ||
      item.providerError !== undefined ||
      item.partialContent ||
      item.partialResult
    )
      return error
    const code = typeof item.code === 'string' ? item.code.toUpperCase() : ''
    if (/CERT|TLS|SSL|DENIED|FORBIDDEN|POLICY|AUTH/.test(code)) return error
    const message = typeof item.message === 'string' ? item.message.trim() : ''
    const chromiumCode = /^net::(ERR_[A-Z_]+)$/.exec(message)?.[1]
    if (TRANSIENT_CODES.has(code) || (chromiumCode && TRANSIENT_CODES.has(chromiumCode)))
      matched = true
    current = item.cause
  }
  // Do not traverse unbounded causes or let a shallow match hide a deeper rejection.
  return matched && current === undefined ? new ModelConnectionError(error.message, error) : error
}
