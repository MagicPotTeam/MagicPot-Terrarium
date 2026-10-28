import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMDeltaEvent } from './types'

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
const fail = {
  type: 'response.failed',
  response: {
    error: {
      code: 'server_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.'
    }
  }
}
const completed = {
  type: 'response.completed',
  response: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
  }
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
const client = (fetchImpl: typeof fetch, mode: 'responses' | 'chat-completions' = 'responses') =>
  new OpenAIAPICli(
    'owned',
    mode === 'responses' ? 'https://owned.test/v1' : 'https://owned.test/v1/chat/completions',
    'owned-model',
    { fetchImpl, apiMode: mode, enableHostedTools: false }
  )

describe('interactive OpenAI-family capacity retry', () => {
  it('retries HTTP 503 with the same request body/key and respects Retry-After', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response('{"error":{"code":"server_overloaded"}}', {
            status: 503,
            headers: { 'retry-after': '3' }
          })
      )
      .mockImplementation(
        async () =>
          new Response('{"choices":[{"message":{"content":"ok"}}]}', {
            headers: { 'content-type': 'application/json' }
          })
      )
    const messages = [
      { role: 'user' as const, content: 'original context' },
      { role: 'assistant' as const, content: '[Tool Result] owned file contents' },
      { role: 'user' as const, content: 'continue' }
    ]
    const before = structuredClone(messages)
    const events: LLMDeltaEvent[] = []
    const pending = client(fetcher, 'chat-completions').chat({
      messages,
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ content: 'ok' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body)
    const keys = fetcher.mock.calls.map((c) => new Headers(c[1]?.headers).get('idempotency-key'))
    expect(keys[0]).toBeTruthy()
    expect(keys[0]).toBe(keys[1])
    expect(messages).toEqual(before)
    expect(events.filter((e) => e.type === 'retry')[0].retry?.delayMs).toBe(3000)
  })
  it('retries explicit SSE response.failed past three attempts without exposing duplicate text', async () => {
    let attempts = 0
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        ++attempts < 7
          ? sse([fail])
          : sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed])
      )
    const events: LLMDeltaEvent[] = []
    const pending = client(fetcher).chat({
      messages: [{ role: 'user', content: 'hello' }],
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(60000)
    await expect(pending).resolves.toMatchObject({ content: 'ok' })
    expect(attempts).toBe(7)
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join('')
    ).toBe('ok')
  })
  it.each(['text', 'hosted-tool'])('does not replay after %s has started', async (mode) => {
    const initial =
      mode === 'text'
        ? { type: 'response.output_text.delta', delta: 'partial' }
        : { type: 'response.web_search_call.in_progress', item_id: 'owned' }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sse([initial, fail]))
    await expect(
      client(fetcher).chat({ messages: [], retryCapacity: true, onDelta: () => {} })
    ).rejects.toThrow('overloaded')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('retains legacy noninteractive error behavior', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('overloaded', { status: 503 }))
    await expect(client(fetcher).chat({ messages: [] })).rejects.toThrow('503')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('OpenAI transport retries reported processing errors', () => {
  const message =
    'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 47ea0bfe-e93a-4fdc-adf0-80388e3c427a in your message.'
  it.each(['http500', 'sse-message', 'sse-code'] as const)(
    'retries %s using the same body and idempotency key',
    async (mode) => {
      let calls = 0
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (++calls > 4)
          return sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed])
        if (mode === 'http500')
          return new Response(JSON.stringify({ error: { message, type: 'server_error' } }), {
            status: 500
          })
        return sse([
          {
            type: 'response.failed',
            response: {
              error:
                mode === 'sse-code' ? { code: 'internal_error', message: 'Try later' } : { message }
            }
          }
        ])
      })
      const events: LLMDeltaEvent[] = []
      const promise = client(fetcher).chat({
        messages: [{ role: 'user', content: 'continue from saved context' }],
        retryCapacity: true,
        onDelta: (event) => events.push(event)
      })
      const checked = promise.then(
        (result) => result.content,
        (error: Error) => error.message
      )
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60000)
      expect(await checked).toBe('ok')
      expect(fetcher).toHaveBeenCalledTimes(5)
      expect(new Set(fetcher.mock.calls.map((entry) => entry[1]?.body)).size).toBe(1)
      const keys = fetcher.mock.calls.map((entry) =>
        new Headers(entry[1]?.headers).get('idempotency-key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      expect(
        events
          .filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
          .map((event) => event.retry!.reason)
      ).toEqual(Array(4).fill('server-error'))
      expect(
        events
          .filter((event) => event.type === 'text-delta')
          .map((event) => event.delta)
          .join('')
      ).toBe('ok')
    }
  )
  it.each(['partial-text', 'hosted-tool'] as const)(
    'still refuses to replay server errors after %s',
    async (mode) => {
      const started =
        mode === 'partial-text'
          ? { type: 'response.output_text.delta', delta: 'already visible' }
          : { type: 'response.web_search_call.in_progress', item_id: 'owned' }
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          sse([
            started,
            { type: 'response.failed', response: { error: { message, code: 'internal_error' } } }
          ])
        )
      await expect(
        client(fetcher).chat({ messages: [], retryCapacity: true, onDelta: () => {} })
      ).rejects.toThrow('processing your request')
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
})
