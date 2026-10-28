import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli, UpstreamHttpError } from './clients'
import type { LLMCli } from './types'

const chat = { messages: [{ role: 'user' as const, content: 'hello' }] }

type ProviderName = 'Gemini' | 'Claude' | 'Ollama'
const createClient = (name: ProviderName, fetchImpl: typeof fetch): LLMCli => {
  if (name === 'Gemini') {
    return new GeminiAPICli('key', 'https://example.test/v1beta', 'gemini', {
      fetchImpl,
      requestTimeoutMs: 1_000
    })
  }
  if (name === 'Claude') {
    return new ClaudeAPICli('key', 'https://example.test', 'claude', {
      fetchImpl,
      requestTimeoutMs: 1_000
    })
  }
  return new OllamaAPICli('', 'https://example.test', 'llama', {
    fetchImpl,
    requestTimeoutMs: 1_000
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('non-OpenAI provider request lifecycle', () => {
  it.each([['Gemini'], ['Claude'], ['Ollama']] as const)(
    'passes a controller signal to %s and preserves normal responses',
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            name === 'Gemini'
              ? JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
              : name === 'Claude'
                ? JSON.stringify({ content: [{ text: 'ok' }] })
                : JSON.stringify({ message: { content: 'ok' } }),
            { headers: { 'content-type': 'application/json' } }
          )
        )

      await expect(createClient(name, fetchMock).chat(chat)).resolves.toMatchObject({
        content: 'ok'
      })
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    }
  )

  it.each([['Gemini'], ['Claude'], ['Ollama']] as const)(
    'times out a hanging %s request',
    async (name) => {
      vi.useFakeTimers()
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise<Response>(() => undefined))
      const pending = createClient(name, fetchMock).chat(chat)
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'MODEL_REQUEST_TIMEOUT'
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
    }
  )

  it('preserves an exact caller cancellation reason', async () => {
    const parent = new AbortController()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined))
    const reason = { type: 'provider-caller-cancel' }
    const pending = createClient('Claude', fetchMock).chat({ ...chat, signal: parent.signal })
    const assertion = expect(pending).rejects.toBe(reason)
    parent.abort(reason)
    await assertion
  })

  it('cancels a response body that stalls after headers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(async () => undefined)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"message":'))
          },
          pull() {
            return new Promise<void>(() => undefined)
          },
          cancel
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
    const pending = new OllamaAPICli('', 'https://example.test', 'llama', {
      fetchImpl: fetchMock,
      requestTimeoutMs: 1_000
    }).chat(chat)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(cancel).toHaveBeenCalled()
  })

  it('bounds provider error bodies and preserves HTTP classification', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('secret-provider-detail-'.repeat(10_000), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'application/json' }
      })
    )
    const pending = new GeminiAPICli('query-secret', 'https://example.test/v1beta', 'gemini', {
      fetchImpl: fetchMock,
      requestTimeoutMs: 1_000
    }).chat(chat)

    const error = await pending.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(UpstreamHttpError)
    expect(error).toMatchObject({ statusCode: 429 })
    expect((error as UpstreamHttpError).body.length).toBeLessThanOrEqual(64 * 1024)
    expect((error as Error).message).not.toContain('query-secret')
  })
})
