import { describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli } from './clients'

const providers = ['gemini', 'claude', 'ollama'] as const
const secret = 'https://secret.invalid/private-image'
const image = (url: string) => ({ type: 'image' as const, url, mimeType: 'image/png' })

function setup(provider: (typeof providers)[number]) {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') throw new Error(`private failure: ${secret}`)
    const payload = provider === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
      : provider === 'claude'
        ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
        : { message: { content: 'ok' }, done: true }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  })
  const client = provider === 'gemini'
    ? new GeminiAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
    : provider === 'claude'
      ? new ClaudeAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
      : new OllamaAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
  return { client, fetchImpl }
}

describe('multi-image provider conversion', () => {
  it.each(providers)('%s fails closed without exposing source on second image failure', async provider => {
    const { client, fetchImpl } = setup(provider)
    let failure: unknown
    try {
      await client.chat({ messages: [{ role: 'user', content: 'compare', attachments: [image('data:image/png;base64,QQ=='), image(secret)] }] })
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Unable to prepare an image attachment for the model.')
    expect(String((failure as Error).stack)).not.toContain(secret)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it.each(providers)('%s aborts without a POST when a downloaded image stream fails', async provider => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') throw new Error('unexpected POST')
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error(`private stream failure: ${secret}`)) }
      })
      return new Response(body, { headers: { 'content-type': 'image/png' } })
    })
    const client = provider === 'gemini' ? new GeminiAPICli('key', 'https://provider.invalid', 'model', { fetchImpl }) : provider === 'claude' ? new ClaudeAPICli('key', 'https://provider.invalid', 'model', { fetchImpl }) : new OllamaAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
    let failure: unknown
    try { await client.chat({ messages: [{ role: 'user', content: 'compare', attachments: [image(secret)] }] }) }
    catch (error) { failure = error }
    expect((failure as Error).message).toBe('Unable to prepare an image attachment for the model.')
    expect(String((failure as Error).stack)).not.toContain(secret)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it.each(providers)('%s preserves cancellation reason during conversion', async provider => {
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    const fetchImpl = vi.fn<typeof fetch>(async () => { controller.abort(reason); throw new Error('internal') })
    const client = provider === 'gemini' ? new GeminiAPICli('key', 'https://provider.invalid', 'model', { fetchImpl }) : provider === 'claude' ? new ClaudeAPICli('key', 'https://provider.invalid', 'model', { fetchImpl }) : new OllamaAPICli('key', 'https://provider.invalid', 'model', { fetchImpl })
    await expect(client.chat({ signal: controller.signal, messages: [{ role: 'user', content: 'compare', attachments: [image(secret)] }] })).rejects.toBe(reason)
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it.each(providers)('%s retains image order and text on success', async provider => {
    const { client, fetchImpl } = setup(provider)
    await client.chat({ messages: [{ role: 'user', content: 'compare', attachments: [image('data:image/png;base64,QQ=='), image('data:image/png;base64,Qg==')] }] })
    const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    const body = JSON.parse(String(posts[0][1]?.body))
    if (provider === 'gemini') expect(body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }, { inlineData: { mimeType: 'image/png', data: 'Qg==' } }, { text: 'compare' }])
    if (provider === 'claude') expect(body.messages[0].content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Qg==' } }, { type: 'text', text: 'compare' }])
    if (provider === 'ollama') expect(body.messages[0]).toEqual({ role: 'user', content: 'compare', images: ['QQ==', 'Qg=='] })
  })
})
