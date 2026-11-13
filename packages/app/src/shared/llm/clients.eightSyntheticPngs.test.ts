import { createDeterministicPng } from '../../../../../scripts/chat/chatImageMemoryBenchmark.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import * as budget from './providerJsonBudget'
import { OpenAIAPICli } from './clients'
import { ProviderJsonBudgetError, DEFAULT_PROVIDER_JSON_MAX_BYTES } from './providerJsonBudget'
import { buildOpenAIResponsesInput } from './openaiResponses'

afterEach(() => vi.restoreAllMocks())

// This exercises only the existing wire serializer. It does not run Electron,
// prepare a provider-only thumbnail, test codec output, or measure memory.
it('rejects eight synthetic 4096 PNGs above the Responses request budget before fake fetch', async () => {
  const images = Array.from({ length: 8 }, (_, index) => createDeterministicPng(index, 4096, 4096))
  const attachment = (bytes: Buffer) => ({ type: 'image' as const, mimeType: 'image/png', url: `data:image/png;base64,${bytes.toString('base64')}` })
  const history = Array.from({ length: 3 }, (_, index) => attachment(createDeterministicPng(index + 20, 32, 32)))
  const current = images.map(attachment)
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe('POST')
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] })
  })
  const client = new OpenAIAPICli('fixture', 'https://provider.invalid/v1', 'fixture', {
    apiMode: 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl
  })
  const messages = [
    { role: 'user' as const, content: 'Earlier references', attachments: history },
    { role: 'assistant' as const, content: 'Acknowledged' },
    { role: 'user' as const, content: 'Compare these', attachments: current }
  ]
  const projected = buildOpenAIResponsesInput(messages, { imageHistory: 'all' })
  const wireImages = projected.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'input_image')
  expect(wireImages).toHaveLength(11)
  expect(wireImages.map(part => part.type === 'input_image' ? part.image_url : undefined)).toEqual([...history, ...current].map(item => item.url))
  const sourceImageUrlBytes = [...history, ...current].reduce((sum, item) => sum + Buffer.byteLength(item.url, 'utf8'), 0)
  expect(sourceImageUrlBytes).toBeGreaterThan(DEFAULT_PROVIDER_JSON_MAX_BYTES)
  const serializer = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
  let failure: unknown
  try { await client.chat({ messages, imageHistoryPolicy: 'all' }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ProviderJsonBudgetError)
  expect(budget.isTrustedProviderJsonBudgetError(failure)).toBe(true)
  expect(serializer).not.toHaveBeenCalled()
  expect(fetchImpl).not.toHaveBeenCalled()
  console.info(`synthetic-source-image-url-bytes=${sourceImageUrlBytes}; png-source-bytes=${images.map(image => image.byteLength).join(',')}`)
}, 30_000)

it('rejects projected oversized ordinary Responses input before streaming, native tools or hosted file setup', async () => {
  // Reusing an immutable data URL keeps fixture creation bounded while each occurrence
  // is still an independent image part in the projected request.
  const url = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
  const attachments = Array.from({ length: 29 }, () => ({ type: 'image' as const, mimeType: 'image/png', url }))
  const fetchImpl = vi.fn<typeof fetch>(() => { throw new Error('fake fetch must not be called') })
  const onDelta = vi.fn()
  const client = new OpenAIAPICli('fixture', 'https://provider.invalid/v1', 'fixture', {
    apiMode: 'responses', enableHostedTools: true, enableHostedWebSearch: true, fetchImpl
  })
  const serializer = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
  let failure: unknown
  try {
    await client.chat({
      messages: [{ role: 'user', content: 'analyze', attachments }, { role: 'assistant', content: 'reference', attachments: [{ ...attachments[0] }] }, { role: 'user', content: 'analyze all' }],
      imageHistoryPolicy: 'all', retryCapacity: true, onDelta,
      tools: [{ name: 'fixture', description: 'fixture', inputSchema: { type: 'object' } }]
    })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ProviderJsonBudgetError)
  expect(budget.isTrustedProviderJsonBudgetError(failure)).toBe(true)
  expect(serializer).not.toHaveBeenCalled()
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(onDelta).not.toHaveBeenCalled()
})

it('does not apply the ordinary Responses lower bound to hosted image generation', async () => {
  const url = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
  const attachments = Array.from({ length: 29 }, () => ({ type: 'image' as const, mimeType: 'image/png', url }))
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }] }))
  const client = new OpenAIAPICli('fixture', 'https://provider.invalid/v1', 'fixture', {
    apiMode: 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl
  })
  const result = await client.chat({
    messages: [{ role: 'user', content: 'fixture', attachments }],
    imageGenerationOptions: { enabled: true, action: 'edit' }, retryCapacity: false
  })
  expect(fetchImpl).toHaveBeenCalledOnce()
  expect(result).toBeDefined()
})
