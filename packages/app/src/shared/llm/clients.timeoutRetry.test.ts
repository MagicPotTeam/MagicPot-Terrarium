import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMDeltaEvent } from './types'
import { modelCapacityReason, normalizeModelRetryStatus } from './modelCapacityRetry'

const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
const completed = {
  type: 'response.completed',
  response: {
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }
    ]
  }
}
const success = () =>
  new Response(frame(completed), { headers: { 'content-type': 'text/event-stream' } })
const makeClient = (fetchImpl: typeof fetch, requestTimeoutMs?: number) =>
  new OpenAIAPICli('owned', 'https://owned.test/v1', 'owned-model', {
    apiMode: 'responses',
    enableHostedTools: false,
    fetchImpl,
    requestTimeoutMs
  })
function stalled(initial?: unknown) {
  const cancel = vi.fn()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        if (initial) c.enqueue(frame(initial))
      },
      cancel
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
  return { response, cancel, push: (value: unknown) => controller.enqueue(frame(value)) }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('interactive request timeout recovery', () => {
  it.each([408, 504])('retries an HTTP %i timeout with unchanged input', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"owned request timeout"}}', { status })
      )
      .mockImplementation(async () => success())
    const events: LLMDeltaEvent[] = []
    const task = makeClient(fetcher, 1000).chat({
      messages: [{ role: 'user', content: 'same original question' }],
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    const observed = task.then(
      (v) => ({ value: v.content }),
      (e) => ({ error: String(e) })
    )
    await vi.advanceTimersByTimeAsync(2001)
    expect(await observed).toEqual({ value: 'recovered' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1]!.body).toBe(fetcher.mock.calls[1][1]!.body)
    expect(events.some((e) => e.type === 'retry' && e.retry?.reason === 'request-timeout')).toBe(
      true
    )
  })

  it('recognizes only the internal tagged timeout, never a generic tool timeout', () => {
    expect(
      modelCapacityReason({
        name: 'TimeoutError',
        code: 'MODEL_REQUEST_TIMEOUT',
        message: 'OpenAI request deadline exceeded.'
      })
    ).toBe('request-timeout')
    expect(
      modelCapacityReason({ name: 'TimeoutError', message: 'local command timed out' })
    ).toBeUndefined()
    expect(
      modelCapacityReason({
        name: 'TimeoutError',
        code: 'MODEL_REQUEST_TIMEOUT',
        retryBlocked: true
      })
    ).toBeUndefined()
    expect(
      normalizeModelRetryStatus({
        attempt: 1,
        delayMs: 2000,
        nextRetryAt: Date.now() + 2000,
        reason: 'request-timeout'
      })
    ).toMatchObject({ reason: 'request-timeout' })
  })
  it('retries real pre-header deadlines beyond three attempts with stable input/key and aborts each old attempt', async () => {
    const events: LLMDeltaEvent[] = []
    const signals: AbortSignal[] = []
    let calls = 0
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signals.push(init!.signal as AbortSignal)
      if (++calls <= 4)
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        )
      return success()
    })
    const messages = [
      { role: 'user' as const, content: 'original' },
      { role: 'assistant' as const, content: '[Tool Result] saved document contents' },
      { role: 'user' as const, content: 'summarize' }
    ]
    const before = structuredClone(messages)
    const task = makeClient(fetcher, 1000).chat({
      messages,
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    const observed = task.then(
      (v) => ({ value: v.content }),
      (e) => ({ error: String(e) })
    )
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60000)
    expect(await observed).toEqual({ value: 'recovered' })
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(signals.slice(0, 4).every((signal) => signal.aborted)).toBe(true)
    expect(new Set(fetcher.mock.calls.map((c) => c[1]!.body)).size).toBe(1)
    const keys = fetcher.mock.calls.map((c) => new Headers(c[1]!.headers).get('Idempotency-Key'))
    expect(keys[0]).toBeTruthy()
    expect(new Set(keys).size).toBe(1)
    expect(events.filter((e) => e.type === 'retry' && e.retry!.delayMs > 0)).toHaveLength(4)
    expect(messages).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('allows a slow interactive first response past the old two-minute wall', async () => {
    const stream = stalled()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response)
    const task = makeClient(fetcher).chat({ messages: [], retryCapacity: true, onDelta: () => {} })
    const observed = task.then(
      (v) => ({ value: v.content }),
      (e) => ({ error: String(e) })
    )
    await vi.advanceTimersByTimeAsync(121000)
    expect(stream.cancel).not.toHaveBeenCalled()
    stream.push(completed)
    expect(await observed).toEqual({ value: 'recovered' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('uses inactivity rather than total stream time for interactive calls', async () => {
    const stream = stalled()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response)
    const events: LLMDeltaEvent[] = []
    const task = makeClient(fetcher, 1000).chat({
      messages: [],
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    const observed = task.then(
      (v) => ({ value: v.content }),
      (e) => ({ error: String(e) })
    )
    await vi.advanceTimersByTimeAsync(700)
    stream.push({ type: 'response.output_text.delta', delta: 're' })
    await vi.advanceTimersByTimeAsync(700)
    expect(stream.cancel).not.toHaveBeenCalled()
    stream.push({ type: 'response.output_text.delta', delta: 'covered' })
    await vi.advanceTimersByTimeAsync(700)
    stream.push(completed)
    expect(await observed).toEqual({ value: 'recovered' })
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join('')
    ).toBe('recovered')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('cancels an idle pre-output stream before retry and stops backoff on user stop', async () => {
    const stream = stalled()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response)
    const controller = new AbortController()
    const events: LLMDeltaEvent[] = []
    const task = makeClient(fetcher, 1000).chat({
      messages: [],
      retryCapacity: true,
      signal: controller.signal,
      onDelta: (e) => events.push(e)
    })
    const observed = task.then(
      (v) => ({ value: v, error: undefined }),
      (e) => ({ value: undefined, error: e })
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.find((e) => e.type === 'retry')?.retry?.reason).toBe('request-timeout')
    expect(stream.cancel).toHaveBeenCalledOnce()
    controller.abort()
    expect((await observed).error).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['text', 'hosted-tool', 'image', 'function-call'] as const)(
    'does not replay a stalled request after %s has started',
    async (kind) => {
      const event =
        kind === 'text'
          ? { type: 'response.output_text.delta', delta: 'partial' }
          : kind === 'hosted-tool'
            ? { type: 'response.web_search_call.in_progress', item_id: 'owned' }
            : kind === 'image'
              ? { type: 'response.image_generation_call.partial_image', partial_image_b64: 'owned' }
              : {
                  type: 'response.output_item.added',
                  item: { type: 'function_call', name: 'owned' }
                }
      const stream = stalled(event)
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response)
      const task = makeClient(fetcher, 1000).chat({
        messages: [],
        retryCapacity: true,
        onDelta: () => {}
      })
      const observed = task.then(
        (v) => ({ value: v, error: undefined }),
        (e) => ({ value: undefined, error: e })
      )
      await vi.advanceTimersByTimeAsync(1001)
      expect((await observed).error).toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(60000)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(stream.cancel).toHaveBeenCalledOnce()
    }
  )
  it('does not retry a user cancellation whose reason is TimeoutError', async () => {
    const controller = new AbortController()
    const cause = new DOMException('user cancellation', 'TimeoutError')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_u, init) =>
          new Promise<Response>((_res, rej) =>
            init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason), { once: true })
          )
      )
    const task = makeClient(fetcher, 1000).chat({
      messages: [],
      retryCapacity: true,
      signal: controller.signal
    })
    const observed = task.catch((e) => e)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(cause)
    expect(await observed).toBe(cause)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('keeps the legacy noninteractive finite deadline', async () => {
    const stream = stalled()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response)
    const task = makeClient(fetcher, 1000).chat({ messages: [], onDelta: () => {} })
    const observed = task.catch((e) => e)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await observed).toMatchObject({ name: 'TimeoutError' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
