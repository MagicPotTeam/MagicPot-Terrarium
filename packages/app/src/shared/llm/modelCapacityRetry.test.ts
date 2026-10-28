import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  modelCapacityReason,
  normalizeModelRetryStatus,
  parseModelRetryAfter,
  retryModelCapacity
} from './modelCapacityRetry'
import type { LLMDeltaEvent } from './types'

const overloaded = () =>
  Object.assign(new Error('Our servers are currently overloaded. Please try again later.'), {
    code: 'server_overloaded'
  })
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('persistent model capacity retry', () => {
  it('continues beyond former finite budgets and emits bounded, content-free wait status', async () => {
    const events: LLMDeltaEvent[] = []
    let calls = 0
    const pending = retryModelCapacity({ onDelta: (e) => events.push(e) }, async () => {
      if (++calls <= 12) throw overloaded()
      return 'resumed'
    })
    for (let i = 0; i < 13; i++) await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toBe('resumed')
    expect(calls).toBe(13)
    const waits = events.filter((e) => e.type === 'retry' && e.retry!.delayMs > 0)
    expect(waits.map((e) => e.retry!.attempt)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(waits.every((e) => e.retry!.delayMs >= 2_000 && e.retry!.delayMs <= 60_000)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('Our servers')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors server retry-after and stops the backoff immediately on cancellation', async () => {
    const controller = new AbortController()
    const cause = new DOMException('User stopped', 'AbortError')
    const events: LLMDeltaEvent[] = []
    const op = vi.fn().mockRejectedValue(Object.assign(overloaded(), { retryAfterMs: 90_000 }))
    const pending = retryModelCapacity(
      { signal: controller.signal, onDelta: (e) => events.push(e) },
      op
    )
    const rejected = expect(pending).rejects.toBe(cause)
    await vi.advanceTimersByTimeAsync(1)
    expect(events[0].retry?.delayMs).toBe(90_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(op).toHaveBeenCalledOnce()
    controller.abort(cause)
    await rejected
    await vi.advanceTimersByTimeAsync(600_000)
    expect(op).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not spin on an expired or zero retry-after hint', async () => {
    const controller = new AbortController()
    const op = vi.fn().mockRejectedValue(Object.assign(overloaded(), { retryAfterMs: 0 }))
    const pending = retryModelCapacity({ signal: controller.signal }, op)
    const rejected = expect(pending).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1999)
    expect(op).toHaveBeenCalledOnce()
    controller.abort()
    await rejected
  })
  it('does not replay a partial answer or callback failure', async () => {
    const seen: LLMDeltaEvent[] = []
    const partial = vi.fn(async (emit) => {
      emit({ type: 'text-delta', delta: 'Already visible' })
      throw overloaded()
    })
    await expect(retryModelCapacity({ onDelta: (e) => seen.push(e) }, partial)).rejects.toThrow(
      'overloaded'
    )
    expect(partial).toHaveBeenCalledOnce()
    expect(seen.map((e) => e.type)).toEqual(['text-delta'])
    const callbackError = overloaded()
    const callback = vi.fn(async (emit) => {
      emit({ type: 'text-delta', delta: 'x' })
      return 'x'
    })
    await expect(
      retryModelCapacity(
        {
          onDelta: () => {
            throw callbackError
          }
        },
        callback
      )
    ).rejects.toBe(callbackError)
    expect(callback).toHaveBeenCalledOnce()
  })
  it('keeps failed-attempt session references out of the next request and visible history', async () => {
    const seen: LLMDeltaEvent[] = []
    let n = 0
    const pending = retryModelCapacity({ onDelta: (e) => seen.push(e) }, async (emit) => {
      emit?.({ type: 'session', sessionUrl: ++n === 1 ? 'failed-attempt' : 'successful-session' })
      if (n === 1) throw overloaded()
      emit?.({ type: 'text-delta', delta: 'ok' })
      return 'ok'
    })
    await vi.advanceTimersByTimeAsync(2000)
    await pending
    expect(seen.filter((e) => e.type === 'session').map((e) => e.sessionUrl)).toEqual([
      'successful-session'
    ])
  })
  it('does not leak a failed-attempt session when the retry has no replacement session', async () => {
    const seen: LLMDeltaEvent[] = []
    let calls = 0
    const pending = retryModelCapacity({ onDelta: (e) => seen.push(e) }, async (emit) => {
      if (++calls === 1) {
        emit?.({ type: 'session', sessionUrl: 'failed-attempt' })
        throw overloaded()
      }
      emit?.({ type: 'text-delta', delta: 'ok' })
      return 'ok'
    })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toBe('ok')
    expect(seen.filter((event) => event.type === 'session')).toEqual([])
  })
  it('keeps cancellation local to one call and never starts a pre-cancelled request', async () => {
    const a = new AbortController()
    const waiting = vi.fn().mockRejectedValue(overloaded())
    const p = retryModelCapacity({ signal: a.signal }, waiting)
    const check = expect(p).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    await expect(retryModelCapacity({}, async () => 'sibling ok')).resolves.toBe('sibling ok')
    a.abort()
    await check
    const never = vi.fn()
    await expect(retryModelCapacity({ signal: a.signal }, never)).rejects.toBeDefined()
    expect(never).not.toHaveBeenCalled()
    expect(waiting).toHaveBeenCalledOnce()
  })
  it.each([
    { statusCode: 401, message: 'server overloaded' },
    { statusCode: 403, code: 'server_overloaded' },
    {
      statusCode: 429,
      body: '{"error":{"code":"insufficient_quota","message":"Quota exhausted"}}'
    },
    { statusCode: 429, code: 'usage_limit_reached' },
    { code: 'content_policy_violation', message: 'model is at capacity' },
    { code: 'PATH_DENIED' },
    { name: 'AbortError', code: 'server_overloaded' },
    { name: 'TimeoutError', statusCode: 503 },
    { code: 'server_overloaded', partialContent: 'partial' },
    { code: 'server_overloaded', retryBlocked: true },
    { code: 'server_overloaded', partialResult: { attachments: [{ type: 'image' }] } },
    { message: 'unexpected EOF' }
  ])('does not retry permanent/ambiguous/partially executed failure %#', (error) => {
    expect(modelCapacityReason(error)).toBeUndefined()
  })
  it.each([
    { code: 'server_overloaded' },
    { statusCode: 503 },
    { message: 'Selected model is at capacity. Please try a different model.' },
    { providerError: { type: 'overloaded_error' } }
  ])('recognizes actual capacity failure %#', (error) =>
    expect(modelCapacityReason(error)).toBe('server-overloaded')
  )
  it('recognizes transient 429 without confusing it with account quota', () => {
    expect(modelCapacityReason({ statusCode: 429 })).toBe('rate-limited')
    expect(parseModelRetryAfter(new Headers({ 'retry-after': '12' }))).toBe(12000)
    expect(parseModelRetryAfter(new Headers({ 'retry-after-ms': '1250' }))).toBe(1250)
    expect(parseModelRetryAfter(new Headers({ 'retry-after': 'garbage' }))).toBeUndefined()
    expect(
      parseModelRetryAfter(
        new Headers({ 'retry-after': new Date(Date.now() + 30_000).toUTCString() })
      )
    ).toBeGreaterThan(29000)
  })
  it('validates and strips extra metadata at event boundaries', () => {
    const valid = {
      attempt: 5,
      delayMs: 2000,
      nextRetryAt: Date.now() + 2000,
      reason: 'server-overloaded' as const
    }
    expect(normalizeModelRetryStatus({ ...valid, secret: 'not UI data' })).toEqual(valid)
    for (const invalid of [
      { ...valid, delayMs: -1 },
      { ...valid, nextRetryAt: Infinity },
      { ...valid, attempt: 0 },
      { ...valid, reason: 'arbitrary' }
    ])
      expect(normalizeModelRetryStatus(invalid)).toBeUndefined()
  })
})

const processingErrorMessage =
  'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 47ea0bfe-e93a-4fdc-adf0-80388e3c427a in your message.'

describe('persistent provider processing-error retry', () => {
  it.each([
    new Error(processingErrorMessage),
    { providerError: { message: processingErrorMessage } },
    { providerError: { type: 'server_error', code: null, message: 'Try later' } },
    { providerError: { code: 'internal_error' } },
    { providerError: { code: 'internal_server_error' } },
    { statusCode: 500, body: JSON.stringify({ error: { message: processingErrorMessage } }) },
    { statusCode: 500, body: 'Internal Server Error' }
  ])('recognizes transient processing failure %# without depending on a request ID', (error) => {
    expect(modelCapacityReason(error)).toBe('server-error')
  })

  it.each([
    { statusCode: 401, message: processingErrorMessage },
    { statusCode: 403, providerError: { type: 'server_error' } },
    { statusCode: 400, message: processingErrorMessage },
    { providerError: { code: 'insufficient_quota', message: processingErrorMessage } },
    {
      providerError: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: processingErrorMessage
      }
    },
    { providerError: { code: 'content_policy_violation', message: processingErrorMessage } },
    { message: processingErrorMessage, partialContent: 'already visible' },
    { message: processingErrorMessage, retryBlocked: true },
    { message: 'Unexpected failure while processing a local document' }
  ])('never broadens terminal or unsafe failures into server retries %#', (error) => {
    expect(modelCapacityReason(error)).toBeUndefined()
  })

  it('retries the reported message beyond three failures and preserves content-free status', async () => {
    let calls = 0
    const events: LLMDeltaEvent[] = []
    const pending = retryModelCapacity({ onDelta: (event) => events.push(event) }, async () => {
      if (++calls <= 5) throw new Error(processingErrorMessage)
      return 'recovered'
    })
    // Attach rejection handling before advancing timers so a regression is a normal failed assertion.
    const result = pending.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message })
    )
    for (let attempt = 0; attempt < 6; attempt++) await vi.advanceTimersByTimeAsync(60000)
    expect(await result).toEqual({ value: 'recovered' })
    expect(calls).toBe(6)
    expect(
      events.filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
    ).toHaveLength(5)
    expect(events.every((event) => event.retry?.reason === 'server-error')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('47ea0bfe')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an internal-error wait without issuing another request', async () => {
    const controller = new AbortController()
    const operation = vi.fn().mockRejectedValue(new Error(processingErrorMessage))
    const events: LLMDeltaEvent[] = []
    const pending = retryModelCapacity(
      { signal: controller.signal, onDelta: (event) => events.push(event) },
      operation
    )
    const result = pending.then(
      () => 'unexpected success',
      (error: Error) => error.name
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(events[0]?.type).toBe('retry')
    controller.abort()
    expect(await result).toBe('AbortError')
    await vi.advanceTimersByTimeAsync(300000)
    expect(operation).toHaveBeenCalledOnce()
  })

  it('accepts only the explicit new reason at the IPC progress boundary', () => {
    const status = {
      attempt: 1,
      delayMs: 2000,
      nextRetryAt: Date.now() + 2000,
      reason: 'server-error'
    }
    expect(normalizeModelRetryStatus(status)).toEqual(status)
  })
})
