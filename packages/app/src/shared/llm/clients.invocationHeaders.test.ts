import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeAPICli,
  GeminiAPICli,
  OllamaAPICli,
  OpenAIAPICli,
  createModelInvocationContract
} from './index'

const invocation = createModelInvocationContract(
  {
    project: 'project-a',
    session: 'session-a',
    task: 'chat',
    requestId: 'request-a'
  },
  {
    resourceRefs: [],
    permission: { granted: true, capabilities: ['model.invoke'] },
    cancel: { requested: false },
    timeout: { deadlineMs: 10_000 }
  }
)

const baseRequest = {
  messages: [{ role: 'user' as const, content: 'hello' }],
  invocation
}

describe('provider-neutral invocation headers', () => {
  it('adds bounded metadata without changing provider response parsing', async () => {
    const cases = [
      {
        name: 'OpenAI chat completions',
        create: (fetchImpl: typeof fetch) =>
          new OpenAIAPICli('key', 'https://example.test/v1', 'model', {
            apiMode: 'chat-completions',
            fetchImpl,
            requestTimeoutMs: 1_000
          }),
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
      },
      {
        name: 'Gemini',
        create: (fetchImpl: typeof fetch) =>
          new GeminiAPICli('key', 'https://example.test/v1beta', 'model', {
            fetchImpl,
            requestTimeoutMs: 1_000
          }),
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      },
      {
        name: 'Claude',
        create: (fetchImpl: typeof fetch) =>
          new ClaudeAPICli('key', 'https://example.test', 'model', {
            fetchImpl,
            requestTimeoutMs: 1_000
          }),
        body: JSON.stringify({ content: [{ text: 'ok' }] })
      },
      {
        name: 'Ollama',
        create: (fetchImpl: typeof fetch) =>
          new OllamaAPICli('', 'https://example.test', 'model', {
            fetchImpl,
            requestTimeoutMs: 1_000
          }),
        body: JSON.stringify({ message: { content: 'ok' } })
      }
    ] as const

    for (const item of cases) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(item.body, { headers: { 'content-type': 'application/json' } })
        )
      await expect(item.create(fetchMock).chat(baseRequest)).resolves.toMatchObject({
        content: 'ok'
      })
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      expect(headers.get('X-MagicPot-Invocation-Id'), item.name).toBe('request-a')
      expect(headers.get('X-MagicPot-Invocation-Version'), item.name).toBe('1')
      expect(headers.get('X-MagicPot-Invocation-Schema'), item.name).toBe(
        'magicpot.model-invocation'
      )
    }
  })

  it('does not add invocation headers when no envelope is supplied', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: 'ok' } }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    await new OllamaAPICli('', 'https://example.test', 'model', {
      fetchImpl: fetchMock,
      requestTimeoutMs: 1_000
    }).chat({ messages: baseRequest.messages })
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.has('X-MagicPot-Invocation-Id')).toBe(false)
  })
})
