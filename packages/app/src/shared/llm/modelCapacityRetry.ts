import type { LLMChatParams, LLMDeltaEvent } from './types'

export type LLMRetryStatus = {
  attempt: number
  delayMs: number
  nextRetryAt: number
  reason: 'server-overloaded' | 'rate-limited' | 'server-error'
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/** Parse server advice without shortening it to our local backoff cap. */
export function parseModelRetryAfter(
  headers?: Pick<Headers, 'get'>,
  now = Date.now()
): number | undefined {
  const milliseconds = headers?.get('retry-after-ms')
  if (
    milliseconds !== null &&
    milliseconds !== undefined &&
    /^\d+(?:\.\d+)?$/.test(milliseconds.trim())
  ) {
    const value = Number(milliseconds)
    if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - now) return value
  }
  const raw = headers?.get('retry-after')?.trim()
  if (!raw) return undefined
  const delay = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now
  return Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER - now
    ? delay
    : undefined
}

/** Transport-owned errors only. Authentication, quota and policy failures are terminal. */
export function modelCapacityReason(error: unknown): LLMRetryStatus['reason'] | undefined {
  const item = record(error)
  if (
    !item ||
    item.retryBlocked === true ||
    item.name === 'AbortError' ||
    item.name === 'TimeoutError'
  )
    return undefined
  const status = Number(item.statusCode ?? item.status)
  let body: Record<string, unknown> | undefined
  if (typeof item.body === 'string') {
    try {
      body = record(JSON.parse(item.body.slice(0, 65536)))
    } catch {
      /* plain upstream text */
    }
  }
  const nested = record(body?.error) ?? record(item.providerError) ?? record(item.error) ?? body
  const code = String(nested?.code ?? item.code ?? '').toLowerCase()
  const type = String(nested?.type ?? item.type ?? '').toLowerCase()
  const message = [item.message, nested?.message, item.body]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .slice(0, 131072)
  if (
    [400, 401, 403, 404, 409, 413, 422].includes(status) ||
    /insufficient_quota|quota_exceeded|usage_limit|billing|payment_required|invalid_api_key|authentication|permission|content_policy|content_filter|safety|context_length_exceeded/.test(
      `${code} ${type}`
    ) ||
    /insufficient quota|exceeded (?:your |the )?(?:quota|usage limit)|billing|invalid api key/i.test(
      message
    )
  )
    return undefined
  const partial = record(item.partialResult)
  if (
    (typeof item.partialContent === 'string' && item.partialContent.length > 0) ||
    (typeof partial?.content === 'string' && partial.content.length > 0) ||
    (Array.isArray(partial?.attachments) && partial.attachments.length > 0)
  )
    return undefined
  if (
    /^(?:server_overloaded|overloaded_error|model_overloaded|model_at_capacity|capacity_exceeded)$/.test(
      code
    ) ||
    /^(?:server_overloaded|overloaded_error)$/.test(type) ||
    /\b(?:servers? (?:are |is )?(?:currently )?overloaded|server overloaded|selected model is at capacity|model is (?:currently )?at capacity)\b/i.test(
      message
    ) ||
    status === 503
  )
    return 'server-overloaded'
  if (
    status === 429 ||
    /^(?:rate_limit_exceeded|rate_limit_error|too_many_requests)$/.test(code) ||
    type === 'rate_limit_error'
  )
    return 'rate-limited'
  // Explicit provider processing failures are transient too. Do not key on a
  // request ID (which changes each time), or treat arbitrary local failures as retryable.
  if (
    status === 500 ||
    /^(?:server_error|internal_error|internal_server_error)$/.test(code) ||
    /^(?:server_error|internal_error|internal_server_error)$/.test(type) ||
    /\ban error occurred while processing your request\.\s+you can retry your request\b/i.test(
      message
    )
  )
    return 'server-error'
  return undefined
}

export function normalizeModelRetryStatus(value: unknown): LLMRetryStatus | undefined {
  const v = record(value)
  if (
    !v ||
    !Number.isSafeInteger(v.attempt) ||
    Number(v.attempt) < 1 ||
    typeof v.delayMs !== 'number' ||
    !Number.isFinite(v.delayMs) ||
    v.delayMs < 0 ||
    typeof v.nextRetryAt !== 'number' ||
    !Number.isFinite(v.nextRetryAt) ||
    v.nextRetryAt < 0 ||
    (v.reason !== 'server-overloaded' && v.reason !== 'rate-limited' && v.reason !== 'server-error')
  )
    return undefined
  return {
    attempt: Number(v.attempt),
    delayMs: v.delayMs,
    nextRetryAt: v.nextRetryAt,
    reason: v.reason
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('The request was cancelled.', 'AbortError')
}

/** Chunk long server delays so JS timer overflow cannot turn them into rapid retries. */
async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  let remaining = delay
  while (remaining > 0) {
    checkCancelled(signal)
    const duration = Math.min(remaining, 60_000)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, duration)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    remaining -= duration
  }
  checkCancelled(signal)
}

/** Retry ONE model sampling operation, never the Agent turn or its already executed tools.
 * No attempt cap for explicit overload, rate-limit or server-processing errors.
 * Partial output or observed hosted tool execution is not replay-safe.
 * The caller owns a stable request body/idempotency key and any temporary remote resources.
 */
export async function retryModelCapacity<T>(
  params: Pick<LLMChatParams, 'signal' | 'onDelta'>,
  operation: (onDelta: LLMChatParams['onDelta']) => Promise<T>
): Promise<T> {
  let attempt = 0
  for (;;) {
    checkCancelled(params.signal)
    let outputStarted = false
    let callbackFailed = false
    let pendingSession: LLMDeltaEvent | undefined
    const emit = (event: LLMDeltaEvent) => {
      checkCancelled(params.signal)
      try {
        params.onDelta?.(event)
      } catch (error) {
        callbackFailed = true
        throw error
      }
    }
    const observe = (event: LLMDeltaEvent) => {
      if (event.type === 'session') {
        pendingSession = event
        return
      }
      if (
        (event.type === 'text-delta' && Boolean(event.delta)) ||
        event.type === 'attachment' ||
        event.type === 'tool-status'
      ) {
        outputStarted = true
        if (pendingSession) {
          emit(pendingSession)
          pendingSession = undefined
        }
      }
      emit(event)
    }
    try {
      const result = await operation(params.onDelta ? observe : undefined)
      checkCancelled(params.signal)
      if (pendingSession) emit(pendingSession)
      return result
    } catch (error) {
      if (params.signal?.aborted) checkCancelled(params.signal)
      const reason = modelCapacityReason(error)
      if (!reason || outputStarted || callbackFailed) throw error
      attempt = Math.min(Number.MAX_SAFE_INTEGER, attempt + 1)
      const localDelay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 6))
      const jittered = Math.min(
        60_000,
        Math.max(1_000, Math.round(localDelay * (0.9 + Math.random() * 0.2)))
      )
      const advice = record(error)?.retryAfterMs
      const delayMs =
        typeof advice === 'number' && Number.isFinite(advice) && advice >= 0
          ? Math.max(jittered, advice)
          : jittered
      emit({
        type: 'retry',
        retry: { attempt, delayMs, nextRetryAt: Date.now() + delayMs, reason }
      })
      await waitForRetry(delayMs, params.signal)
      emit({ type: 'retry', retry: { attempt, delayMs: 0, nextRetryAt: Date.now(), reason } })
    }
  }
}
