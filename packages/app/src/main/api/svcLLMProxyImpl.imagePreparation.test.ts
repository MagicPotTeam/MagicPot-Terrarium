import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { LLMChatReq, LLMChatStreamResp, ChatAttachment } from '@shared/api/svcLLMProxy'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from '@shared/llm/providerJsonBudget'
import { inspectOpenAIResponsesImageDataUrl } from '@shared/llm/openaiResponses'
import { createDeterministicPng } from '../../../../../scripts/chat/chatImageMemoryBenchmark.mjs'
import {
  runChatImageWorker,
  type ChatImageWorkerInput,
  type ChatImageWorkerResult
} from '../llmProxy/chatImageWorker'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const h = vi.hoisted(() => ({
  config: undefined as Config | undefined,
  fetch: vi.fn<typeof fetch>(),
  resolveWorker: vi.fn<() => Promise<string | undefined>>(),
  runWorker: vi.fn<(input: ChatImageWorkerInput) => Promise<ChatImageWorkerResult>>(),
  clears: [] as Array<ReturnType<typeof vi.fn>>,
  listTools: vi.fn(() => []),
  callTool: vi.fn()
}))

vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({
  getConfig: () => h.config,
  saveConfig: vi.fn(),
  onConfigCommitted: () => () => undefined
}))
vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool })
}))
vi.mock('../mcp/runtime', () => ({
  syncMcpClientManager: vi.fn(async () => undefined),
  getMcpClientManager: () => ({
    listPinnedTools: () => [],
    listConnections: () => [],
    isConnectionSuppressed: () => false
  })
}))
vi.mock('../extensions/generatedRegistry', () => ({
  mainHostExtensionApiV1: { apiServices: [], llmProxy: [] }
}))
vi.mock('electron', () => ({
  net: {},
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))

// Keep the real factory, projection, image preparer and client. Only the owned
// executable resolver/worker boundary is substituted; clear still runs for real.
vi.mock('../llmProxy/chatImagePreparation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmProxy/chatImagePreparation')>()
  return {
    ...actual,
    createChatImagePreparation: () => {
      const owner = actual.createChatImagePreparation({
        resolveWorker: () => h.resolveWorker(),
        runWorker: (input) => h.runWorker(input)
      })
      const clear = vi.fn(() => owner.clear())
      h.clears.push(clear)
      return { ...owner, clear }
    }
  }
})

const endpoint = 'https://provider.invalid/v1/responses'
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)
const url = (bytes: Uint8Array) => 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tinyResult = (): ChatImageWorkerResult => ({
  bytes: Buffer.from(tinyPng),
  mimeType: 'image/png',
  width: 1,
  height: 1
})
const attachment = (bytes: Uint8Array): ChatAttachment => ({
  type: 'image',
  mimeType: 'image/png',
  url: url(bytes)
})
const request = (sources: readonly Uint8Array[] = []): LLMChatReq => ({
  profileId: 'prepared-responses',
  imageHistoryPolicy: 'all',
  messages: [
    {
      role: 'user',
      content: 'Analyze the synthetic fixtures.',
      attachments: sources.map(attachment)
    }
  ]
})
const completed = {
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'prepared answer' }]
    }
  ]
}
const providerResponse = (stream: boolean) =>
  stream
    ? new Response(
        'data: ' +
          JSON.stringify({ type: 'response.output_text.delta', delta: 'prepared answer' }) +
          '\n\n' +
          'data: ' +
          JSON.stringify({ type: 'response.completed', response: completed }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    : Response.json(completed)

type Body = {
  stream?: boolean
  input: Array<{ content?: Array<{ type: string; image_url?: string }> }>
}
function sentBody(): { text: string; parsed: Body; imageUrls: string[] } {
  expect(h.fetch).toHaveBeenCalledOnce()
  const text = String(h.fetch.mock.calls[0][1]?.body)
  const parsed = JSON.parse(text) as Body
  const imageUrls = parsed.input
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'input_image')
    .map((part) => part.image_url!)
  return { text, parsed, imageUrls }
}
function expectCleared(): void {
  expect(h.clears).toHaveLength(1)
  expect(h.clears[0]).toHaveBeenCalledOnce()
}
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )

let largePng: Buffer
beforeAll(() => {
  largePng = createDeterministicPng(0, 4096, 4096)
})

