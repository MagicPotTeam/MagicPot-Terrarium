import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli } from './clients'
import type { LLMChatParams, LLMDeltaEvent, LLMCli } from './types'

type ProviderCase = {
  name: string
  create: (fetchImpl: typeof fetch, requestTimeoutMs?: number) => LLMCli
  success: () => Response
}

const transientFailure = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'server_overloaded',
        message: 'The selected model is currently at capacity.'
      }
    }),
    { status: 503, headers: { 'content-type': 'application/json' } }
  )

const providers: ProviderCase[] = [
  {
    name: 'Gemini',
    create: (fetchImpl, requestTimeoutMs) =>
      new GeminiAPICli('owned', 'https://gemini.test', 'gemini-2.5-flash', {
        fetchImpl,
        requestTimeoutMs
      }),
    success: () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini ok' }] } }] }),
        { headers: { 'content-type': 'application/json' } }
      )
  },
  {
    name: 'Claude',
    create: (fetchImpl, requestTimeoutMs) =>
      new ClaudeAPICli('owned', 'https://claude.test', 'claude-3-7-sonnet', {
        fetchImpl,
        requestTimeoutMs
      }),
    success: () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'claude ok' }] }), {
        headers: { 'content-type': 'application/json' }
      })
  },
  {
    name: 'Ollama',
    create: (fetchImpl, requestTimeoutMs) =>
      new OllamaAPICli('', 'https://ollama.test', 'llama3.2', { fetchImpl, requestTimeoutMs }),
    success: () =>
      new Response(JSON.stringify({ message: { content: 'ollama ok' } }), {
        headers: { 'content-type': 'application/json' }
      })
  }
]

const baseParams = (overrides: Partial<LLMChatParams> = {}): LLMChatParams => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides
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

describe.each(providers)('non-OpenAI $name provider capacity handling', (provider) => {
  it('retries a transient 503 and emits one text delta after success', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => transientFailure())
      .mockImplementation(async () => provider.success())
    const events: LLMDeltaEvent[] = []
    const pending = provider
      .create(fetcher)
      .chat(baseParams({ retryCapacity: true, onDelta: (event) => events.push(event) }))

    await vi.advanceTimersByTimeAsync(1999)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'retry',
        retry: expect.objectContaining({ reason: 'server-overloaded', delayMs: 2000 })
      })
    )

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ content: `${provider.name.toLowerCase()} ok` })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      events.filter((event) => event.type === 'text-delta').map((event) => event.delta)
    ).toEqual([`${provider.name.toLowerCase()} ok`])
  })

  it('keeps unary output silent while structured output is pending validation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => provider.success())
    const events: LLMDeltaEvent[] = []
    await expect(
      provider.create(fetcher).chat(
        baseParams({
          structuredOutput: { name: 'result', schema: { type: 'object' } },
          onDelta: (event) => events.push(event)
        })
      )
    ).resolves.toMatchObject({ content: `${provider.name.toLowerCase()} ok` })
    expect(events).toEqual([])
  })

  it('retries a tagged model deadline but does not replay the cancelled attempt', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signals.push(init!.signal as AbortSignal)
      if (signals.length === 1) return new Promise<Response>(() => undefined)
      return provider.success()
    })
    const events: LLMDeltaEvent[] = []
    const pending = provider
      .create(fetcher, 1_000)
      .chat(baseParams({ retryCapacity: true, onDelta: (event) => events.push(event) }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals[0].aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'retry',
        retry: expect.objectContaining({ reason: 'request-timeout', delayMs: 2000 })
      })
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toMatchObject({ content: `${provider.name.toLowerCase()} ok` })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(signals).toHaveLength(2)
  })

  it('does not retry authentication errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('invalid credentials', { status: 401 }))
    await expect(
      provider.create(fetcher).chat(baseParams({ retryCapacity: true }))
    ).rejects.toMatchObject({
      statusCode: 401
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('propagates an onDelta failure without wrapping it as a provider error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => provider.success())
    const callbackError = new Error('renderer callback failed')
    const callback = vi.fn(() => {
      throw callbackError
    })

    await expect(
      provider.create(fetcher).chat(baseParams({ retryCapacity: true, onDelta: callback }))
    ).rejects.toBe(callbackError)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

it('stops non-OpenAI capacity retry during backoff when the caller aborts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => transientFailure())
  const controller = new AbortController()
  const callbackEvents: LLMDeltaEvent[] = []
  const pending = new GeminiAPICli('owned', 'https://gemini.test', 'gemini-2.5-flash', {
    fetchImpl: fetcher
  }).chat(
    baseParams({
      retryCapacity: true,
      signal: controller.signal,
      onDelta: (event) => callbackEvents.push(event)
    })
  )

  await vi.advanceTimersByTimeAsync(0)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(callbackEvents.some((event) => event.type === 'retry')).toBe(true)
  const reason = new DOMException('caller cancelled', 'AbortError')
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetcher).toHaveBeenCalledOnce()
})
