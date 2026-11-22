import { describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli } from './clients'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from './providerJsonBudget'

const providers = ['gemini', 'claude', 'ollama'] as const
const makeClient = (provider: typeof providers[number], fetchImpl: typeof fetch) =>
  provider === 'gemini' ? new GeminiAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
    : provider === 'claude' ? new ClaudeAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
      : new OllamaAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })

describe('provider chat image download bound', () => {
  it.each(providers)('%s rejects an over-cap inline segment before dispatch', async provider => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = makeClient(provider, fetchImpl)
    const url = 'data:image/png;base64,' + 'A'.repeat(DEFAULT_PROVIDER_JSON_MAX_BYTES + 1)
    await expect(client.chat({ messages: [{ role: 'user', content: 'fixture', attachments: [{ type: 'image', url }] }] }))
      .rejects.toThrow('Unable to prepare an image attachment for the model.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(providers)('%s rejects a streamed image exceeding the per-image cap without posting it', async provider => {
    let pulls = 0
    let cancelled = false
    const maxInput = Math.floor(DEFAULT_PROVIDER_JSON_MAX_BYTES / 4) * 3
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls === 1) controller.enqueue(new Uint8Array(maxInput))
        else if (pulls === 2) controller.enqueue(new Uint8Array(1))
        else controller.close()
      },
      cancel() { cancelled = true }
    }, { highWaterMark: 0 })
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') return new Response('{}', { headers: { 'content-type': 'application/json' } })
      return new Response(stream, { headers: { 'content-type': 'image/png' } })
    })
    const client = makeClient(provider, fetchImpl)
    await expect(client.chat({ messages: [{ role: 'user', content: 'fixture', attachments: [{ type: 'image', url: 'https://fixture.invalid/img' }] }] }))
      .rejects.toThrow('Unable to prepare an image attachment for the model.')
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    expect(pulls).toBe(2)
    expect(cancelled).toBe(true)
  })
})
