import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMDeltaEvent } from './types'
import { normalizeModelRetryStatus } from './modelCapacityRetry'

const closed = () => new Error('net::ERR_CONNECTION_CLOSED')
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
const responsePayload = {
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }
  ]
}
const success = () => Response.json(responsePayload)
const client = (fetchImpl: typeof fetch) =>
  new OpenAIAPICli('owned-key', 'https://owned.test/v1', 'owned-model', {
    apiMode: 'responses',
    enableHostedTools: false,
    fetchImpl
  })
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('interactive connection-closed recovery', () => {
  it.each([true, false])(
    'retries a pre-header close with unchanged input and key (stream=%s)',
    async (stream) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(closed())
        .mockImplementation(async () => success())
      const events: LLMDeltaEvent[] = []
      const messages = [{ role: 'user' as const, content: 'same question, not a new turn' }]
      const original = structuredClone(messages)
      const result = observe(
        client(fetcher).chat({
          messages,
          retryCapacity: true,
          ...(stream ? { onDelta: (event: LLMDeltaEvent) => events.push(event) } : {})
        })
      )
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetcher).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect((await result).value?.content).toBe('recovered')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body)
      const keys = fetcher.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('idempotency-key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      expect(messages).toEqual(original)
      if (stream)
        expect(events.find((e) => e.type === 'retry')?.retry).toMatchObject({
          reason: 'connection-error',
          attempt: 1,
          delayMs: 2000
        })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps retrying beyond finite budgets with bounded backoff and unchanged request identity', async () => {
    let calls = 0
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (++calls <= 12) throw closed()
      return success()
    })
    const events: LLMDeltaEvent[] = []
    const result = observe(
      client(fetcher).chat({ messages: [], retryCapacity: true, onDelta: (e) => events.push(e) })
    )
    for (let n = 0; n < 13; n++) await vi.advanceTimersByTimeAsync(60000)
    expect((await result).value?.content).toBe('recovered')
    expect(fetcher).toHaveBeenCalledTimes(13)
    const waits = events.filter((e) => e.type === 'retry' && e.retry!.delayMs > 0)
    expect(waits.map((e) => e.retry!.attempt)).toEqual(Array.from({ length: 12 }, (_, n) => n + 1))
    expect(waits.map((e) => e.retry!.delayMs)).toEqual([
      2000,
      4000,
      8000,
      16000,
      32000,
      ...Array(7).fill(60000)
    ])
    expect(waits.every((e) => e.retry!.reason === 'connection-error')).toBe(true)
    expect(new Set(fetcher.mock.calls.map((c) => c[1]?.body)).size).toBe(1)
    const keys = fetcher.mock.calls.map((c) => new Headers(c[1]?.headers).get('idempotency-key'))
    expect(keys[0]).toBeTruthy()
    expect(new Set(keys).size).toBe(1)
    expect(JSON.stringify(events)).not.toContain('owned-key')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('continues while the connection stays down, but stops immediately on user cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(closed())
    const controller = new AbortController()
    let settled = false
    const pending = client(fetcher).chat({
      messages: [],
      retryCapacity: true,
      signal: controller.signal
    })
    const result = observe(pending).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(600000)
    expect(settled).toBe(false)
    const callsBeforeCancel = fetcher.mock.calls.length
    expect(callsBeforeCancel).toBeGreaterThan(10)
    controller.abort()
    expect((await result).error).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(600000)
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeCancel)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops if a retry subsequently receives a permanent HTTP error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(closed())
      .mockImplementation(async () => new Response('invalid credentials', { status: 401 }))
    const result = observe(client(fetcher).chat({ messages: [], retryCapacity: true }))
    await vi.advanceTimersByTimeAsync(60000)
    expect(String((await result).error)).toContain('401')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the retry wait immediately when the user cancels', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(closed())
    const controller = new AbortController()
    const events: LLMDeltaEvent[] = []
    const result = observe(
      client(fetcher).chat({
        messages: [],
        retryCapacity: true,
        signal: controller.signal,
        onDelta: (e) => events.push(e)
      })
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(events[0]?.retry?.reason).toBe('connection-error')
    controller.abort()
    expect((await result).error).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['none', 'text', 'hosted-tool', 'function-call'] as const)(
    'handles an interrupted response body after %s',
    async (started) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>
      const first = new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            stream = c
            if (started === 'text')
              c.enqueue(frame({ type: 'response.output_text.delta', delta: 'partial' }))
            if (started === 'hosted-tool')
              c.enqueue(frame({ type: 'response.web_search_call.in_progress', item_id: 'owned' }))
            if (started === 'function-call')
              c.enqueue(
                frame({
                  type: 'response.output_item.added',
                  item: { type: 'function_call', name: 'owned' }
                })
              )
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first)
        .mockImplementation(async () => success())
      const result = observe(
        client(fetcher).chat({ messages: [], retryCapacity: true, onDelta: () => {} })
      )
      await vi.advanceTimersByTimeAsync(1)
      stream.error(closed())
      await vi.advanceTimersByTimeAsync(2000)
      if (started === 'none') {
        expect((await result).value?.content).toBe('recovered')
        expect(fetcher).toHaveBeenCalledTimes(2)
      } else {
        expect((await result).error).toMatchObject({ retryBlocked: true })
        expect(fetcher).toHaveBeenCalledOnce()
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['images', 'responses-image'] as const)(
    'does not blindly replay an uncertain %s submission',
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(closed())
      const api =
        mode === 'images'
          ? new OpenAIAPICli('owned', 'https://owned.test/v1', 'gpt-image-1', {
              apiMode: 'images',
              modelUse: 'image',
              fetchImpl: fetcher
            })
          : client(fetcher)
      const result = observe(
        api.chat({
          messages: [{ role: 'user', content: 'draw a tree' }],
          retryCapacity: true,
          imageGenerationOptions: { enabled: true, action: 'generate' },
          onDelta: () => {}
        })
      )
      await vi.advanceTimersByTimeAsync(60000)
      expect((await result).error).toBeInstanceOf(Error)
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )

  it.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'fetch failed',
    'unexpected EOF'
  ])('does not retry a permanent or unclassified transport failure: %s', async (message) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(message))
    const result = observe(client(fetcher).chat({ messages: [], retryCapacity: true }))
    await vi.advanceTimersByTimeAsync(60000)
    expect((await result).error).toBeInstanceOf(Error)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not interpret provider text or invalid credentials as a transport retry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            '{"error":{"message":"net::ERR_CONNECTION_CLOSED","code":"invalid_api_key"}}',
            { status: 401 }
          )
      )
    await expect(client(fetcher).chat({ messages: [], retryCapacity: true })).rejects.toThrow('401')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not replay a renderer callback failure that looks like a socket error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => success())
    await expect(
      client(fetcher).chat({
        messages: [],
        retryCapacity: true,
        onDelta: () => {
          throw closed()
        }
      })
    ).rejects.toThrow('ERR_CONNECTION_CLOSED')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('retains the explicit noninteractive opt-out', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(closed())
    await expect(client(fetcher).chat({ messages: [] })).rejects.toThrow('ERR_CONNECTION_CLOSED')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('accepts the connection reason through the bounded progress contract', () => {
    expect(
      normalizeModelRetryStatus({
        attempt: 1,
        delayMs: 2000,
        nextRetryAt: Date.now() + 2000,
        reason: 'connection-error',
        secret: 'not-ui-data'
      })
    ).toEqual({
      attempt: 1,
      delayMs: 2000,
      nextRetryAt: Date.now() + 2000,
      reason: 'connection-error'
    })
  })
})
