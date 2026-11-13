import { createHash } from 'node:crypto'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDeterministicPng } from '../../../../../scripts/chat/chatImageMemoryBenchmark.mjs'
import { OpenAIAPICli } from '../../shared/llm/clients'
import { buildOpenAIResponsesInput } from '../../shared/llm/openaiResponses'
import { prepareResponsesImageProjection } from './responsesImageProjectionCandidate'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from '../../shared/llm/providerJsonBudget'
import { ChatImagePreparer, type ChatImageEncoder } from './chatImagePreparer'
import { runChatImageWorker } from './chatImageWorker'

// Manual integration experiment, deliberately not wired into the product. Supply
// only an absolute path to a separately built test worker via this environment
// variable; never point it at a released binary. Normal CI visibly skips this test.
// It proves neither Electron renderer memory nor UI/recovery behavior.
const binaryPath = process.env.MAGICPOT_TEST_CHAT_IMAGE_WORKER
const runWithPrivateWorker = binaryPath ? it : it.skip
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

runWithPrivateWorker('prepares eight 4096 PNGs with a real private worker and sends a bounded Responses body to a fake provider', async () => {
  expect(binaryPath && path.isAbsolute(binaryPath)).toBe(true)
  const sources = Array.from({ length: 8 }, (_, index) => createDeterministicPng(index, 4096, 4096))
  const hashes = sources.map(sha256)
  expect(sources.reduce((sum, bytes) => sum + bytes.byteLength, 0)).toBe(30_390_951)
  const encode = vi.fn<ChatImageEncoder['encode']>(async (bytes, options) => {
    const result = await runChatImageWorker({
      binaryPath: binaryPath!, source: bytes, targetBytes: options.targetBytes,
      maxEdge: options.maxEdge, signal: options.signal, timeoutMs: 120_000
    })
    return result.bytes
  })
  const preparer = new ChatImagePreparer({ encode })
  const results = await preparer.prepareBatch(sources, 8 * 512_000)
  expect(encode).toHaveBeenCalledTimes(8)
  expect(results).toHaveLength(8)
  for (const result of results) {
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.width).toBeGreaterThan(0)
    expect(result.width).toBeLessThanOrEqual(2000)
    expect(result.height).toBe(result.width)
    expect(result.bytes.byteLength).toBeLessThanOrEqual(512_000)
  }
  expect(sources.map(sha256)).toEqual(hashes)
  const current = results.map(result => ({
    type: 'image' as const, mimeType: result.mimeType,
    url: `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString('base64')}`
  }))
  const history = Array.from({ length: 3 }, (_, index) => {
    const bytes = createDeterministicPng(index + 20, 32, 32)
    return { type: 'image' as const, mimeType: 'image/png', url: `data:image/png;base64,${bytes.toString('base64')}` }
  })
  const messages = [
    { role: 'user' as const, content: 'Earlier references', attachments: history },
    { role: 'assistant' as const, content: 'Acknowledged' },
    { role: 'user' as const, content: 'Compare these', attachments: current }
  ]
  const originalMessages = JSON.stringify(messages)
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe('POST')
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] })
  })
  const client = new OpenAIAPICli('fixture', 'https://provider.invalid/v1', 'fixture', {
    apiMode: 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl
  })
  const response = await client.chat({ messages, imageHistoryPolicy: 'all' })
  expect(response.content).toBe('ok')
  expect(fetchImpl).toHaveBeenCalledOnce()
  const body = String(fetchImpl.mock.calls[0][1]?.body)
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  expect(bodyBytes).toBeLessThanOrEqual(DEFAULT_PROVIDER_JSON_MAX_BYTES)
  const parsed = JSON.parse(body) as { input: Array<{ content?: Array<{ type: string; image_url?: string }> }> }
  const wireImages = parsed.input.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'input_image').map(part => part.image_url)
  expect(wireImages).toEqual([...history, ...current].map(item => item.url))
  expect(JSON.stringify(messages)).toBe(originalMessages)
  // The candidate transforms only a projected private copy; this deliberately
  // does not inject it into the product client. Cache hits keep this focused on
  // projection wiring while the eight codec calls above are real worker calls.
  const sourceMessages = [
    { role: 'user' as const, content: 'Earlier references', attachments: history },
    { role: 'assistant' as const, content: 'Acknowledged' },
    { role: 'user' as const, content: 'Compare these', attachments: sources.map(bytes => ({ type: 'image' as const, url: `data:image/png;base64,${bytes.toString('base64')}` })) }
  ]
  const originalSourceMessages = JSON.stringify(sourceMessages)
  const projection = buildOpenAIResponsesInput(sourceMessages, { imageHistory: 'all' })
  const projectedOriginal = JSON.stringify(projection)
  const transformed = await prepareResponsesImageProjection(projection, (bytes, signal) => preparer.prepareBatch(bytes, 50 * 512_000, {}, signal))
  const transformedImages = transformed.flatMap(message => message.content).filter(part => part.type === 'input_image').map(part => part.image_url)
  expect(transformedImages.slice(3)).toEqual(current.map(item => item.url))
  expect(transformedImages).toHaveLength(11)
  expect(JSON.stringify(projection)).toBe(projectedOriginal)
  expect(JSON.stringify(sourceMessages)).toBe(originalSourceMessages)
  expect(sources.map(sha256)).toEqual(hashes)
  console.info(`private-worker-source-bytes=${sources.reduce((sum, item) => sum + item.byteLength, 0)}; prepared-bytes=${results.map(item => item.bytes.byteLength).join(',')}; prepared-sizes=${results.map(item => `${item.width}x${item.height}`).join(',')}; fake-responses-body-bytes=${bodyBytes}`)
}, 240_000)
