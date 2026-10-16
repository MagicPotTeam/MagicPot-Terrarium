import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { cliFromProfile } from '@shared/llm'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

let currentConfig: Config
const { providerChat, getAssistantRuntimeMock } = vi.hoisted(() => ({
  providerChat: vi.fn(async (_req: unknown) => 'Synthetic local advice'),
  getAssistantRuntimeMock: vi.fn(() => ({ listTools: vi.fn(() => []), callTool: vi.fn() }))
}))

vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/config', () => ({ getConfig: () => currentConfig }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: getAssistantRuntimeMock }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../extensions/generatedRegistry', () => ({ mainHostExtensionApiV1: { llmProxy: [] } }))
vi.mock('@shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/llm')>()),
  cliFromProfile: vi.fn(() => ({ chat: providerChat }))
}))

const remoteRevision = 'a'.repeat(64)
const remoteProfile = {
  id: 'remote-profile::synthetic-model',
  model_name: 'Synthetic remote model',
  configurationRevision: remoteRevision,
  deployment: 'api',
  model_use: 'agent',
  context_budget_tokens: 4000,
  context_window_tokens: 8000
}
const localProfile = {
  id: 'local-profile',
  model_name: 'Synthetic local model',
  base_url: 'https://local-provider.invalid/v1',
  api_key: 'local-provider-only-secret',
  model_use: 'agent' as const
}
const messages: LLMChatReq['messages'] = [
  { role: 'system', content: 'Compare only the synthetic summaries.' },
  { role: 'user', content: 'Synthetic project A and project B.' }
]
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
const metadata = (): Response => json({ protocol: 1, profiles: [remoteProfile] })
const result = (): Response =>
  json({
    protocol: 1,
    result: { content: 'Synthetic remote advice', finishReason: 'stop', usage: { totalTokens: 12 } }
  })
const fetchMock = vi.fn<typeof globalThis.fetch>()
let service: LLMProxySvcImpl

