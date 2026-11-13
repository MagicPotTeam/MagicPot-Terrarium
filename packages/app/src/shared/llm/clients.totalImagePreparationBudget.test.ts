import { describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli } from './clients'

const providers = ['gemini', 'claude', 'ollama'] as const
const privateUrl = 'https://private.invalid/fixture-secret.png'
const firstPayload = 'A'.repeat(16 * 1024 * 1024)
const image = (url: string) => ({ type: 'image' as const, url, mimeType: 'image/png' })

function makeClient(provider: (typeof providers)[number], fetchImpl: typeof fetch) {
  if (provider === 'gemini') return new GeminiAPICli('fixture', 'https://provider.invalid', 'model', { fetchImpl })
  if (provider === 'claude') return new ClaudeAPICli('fixture', 'https://provider.invalid', 'model', { fetchImpl })
  return new OllamaAPICli('fixture', 'https://provider.invalid', 'model', { fetchImpl })
}

function providerResponse(provider: (typeof providers)[number]): Response {
  const body = provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
    : provider === 'claude'
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : { message: { content: 'ok' }, done: true }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

describe('ordinary chat cumulative encoded image preparation budget', () => {
  it.each(providers)('%s rejects cumulative image payload above 28 MiB without dispatch or URL disclosure', async provider => {
    const post = vi.fn()
    let fullyRead = false
    let pulls = 0
    let cancelled = false
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') { post(); return providerResponse(provider) }
      expect(String(url)).toBe(privateUrl)
      let remaining = 10 * 1024 * 1024
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++
          if (!remaining) { fullyRead = true; controller.close(); return }
          const size = Math.min(1024 * 1024, remaining)
          remaining -= size
          controller.enqueue(new Uint8Array(size))
        },
        cancel() { cancelled = true }
      }, { highWaterMark: 0 }) // Do not let source read-ahead conflate enqueue with consumer retention.
      return new Response(stream, { headers: { 'content-type': 'image/png' } })
    })
    const attachments = Object.freeze([
      Object.freeze(image(`data:image/png;base64,${firstPayload}`)),
      Object.freeze(image(privateUrl))
    ])
    const snapshot = attachments.map(attachment => ({ ...attachment }))
    let failure: unknown
    try {
      await makeClient(provider, fetchImpl).chat({ messages: [{ role: 'user', content: 'compare', attachments: [...attachments] }] })
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(post).not.toHaveBeenCalled()
    expect(fullyRead).toBe(false)
    // 9 MiB fits the remaining budget; the 10th chunk crosses it and is rejected.
    expect(pulls).toBe(10)
    expect(cancelled).toBe(true)
    expect(String((failure as Error).message)).not.toContain(privateUrl)
    expect(String((failure as Error).stack)).not.toContain(privateUrl)
    expect(attachments).toEqual(snapshot)
  }, 30_000)

  it.each(providers)('%s gives each capacity retry its own image allowance', async provider => {
    const imageUrl = 'https://images.invalid/retry.png'
    const payload = 'A'.repeat(11 * 1024 * 1024)
    const imageBytes = new Uint8Array(6 * 1024 * 1024)
    let gets = 0
    let posts = 0
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== 'POST') {
        gets++
        return new Response(imageBytes, { headers: { 'content-type': 'image/png' } })
      }
      posts++
      if (posts === 1) return new Response('busy', { status: 503 })
      return providerResponse(provider)
    })
    const client = makeClient(provider, fetchImpl)
    const attachments = [image(`data:image/png;base64,${payload}`), image(imageUrl)]
    const events: string[] = []
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const pending = client.chat({
        retryCapacity: true,
        messages: [{ role: 'user', content: 'fixture', attachments }],
        onDelta: event => { events.push(event.type) }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(posts).toBe(1)
      expect(gets).toBe(1)
      expect(events).toContain('retry')
      await vi.advanceTimersByTimeAsync(2000)
      await expect(pending).resolves.toMatchObject({ content: 'ok' })
      expect(posts).toBe(2)
      expect(gets).toBe(2)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  }, 30_000)

  it.each(providers)('%s resets the image allowance for each separate chat', async provider => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe('POST')
      return providerResponse(provider)
    })
    const client = makeClient(provider, fetchImpl)
    const oneImage = { messages: [{ role: 'user' as const, content: 'fixture', attachments: [image(`data:image/png;base64,${firstPayload}`)] }] }
    await expect(client.chat(oneImage)).resolves.toMatchObject({ content: 'ok' })
    await expect(client.chat(oneImage)).resolves.toMatchObject({ content: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  }, 30_000)
})