beforeEach(() => {
  vi.clearAllMocks()
  h.clears.length = 0
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.mcp_config.client.servers = []
  const profile: LLMAPIProfile = {
    id: 'prepared-responses',
    api_key: 'fixture-key',
    base_url: 'https://provider.invalid/v1',
    model_name: 'fixture-model',
    provider: 'openai',
    call_type: 'api',
    model_use: 'chat',
    api_mode: 'responses',
    attachment_transports: ['request-data-url'],
    request_timeout_ms: 240_000
  }
  config.llm_config.api_profiles = [profile]
  h.config = config
  h.resolveWorker.mockResolvedValue(
    process.platform === 'win32' ? 'C:/fixture/image-worker.exe' : '/fixture/image-worker'
  )
  h.runWorker.mockImplementation(async () => tinyResult())
  h.fetch.mockImplementation(async (input, init) => {
    if (String(input) !== endpoint || init?.method !== 'POST')
      throw new Error('Unexpected fake provider operation')
    return providerResponse(Boolean((JSON.parse(String(init.body)) as Body).stream))
  })
  vi.stubGlobal('fetch', h.fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MAIN service Responses image preparation', () => {
  it.each(['unary', 'SSE'] as const)(
    'rejects a PNG falsely declared as GIF before %s provider dispatch or worker input',
    async (mode) => {
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const mislabeled = request()
      mislabeled.messages[0].attachments = [{
        type: 'image',
        mimeType: 'image/gif',
        url: `data:image/gif;base64,${largePng.toString('base64')}`
      }]
      const before = structuredClone(mislabeled.messages)
      if (mode === 'unary') {
        await expect(service.chat(mislabeled)).rejects.toThrow('MIME mismatch')
      } else {
        const onData = vi.fn<(event: LLMChatStreamResp) => void>()
        await service.chatStream(mislabeled, { onData })
        expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', finishReason: 'error' }))
      }
      expect(h.runWorker).not.toHaveBeenCalled()
      expect(h.resolveWorker).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
      expect(mislabeled.messages).toEqual(before)
    }
  )

  it.each(['unary', 'SSE'] as const)(
    'preserves a valid GIF byte-for-byte through %s without starting the worker',
    async (mode) => {
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
      const gifUrl = `data:image/gif;base64,${gif.toString('base64')}`
      const req = request()
      req.messages[0].attachments = [{ type: 'image', mimeType: 'image/gif', url: gifUrl }]
      const before = structuredClone(req.messages)
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      if (mode === 'unary') {
        await expect(service.chat(req)).resolves.toMatchObject({ content: 'prepared answer' })
      } else {
        const onData = vi.fn<(event: LLMChatStreamResp) => void>()
        await service.chatStream(req, { onData })
        expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'stop' }))
      }
      expect(sentBody().imageUrls).toEqual([gifUrl])
      expect(h.resolveWorker).not.toHaveBeenCalled()
      expect(h.runWorker).not.toHaveBeenCalled()
      expect(req.messages).toEqual(before)
      expectCleared()
    }
  )

  it.each(['unary', 'SSE'] as const)(
    'sends compressed copies through the actual %s service/client path',
    async (mode) => {
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const req = request([largePng])
      const originalMessages = structuredClone(req.messages)
      const originalHash = sha256(largePng)
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()
      if (mode === 'unary') {
        await expect(service.chat(req)).resolves.toMatchObject({ content: 'prepared answer' })
      } else {
        await service.chatStream(req, { onData })
        expect(onData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'text-delta', delta: 'prepared answer' })
        )
        expect(onData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'done', finishReason: 'stop' })
        )
      }
      const { imageUrls, parsed } = sentBody()
      expect(imageUrls).toEqual([url(tinyPng)])
      // The service tool loop consumes provider deltas even for unary callers.
      expect(parsed.stream).toBe(true)
      expect(h.resolveWorker).toHaveBeenCalledOnce()
      expect(h.runWorker).toHaveBeenCalledOnce()
      const input = h.runWorker.mock.calls[0][0]
      expect(sha256(input.source)).toBe(originalHash)
      expect(input).toMatchObject({ targetBytes: 512_000, maxEdge: 2000 })
      expect(input.signal).toBeInstanceOf(AbortSignal)
      expect(req.messages).toEqual(originalMessages)
      expect(sha256(largePng)).toBe(originalHash)
      expectCleared()
    }
  )

  it.each(['unary', 'SSE'] as const)(
    'clears preparation after %s worker failure without a provider POST',
    async (mode) => {
      h.runWorker.mockRejectedValueOnce(new Error('owned worker failure'))
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const req = request([largePng])
      const before = structuredClone(req.messages)
      if (mode === 'unary') {
        await expect(service.chat(req)).rejects.toThrow('Unable to prepare an image attachment')
      } else {
        const onData = vi.fn<(event: LLMChatStreamResp) => void>()
        await service.chatStream(req, { onData })
        expect(onData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', finishReason: 'error' })
        )
      }
      expect(h.runWorker).toHaveBeenCalledOnce()
      expect(h.fetch).not.toHaveBeenCalled()
      expect(req.messages).toEqual(before)
      expectCleared()
    }
  )

  it.each(['unary', 'SSE'] as const)(
    'clears a cancelled %s owner and never posts a late worker result',
    async (mode) => {
      let release!: () => void
      let workerSignal: AbortSignal | undefined
      h.runWorker.mockImplementationOnce((input) => {
        workerSignal = input.signal
        return new Promise((resolve) => {
          release = () => resolve(tinyResult())
        })
      })
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const controller = new AbortController()
      const [abortSender, abortReceiver] = newAbortHandler()
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()
      const req = request([largePng])
      const before = structuredClone(req.messages)
      const completion =
        mode === 'unary'
          ? observe(service.chat(req, { signal: controller.signal }))
          : observe(service.chatStream(req, { onData, abortReceiver }))
      await vi.waitFor(() => expect(h.runWorker).toHaveBeenCalledOnce())
      try {
        if (mode === 'unary') controller.abort()
        else abortSender.abort()
        const outcome = await completion
        if (mode === 'unary') expect(outcome.error).toMatchObject({ name: 'AbortError' })
        else expect(outcome.error).toBeUndefined()
        expect(workerSignal?.aborted).toBe(true)
        expect(h.fetch).not.toHaveBeenCalled()
        expect(req.messages).toEqual(before)
        expectCleared()
      } finally {
        release()
        // Let the real preparer observe native completion and release its serial
        // admission before the next test; abort alone must not release that slot.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['text', 'small PNG'] as const)(
    'keeps %s requests independent of worker resolution',
    async (kind) => {
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const req = request(kind === 'text' ? [] : [tinyPng])
      const before = structuredClone(req.messages)
      await expect(service.chat(req)).resolves.toMatchObject({ content: 'prepared answer' })
      expect(sentBody().imageUrls).toEqual(kind === 'text' ? [] : [url(tinyPng)])
      expect(h.resolveWorker).not.toHaveBeenCalled()
      expect(h.runWorker).not.toHaveBeenCalled()
      expect(req.messages).toEqual(before)
      expectCleared()
    }
  )
})