const issue = async (): Promise<LLMChatReq> => {
  fetchMock.mockResolvedValueOnce(metadata())
  const listed = await service.listProfiles({
    includeConfigurationRevision: true,
    comparisonRouting: 'configured'
  })
  return {
    comparisonRouting: 'configured',
    profileScope: 'agent',
    profileId: listed.profiles[0].id,
    expectedProfileRevision: listed.profiles[0].configurationRevision,
    messages: structuredClone(messages),
    conversationId: 'synthetic-comparison-conversation',
    temperature: 0.4,
    maxOutputTokens: 600
  }
}
const expectNoLocalExecution = (): void => {
  expect(cliFromProfile).not.toHaveBeenCalled()
  expect(providerChat).not.toHaveBeenCalled()
  expect(getAssistantRuntimeMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock
    .mockReset()
    .mockRejectedValue(
      new Error('Unexpected fetch: tests permit only synthetic protocol responses')
    )
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  currentConfig = structuredClone(DEFAULT_CONFIG)
  currentConfig.use_remote_llm = true
  currentConfig.remote_llm_server_config = {
    server_origin: 'https://comparison.invalid/',
    access_token: 'remote-main-only-secret'
  }
  currentConfig.llm_config.api_profiles = [structuredClone(localProfile)]
  service = new LLMProxySvcImpl()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LLMProxySvcImpl with the production RemoteProjectComparisonClient', () => {
  it('lists configured remote metadata without local profiles or secrets and retains the receipt for chat', async () => {
    fetchMock.mockResolvedValueOnce(metadata())
    const listed = await service.listProfiles({
      includeConfigurationRevision: true,
      comparisonRouting: 'configured'
    })
    expect(listed).toEqual({
      comparisonDestination: { kind: 'remote', origin: 'https://comparison.invalid' },
      profiles: [
        {
          ...remoteProfile,
          deployment: 'cloud',
          configurationRevision: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      ]
    })
    const receipt = listed.profiles[0].configurationRevision!
    expect(receipt).not.toBe(remoteRevision)
    expect(JSON.stringify(listed)).not.toContain(localProfile.id)
    expect(JSON.stringify(listed)).not.toContain('secret')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://comparison.invalid/api/project-comparison/profiles',
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer remote-main-only-secret' },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal)
      }
    )
    fetchMock.mockResolvedValueOnce(result())
    await expect(
      service.chat(
        {
          profileId: listed.profiles[0].id,
          expectedProfileRevision: receipt,
          comparisonRouting: 'configured',
          profileScope: 'agent',
          messages,
          conversationId: 'main-owned-only',
          temperature: 0.6,
          maxOutputTokens: 345
        },
        { signal: new AbortController().signal }
      )
    ).resolves.toEqual({
      content: 'Synthetic remote advice',
      finishReason: 'stop',
      usage: { totalTokens: 12 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://comparison.invalid/api/project-comparison/chat')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer remote-main-only-secret'
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: expect.any(AbortSignal)
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      protocol: 1,
      profileId: remoteProfile.id,
      expectedProfileRevision: remoteRevision,
      messages,
      temperature: 0.6,
      maxOutputTokens: 345
    })
    expect(String(init?.body)).not.toContain(receipt)
    expect(String(init?.body)).not.toContain('main-owned-only')
    expect(String(init?.body)).not.toContain('secret')
    expectNoLocalExecution()
  })

  it.each([
    { sessionUrl: 'https://renderer.invalid/session' },
    { systemPrompt: 'An extra renderer-controlled prompt' },
    { route: {} },
    { apiMode: 'responses' }
  ])('strips only conversationId, not disallowed request fields: %j', async (extra) => {
    const req = await issue()
    await expect(service.chat({ ...req, ...extra } as LLMChatReq)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expectNoLocalExecution()
  })

  it('keeps configured-local and ordinary local profile selection on the existing provider path', async () => {
    currentConfig.use_remote_llm = false
    const listed = await service.listProfiles({
      includeConfigurationRevision: true,
      comparisonRouting: 'configured'
    })
    expect(listed.comparisonDestination).toEqual({ kind: 'local' })
    expect(listed.profiles).toEqual([
      expect.objectContaining({
        id: localProfile.id,
        configurationRevision: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ])
    const controller = new AbortController()
    await expect(
      service.chat(
        {
          comparisonRouting: 'configured',
          profileId: localProfile.id,
          expectedProfileRevision: listed.profiles[0].configurationRevision,
          messages,
          temperature: 0.3,
          maxOutputTokens: 500
        },
        { signal: controller.signal }
      )
    ).resolves.toMatchObject({ content: 'Synthetic local advice' })
    expect(cliFromProfile).toHaveBeenCalledWith(
      localProfile,
      expect.objectContaining({ fetchImpl: expect.any(Function) })
    )
    expect(providerChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        temperature: 0.3,
        maxOutputTokens: 500,
        signal: expect.any(AbortSignal)
      })
    )
    const ordinary = await service.listProfiles({})
    expect(ordinary).not.toHaveProperty('comparisonDestination')
    expect(ordinary.profiles[0]).not.toHaveProperty('configurationRevision')
    await expect(service.chat({ profileId: localProfile.id, messages })).resolves.toMatchObject({
      content: 'Synthetic local advice'
    })
    expect(providerChat).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['origin', 'credential', 'remoteMode'] as const)(
    'rejects a receipt after a main %s change without fetching or falling back',
    async (field) => {
      const req = await issue()
      if (field === 'origin')
        currentConfig.remote_llm_server_config.server_origin = 'https://changed.invalid'
      if (field === 'credential')
        currentConfig.remote_llm_server_config.access_token = 'changed-secret'
      if (field === 'remoteMode') currentConfig.use_remote_llm = false
      await expect(service.chat(req)).rejects.toMatchObject({
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expectNoLocalExecution()
    }
  )

  describe.each(['list', 'chat'] as const)(
    '%s failures never fall back to local code',
    (operation) => {
      it.each([
        { status: 200, code: 'PROTOCOL_UNSUPPORTED' },
        { status: 502, code: 'REMOTE_HTTP_ERROR' },
        { status: 504, code: 'REMOTE_HTTP_ERROR' },
        { status: 409, code: 'PROFILE_CONFIGURATION_CHANGED' },
        { status: 401, code: 'AUTH' }
      ])('fails closed for status $status with $code', async ({ status, code }) => {
        const req = operation === 'chat' ? await issue() : undefined
        fetchMock.mockResolvedValueOnce(
          json(
            {
              profiles: [remoteProfile],
              result: { content: 'Legacy response' },
              error: 'local-provider-only-secret'
            },
            status
          )
        )
        const pending = req
          ? service.chat(req)
          : service.listProfiles({
              includeConfigurationRevision: true,
              comparisonRouting: 'configured'
            })
        const error = await pending.catch((value: unknown) => value)
        expect(error).toMatchObject({ code })
        expect(JSON.stringify(error)).not.toContain('local-provider-only-secret')
        if (status === 502 || status === 504) expect(error).toMatchObject({ payload: { status } })
        expect(fetchMock).toHaveBeenCalledTimes(operation === 'chat' ? 2 : 1)
        expectNoLocalExecution()
      })
    }
  )

  it('pins receiver-local revision verification even when the receiver globally uses remote LLMs', async () => {
    const listed = await service.listProfiles({
      includeConfigurationRevision: true,
      comparisonRouting: 'local'
    })
    expect(listed.comparisonDestination).toEqual({ kind: 'local' })
    const revision = listed.profiles[0].configurationRevision
    expect(revision).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      service.chat({
        comparisonRouting: 'local',
        profileScope: 'agent',
        profileId: localProfile.id,
        expectedProfileRevision: revision,
        conversationId: 'remote-comparison-synthetic-receiver',
        messages
      })
    ).resolves.toMatchObject({ content: 'Synthetic local advice' })
    expect(cliFromProfile).toHaveBeenCalledOnce()
    expect(providerChat).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    currentConfig.llm_config.api_profiles[0].api_key = 'rotated-provider-secret'
    await expect(
      service.chat({
        comparisonRouting: 'local',
        profileId: localProfile.id,
        expectedProfileRevision: revision,
        messages
      })
    ).rejects.toMatchObject({ code: 'PROFILE_CONFIGURATION_CHANGED' })
    expect(providerChat).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates the transport abort signal to the current remote fetch', async () => {
    const req = await issue()
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const outcome = expect(service.chat(req, { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      const signal = fetchMock.mock.calls[1][1]!.signal!
      expect(signal.aborted).toBe(false)
      controller.abort()
      await outcome
      expect(signal.aborted).toBe(true)
      expectNoLocalExecution()
    } finally {
      controller.abort()
      await outcome
    }
  })

  it('cancelConversation aborts the actual current remote fetch when IPC drops transport options, and cleans up for reuse', async () => {
    const req = await issue()
    for (let attempt = 0; attempt < 2; attempt++) {
      fetchMock.mockImplementationOnce(() => new Promise(() => {}))
      // IPC carries the conversation ID, not LLMChatOptions or an AbortSignal.
      const outcome = expect(service.chat(req)).rejects.toMatchObject({ code: 'CANCELLED' })
      try {
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(attempt + 2))
        const [url, init] = fetchMock.mock.calls.at(-1)!
        expect(url).toBe('https://comparison.invalid/api/project-comparison/chat')
        expect(String(init?.body)).not.toContain(req.conversationId!)
        expect(init?.signal?.aborted).toBe(false)
        await expect(
          service.cancelConversation({ conversationId: 'not-current' })
        ).resolves.toEqual({ cancelled: false })
        expect(init?.signal?.aborted).toBe(false)
        await expect(
          service.cancelConversation({ conversationId: req.conversationId! })
        ).resolves.toEqual({ cancelled: true })
        await outcome
        expect(init?.signal?.aborted).toBe(true)
        await expect(
          service.cancelConversation({ conversationId: req.conversationId! })
        ).resolves.toEqual({ cancelled: false })
      } finally {
        await service.cancelConversation({ conversationId: req.conversationId! })
        await outcome
      }
    }
    expectNoLocalExecution()
  })
})
