import { afterEach, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from '../../shared/llm/clients'
import { startSyntheticResponsesMock } from '../../../../../scripts/chat/syntheticResponsesMock.mjs'

let server: Awaited<ReturnType<typeof startSyntheticResponsesMock>> | undefined

afterEach(async () => {
  if (server) await server.close()
  server = undefined
})

// Actual client + local synthetic server; this does not run Electron, a codec,
// or a provider, nor measure renderer memory or establish network isolation.
it.each([false, true])('accepts ordered synthetic image occurrences in ordinary Responses, streaming=%s', async (stream) => {
  const first = 'data:image/png;base64,QUFB'
  const second = 'data:image/png;base64,QkJC'
  server = await startSyntheticResponsesMock({ syntheticImageLabels: [
    { image: first, label: 'first' }, { image: second, label: 'second' }
  ] })
  const endpoint = `${server.baseURL}/responses`
  const localFetch: typeof fetch = (input, init) => {
    if (String(input) !== endpoint) throw new Error('synthetic fixture forbids other endpoints')
    return fetch(input, init)
  }
  const client = new OpenAIAPICli('fixture-only', server.baseURL, 'fixture-model', {
    apiMode: 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl: localFetch
  })
  const onDelta = vi.fn()
  const result = await client.chat({
    messages: [{ role: 'user', content: 'synthetic', attachments: [first, second, first].map(url => ({ type: 'image' as const, mimeType: 'image/png', url })) }],
    retryCapacity: false,
    ...(stream ? { onDelta } : {})
  })
  expect(result.content).toBe('ok')
  if (stream) expect(onDelta).toHaveBeenCalled()
  expect(server.observations()).toEqual([expect.objectContaining({ imageCount: 3, imageLabels: ['first', 'second', 'first'] })])
})