// Explicit opt-in private-worker integration; no released binary is changed.
// All sources are generated in memory and the only provider is the mock above.
const privateWorker = process.env.MAGICPOT_TEST_CHAT_IMAGE_WORKER
const runWithPrivateWorker = privateWorker ? it : it.skip
runWithPrivateWorker(
  'real private worker prepares eight large images through MAIN plus three unchanged history images',
  async () => {
    expect(path.isAbsolute(privateWorker!)).toBe(true)
    h.resolveWorker.mockResolvedValue(privateWorker)
    h.runWorker.mockImplementation((input) => runChatImageWorker(input))
    const sources = [
      largePng,
      ...Array.from({ length: 7 }, (_, index) => createDeterministicPng(index + 1, 4096, 4096))
    ]
    const history = Array.from({ length: 3 }, (_, index) =>
      createDeterministicPng(index + 20, 32, 32)
    )
    const hashes = [...history, ...sources].map(sha256)
    const sourceBytes = [...history, ...sources].reduce((sum, image) => sum + image.byteLength, 0)
    expect(sourceBytes).toBeLessThan(32 * 1024 * 1024)
    const req: LLMChatReq = {
      ...request(sources),
      messages: [
        { role: 'user', content: 'Earlier references', attachments: history.map(attachment) },
        { role: 'assistant', content: 'Acknowledged' },
        {
          role: 'user',
          content: 'Compare all eleven images.',
          attachments: sources.map(attachment)
        }
      ]
    }
    const originalUrls = req.messages
      .flatMap((message) => message.attachments ?? [])
      .map((item) => item.url)
    expect(originalUrls.reduce((sum, item) => sum + Buffer.byteLength(item), 0)).toBeGreaterThan(
      DEFAULT_PROVIDER_JSON_MAX_BYTES
    )
    const service = new LLMProxySvcImpl({ retryModelCapacity: false })
    await expect(service.chat(req)).resolves.toMatchObject({ content: 'prepared answer' })
    const { text, imageUrls } = sentBody()
    const wireBytes = Buffer.byteLength(text, 'utf8')
    expect(wireBytes).toBeLessThanOrEqual(DEFAULT_PROVIDER_JSON_MAX_BYTES)
    expect(imageUrls).toHaveLength(11)
    expect(imageUrls.slice(0, 3)).toEqual(history.map(url))
    const preparedSizes = imageUrls.map((imageUrl) => {
      const info = inspectOpenAIResponsesImageDataUrl(imageUrl)
      expect(info).not.toBeNull()
      expect(['image/png', 'image/jpeg']).toContain(info!.mimeType)
      expect(info!.decodedBytes).toBeGreaterThan(0)
      expect(info!.decodedBytes).toBeLessThanOrEqual(512_000)
      return info!.decodedBytes
    })
    expect(h.runWorker).toHaveBeenCalledTimes(8)
    expect(h.resolveWorker).toHaveBeenCalledOnce()
    expect(
      req.messages.flatMap((message) => message.attachments ?? []).map((item) => item.url)
    ).toEqual(originalUrls)
    expect([...history, ...sources].map(sha256)).toEqual(hashes)
    expectCleared()
    console.info('main-service-private-worker', {
      sourceBytes,
      wireBytes,
      imageCount: imageUrls.length,
      maxOutputBytes: Math.max(...preparedSizes)
    })
  },
  300_000
)
