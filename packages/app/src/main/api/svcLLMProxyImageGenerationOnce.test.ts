import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { FIGPLUGIN_IMAGE_GENERATION_OPTIONS } from '@shared/figplugin/imageGeneration'
import { cliFromProfile, OpenAIAPICli } from '@shared/llm'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const dependencies = vi.hoisted(() => ({
  getConfig: vi.fn(),
  onConfigCommitted: vi.fn(() => () => undefined),
  listTools: vi.fn(() => []),
  callTool: vi.fn(),
  syncMcp: vi.fn(),
  userDirectory: vi.fn(() => {
    throw new Error('User directories are forbidden in this synthetic test')
  }),
  nativeDialog: vi.fn(() => {
    throw new Error('Native dialogs are forbidden in this synthetic test')
  })
}))
vi.mock('../config/config', () => ({
  getConfig: dependencies.getConfig,
  onConfigCommitted: dependencies.onConfigCommitted,
  saveConfig: vi.fn()
}))
vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({
    listTools: dependencies.listTools,
    callTool: dependencies.callTool
  })
}))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: dependencies.syncMcp }))
vi.mock('../extensions/generatedRegistry', () => ({
  mainHostExtensionApiV1: { apiServices: [], llmProxy: [] }
}))
vi.mock('electron', () => ({
  net: {},
  app: { getPath: dependencies.userDirectory },
  dialog: { showMessageBox: dependencies.nativeDialog },
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))

const modes = ['images', 'responses'] as const
type Mode = (typeof modes)[number]
const PROFILE = 'synthetic-once-image-profile'
const BASE_URL = 'https://synthetic-image.example.invalid/v1'
const API_KEY = 'synthetic-primary-key'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PROMPT = 'Generate one synthetic green square.'
const CORRELATION = 'a'.repeat(32)
const controllers: AbortController[] = []
let fetchMock = vi.fn<typeof fetch>()
let clientChat = vi.spyOn(OpenAIAPICli.prototype, 'chat')

const profile = (mode: Mode): LLMAPIProfile => ({
  id: PROFILE,
  model_name: 'gpt-image-1',
  base_url: BASE_URL,
  api_key: API_KEY,
  provider: 'openai',
  model_use: 'image',
  call_type: 'api',
  api_mode: mode
})
const configure = (mode: Mode): Config => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [
    profile(mode),
    { ...profile(mode), id: 'synthetic-sibling', api_key: 'synthetic-sibling-key' }
  ]
  dependencies.getConfig.mockReturnValue(config)
  return config
}
const pinnedRequest = async (service: LLMProxySvcImpl, mode: Mode): Promise<LLMChatReq> => {
  const metadata = await service.listProfiles({
    comparisonRouting: 'configured',
    includeConfigurationRevision: true
  })
  const selected = metadata.profiles.find((item) => item.id === PROFILE)!
  expect(metadata.comparisonDestination).toEqual({ kind: 'local' })
  expect(selected).toMatchObject({ provider: 'openai', model_use: 'image', api_mode: mode })
  expect(selected.configurationRevision).toMatch(/^[a-f0-9]{64}$/)
  expect(service.isProfileRevisionCurrent(PROFILE, selected.configurationRevision!)).toBe(true)
  return {
    profileId: PROFILE,
    expectedProfileRevision: selected.configurationRevision,
    comparisonRouting: 'configured',
    conversationId: `synthetic-image-${mode}`,
    cancellationId: `synthetic-cancel-${mode}`,
    correlationId: CORRELATION,
    messages: [{ role: 'user', content: PROMPT }],
    imageGenerationOptions: { ...FIGPLUGIN_IMAGE_GENERATION_OPTIONS }
  }
}
const controller = (): AbortController => {
  const value = new AbortController()
  controllers.push(value)
  return value
}
const failure = (status: number): Response =>
  new Response(
    JSON.stringify({
      error: {
        code:
          status === 429
            ? 'rate_limit_exceeded'
            : status === 503
              ? 'server_overloaded'
              : 'server_error',
        message: 'Synthetic capacity or processing failure.'
      }
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
const success = (mode: Mode): Response =>
  new Response(
    JSON.stringify(
      mode === 'images'
        ? { data: [{ b64_json: PNG, output_format: 'png' }] }
        : {
            status: 'completed',
            output: [{ type: 'image_generation_call', result: PNG, output_format: 'png' }]
          }
    ),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
const assertWireRequest = (mode: Mode, index = 0): Record<string, unknown> => {
  const [url, init] = fetchMock.mock.calls[index]
  expect(String(url)).toBe(`${BASE_URL}/${mode === 'images' ? 'images/generations' : 'responses'}`)
  expect(init?.method).toBe('POST')
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${API_KEY}`)
  expect(new Headers(init?.headers).get('x-magicpot-correlation-id')).toBe(CORRELATION)
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body).not.toHaveProperty('retryCapacity')
  expect(body).not.toHaveProperty('retryModelCapacity')
  expect(body).not.toHaveProperty('expectedProfileRevision')
  if (mode === 'images') {
    expect(body).toEqual({
      model: 'gpt-image-1',
      prompt: PROMPT,
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto'
    })
  } else {
    expect(body.store).toBe(false)
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        model: 'gpt-image-1',
        action: 'generate',
        size: '1024x1024',
        quality: 'auto',
        output_format: 'png',
        background: 'auto'
      })
    ])
    expect(JSON.stringify(body.input)).toContain(PROMPT)
  }
  return body
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  clientChat = vi.spyOn(OpenAIAPICli.prototype, 'chat')
})
afterEach(async () => {
  for (const value of controllers.splice(0)) value.abort()
  await vi.advanceTimersByTimeAsync(0)
  expect(dependencies.callTool).not.toHaveBeenCalled()
  expect(dependencies.syncMcp).not.toHaveBeenCalled()
  expect(dependencies.userDirectory).not.toHaveBeenCalled()
  expect(dependencies.nativeDialog).not.toHaveBeenCalled()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('actual main LLM service and actual OpenAI generation client: once-only policy', () => {
  it.each(modes.flatMap((mode) => [500, 503, 429].map((status) => [mode, status] as const)))(
    '%s makes exactly one HTTP POST on %i despite request-provided retry flags',
    async (mode, status) => {
      configure(mode)
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const request: LLMChatReq & { retryCapacity: boolean; retryModelCapacity: boolean } = {
        ...(await pinnedRequest(service, mode)),
        retryCapacity: true,
        retryModelCapacity: true
      }
      fetchMock.mockImplementation(async () => failure(status))
      const abort = controller()
      const operation = observe(service.chat(request, { signal: abort.signal }))
      await vi.advanceTimersByTimeAsync(0)
      expect(await operation).toMatchObject({
        error: { name: 'UpstreamHttpError', statusCode: status }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(clientChat).toHaveBeenCalledTimes(1)
      expect(clientChat.mock.instances[0]).toBeInstanceOf(OpenAIAPICli)
      expect(vi.isMockFunction(cliFromProfile)).toBe(false)
      expect(clientChat.mock.calls[0][0].retryCapacity).toBeUndefined()
      expect(abort.signal.aborted).toBe(false)
      assertWireRequest(mode)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each(modes)(
    '%s returns successful inline output through the same revision-issuing service',
    async (mode) => {
      configure(mode)
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const request = await pinnedRequest(service, mode)
      fetchMock.mockImplementation(async () => success(mode))
      const result = await service.chat(request, { signal: controller().signal })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(clientChat).toHaveBeenCalledTimes(1)
      expect(result.attachments).toEqual([
        expect.objectContaining({
          type: 'image',
          url: `data:image/png;base64,${PNG}`,
          mimeType: 'image/png'
        })
      ])
      expect(clientChat.mock.calls[0][0]).toMatchObject({
        messages: [{ role: 'user', content: PROMPT }],
        imageGenerationOptions: FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
        correlationId: CORRELATION
      })
      expect(clientChat.mock.calls[0][0].retryCapacity).toBeUndefined()
      assertWireRequest(mode)
      expect(service.isProfileRevisionCurrent(PROFILE, request.expectedProfileRevision!)).toBe(true)
    }
  )

  it.each(modes)(
    '%s cannot reuse a revision on another service instance or after config mutation',
    async (mode) => {
      const config = configure(mode)
      const service = new LLMProxySvcImpl({ retryModelCapacity: false })
      const request = await pinnedRequest(service, mode)
      const foreign = new LLMProxySvcImpl({ retryModelCapacity: false })
      await expect(foreign.chat(request)).rejects.toMatchObject({
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(clientChat).not.toHaveBeenCalled()
      config.llm_config.api_profiles[0].api_key = 'synthetic-changed-key'
      expect(service.isProfileRevisionCurrent(PROFILE, request.expectedProfileRevision!)).toBe(
        false
      )
      await expect(service.chat(request)).rejects.toMatchObject({
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(clientChat).not.toHaveBeenCalled()
    }
  )

  it.each(modes)(
    '%s copies constructor policy rather than retaining a caller-mutable object',
    async (mode) => {
      configure(mode)
      const policy = { retryModelCapacity: false as const }
      const service = new LLMProxySvcImpl(policy)
      expect(Reflect.set(policy, 'retryModelCapacity', true)).toBe(true)
      const request = await pinnedRequest(service, mode)
      fetchMock.mockImplementation(async () => failure(503))
      const result = observe(service.chat(request, { signal: controller().signal }))
      await vi.advanceTimersByTimeAsync(0)
      expect(await result).toMatchObject({ error: { statusCode: 503 } })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(clientChat.mock.calls[0][0].retryCapacity).toBeUndefined()
      assertWireRequest(mode)
    }
  )
})

describe('ordinary main-service retry behavior is preserved', () => {
  it.each(modes)(
    '%s default service still retries capacity once before bounded user abort',
    async (mode) => {
      configure(mode)
      const service = new LLMProxySvcImpl()
      const request: LLMChatReq & { retryCapacity: boolean; retryModelCapacity: boolean } = {
        ...(await pinnedRequest(service, mode)),
        retryCapacity: false,
        retryModelCapacity: false
      }
      fetchMock.mockImplementation(async () => failure(503))
      const abort = controller()
      const operation = observe(service.chat(request, { signal: abort.signal }))
      setTimeout(
        () => abort.abort(new DOMException('Synthetic user cancellation', 'AbortError')),
        2500
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(clientChat.mock.calls[0][0].retryCapacity).toBe(true)
      const firstBody = assertWireRequest(mode)
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(assertWireRequest(mode, 1)).toEqual(firstBody)
      await vi.advanceTimersByTimeAsync(500)
      expect(await operation).toMatchObject({ error: { name: 'AbortError' } })
      expect(clientChat).toHaveBeenCalledTimes(1)
      expect(abort.signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )
})
