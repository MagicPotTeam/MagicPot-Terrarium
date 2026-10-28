import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type {
  LLMChatOptions,
  LLMChatReq,
  LLMChatResp,
  LLMListProfilesReq,
  LLMListProfilesResp
} from '@shared/api/svcLLMProxy'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'

let currentConfig: Config
const { chatMock, listProfilesMock, getPathMock, recordUsageMock } = vi.hoisted(() => ({
  chatMock: vi.fn<(req: LLMChatReq, options?: LLMChatOptions) => Promise<LLMChatResp>>(),
  listProfilesMock: vi.fn<(req: LLMListProfilesReq) => Promise<LLMListProfilesResp>>(),
  getPathMock: vi.fn(() => {
    throw new Error('Comparison HTTP tests must not access Electron user data')
  }),
  recordUsageMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock }, net: {} }))
vi.mock('../config/config', () => ({ getConfig: () => currentConfig }))
vi.mock('../api/svcLLMProxyImpl', () => ({
  LLMProxySvcImpl: class {
    chat = chatMock
    listProfiles = listProfilesMock
    serverStatus = vi.fn(async () => ({ online: true }))
  }
}))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../mcp/platform/httpBridge', () => ({
  getConfiguredMcpLegacySseMessagePath: vi.fn(() => '/api/mcp/sse/message'),
  getConfiguredMcpLegacySsePath: vi.fn(() => '/api/mcp/sse'),
  handleMagicPotMcpHttpBridgeRequest: vi.fn(),
  handleMagicPotMcpLegacySseMessageRequest: vi.fn(),
  handleMagicPotMcpLegacySseOpenRequest: vi.fn()
}))
vi.mock('./accessUsage', () => ({ recordLlmProxyAccessUsage: recordUsageMock }))

import { getLLMProxyServerStatus, startLLMProxyServer, stopLLMProxyServer } from './server'

const profilesPath = '/api/project-comparison/profiles'
const chatPath = '/api/project-comparison/chat'
const revision = 'a'.repeat(64)
const safeProfile = {
  id: 'synthetic-profile',
  model_name: 'Synthetic comparison model',
  configurationRevision: revision,
  model_use: 'agent' as const,
  context_budget_tokens: 4000,
  context_window_tokens: 8000
}
const wireRequest = () => ({
  protocol: 1,
  profileId: safeProfile.id,
  expectedProfileRevision: revision,
  messages: [
    { role: 'system' as const, content: 'Compare only the synthetic summaries.' },
    { role: 'user' as const, content: 'Synthetic project A and project B.' }
  ]
})

let origin = ''
const controllers = new Set<AbortController>()
const request = (
  pathname: string,
  init: RequestInit = {},
  token = 'proxy-secret'
): Promise<Response> =>
  fetch(`${origin}${pathname}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(3000),
    headers: {
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  })
const post = (body: unknown, token = 'proxy-secret', signal?: AbortSignal): Promise<Response> =>
  request(
    chatPath,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    },
    token
  )

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  currentConfig = structuredClone(DEFAULT_CONFIG)
  currentConfig.use_remote_llm = true
  currentConfig.local_llm_server_config = {
    ...currentConfig.local_llm_server_config,
    enable_server: true,
    bind_host: '127.0.0.1',
    port: 0,
    access_token: 'retired-proxy-secret',
    access_tokens: [
      {
        id: 'synthetic-client',
        label: 'Synthetic client',
        token: 'proxy-secret',
        resource_scope: 'synthetic'
      }
    ]
  }
  currentConfig.llm_config.api_profiles = [
    {
      id: safeProfile.id,
      model_name: safeProfile.model_name,
      base_url: 'https://provider.invalid/v1',
      api_key: 'provider-only-secret'
    }
  ]
  const serviceMetadata = {
    profiles: [
      {
        ...safeProfile,
        deployment: 'cloud' as const,
        api_key: 'provider-only-secret',
        backup_api_keys: ['backup-only-secret'],
        base_url: 'https://provider.invalid/v1',
        metadata: { secret: 'internal-only' }
      }
    ],
    comparisonDestination: { kind: 'local' as const }
  }
  listProfilesMock.mockReset().mockResolvedValue(serviceMetadata)
  chatMock.mockReset().mockResolvedValue({
    content: 'Synthetic advice',
    finishReason: 'stop',
    usage: { totalTokens: 12 }
  })
  startLLMProxyServer()
  await vi.waitFor(
    () => {
      const status = getLLMProxyServerStatus()
      expect(status.running).toBe(true)
      expect(status.port).toBeGreaterThan(0)
      origin = `http://127.0.0.1:${status.port}`
    },
    { timeout: 3000, interval: 10 }
  )
})

afterEach(() => {
  for (const controller of controllers) controller.abort()
  controllers.clear()
  stopLLMProxyServer()
  expect(getPathMock).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('actual LLM proxy server project comparison routing', () => {
  it.each(['', 'wrong-secret', 'retired-proxy-secret', 'provider-only-secret'])(
    'authenticates both exact endpoints before invoking the service (%j)',
    async (token) => {
      const profiles = await request(profilesPath, {}, token)
      expect(profiles.status).toBe(401)
      await profiles.text()
      // Even invalid JSON must fail authentication before body validation or legacy normalization.
      const chat = await request(chatPath, { method: 'POST', body: '{invalid-json' }, token)
      expect(chat.status).toBe(401)
      await chat.text()
      expect(listProfilesMock).not.toHaveBeenCalled()
      expect(chatMock).not.toHaveBeenCalled()
      expect(recordUsageMock).not.toHaveBeenCalled()
    }
  )

  it('does not treat a hostname with a 127 prefix as an unauthenticated loopback bind', () => {
    stopLLMProxyServer()
    currentConfig.local_llm_server_config = {
      ...currentConfig.local_llm_server_config,
      bind_host: '127.attacker.example',
      access_token: '',
      access_tokens: []
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startLLMProxyServer()
    expect(getLLMProxyServerStatus().running).toBe(false)
    expect(error).toHaveBeenCalledWith(
      '[LLMProxyServer] Refusing non-loopback bind on 127.attacker.example: configure at least one valid proxy access token.'
    )
  })

  it('fails closed for browser origins unless an exact CORS origin is configured', async () => {
    const denied = await request(profilesPath, { headers: { Origin: 'https://evil.example' } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(listProfilesMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()

    currentConfig.local_llm_server_config.cors_allowed_origins = ['https://client.example/']
    const allowed = await request(profilesPath, {
      headers: { Origin: 'https://client.example' }
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://client.example')
    expect(allowed.headers.get('vary')).toContain('Origin')
  })

  it('applies the same allowlist to preflight and rejects wildcard entries', async () => {
    currentConfig.local_llm_server_config.cors_allowed_origins = ['*']
    const denied = await request(profilesPath, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'GET'
      }
    })
    expect(denied.status).toBe(403)

    currentConfig.local_llm_server_config.cors_allowed_origins = ['https://client.example']
    const allowed = await request(profilesPath, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization'
      }
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://client.example')
    expect(allowed.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('returns only safe protocol metadata and explicitly lists receiver-local revisions', async () => {
    const response = await request(profilesPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-magicpot-project-comparison')).toBe('1')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      protocol: 1,
      profiles: [{ ...safeProfile, deployment: 'api' }]
    })
    expect(listProfilesMock).toHaveBeenCalledExactlyOnceWith({
      includeConfigurationRevision: true,
      comparisonRouting: 'local'
    })
    expect(chatMock).not.toHaveBeenCalled()
    expect(recordUsageMock).toHaveBeenCalledExactlyOnceWith(
      {
        tokenId: 'synthetic-client',
        label: 'Synthetic client',
        resourceScope: 'synthetic'
      },
      {
        activity: 'project-comparison',
        requesterAddress: expect.any(String)
      }
    )
    expect(JSON.stringify(recordUsageMock.mock.calls[0])).not.toContain('proxy-secret')
  })

  it('does not bind usage identity to an untrusted forwarded-for header', async () => {
    const response = await request(profilesPath, {
      headers: { 'X-Forwarded-For': '203.0.113.77' }
    })
    expect(response.status).toBe(200)
    await response.text()
    const update = recordUsageMock.mock.calls[0]?.[1] as { requesterAddress?: string }
    expect(update.requesterAddress).toBeDefined()
    expect(update.requesterAddress).not.toBe('203.0.113.77')
    expect(update.requesterAddress).toMatch(/127\.0\.0\.1|::1/)
  })

  it('routes strict text, revision and budgets with an abort signal and fresh main-owned conversation IDs', async () => {
    chatMock.mockResolvedValue({
      content: 'Synthetic advice',
      finishReason: 'stop',
      usage: { totalTokens: 12 },
      sessionUrl: 'https://private.invalid/session',
      metadata: { secret: 'internal-only' }
    })
    for (const options of [{}, { temperature: 0.6, maxOutputTokens: 345 }]) {
      const body = { ...wireRequest(), ...options }
      const response = await post(body)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        protocol: 1,
        result: { content: 'Synthetic advice', finishReason: 'stop', usage: { totalTokens: 12 } }
      })
      const [req, transport] = chatMock.mock.calls.at(-1)!
      expect(req).toEqual({
        profileId: body.profileId,
        expectedProfileRevision: revision,
        messages: body.messages,
        temperature: 0.2,
        maxOutputTokens: 1200,
        ...options,
        profileScope: 'agent',
        comparisonRouting: 'local',
        conversationId: expect.stringMatching(/^remote-comparison-[0-9a-f-]{36}$/)
      })
      expect(transport).toEqual({ signal: expect.any(AbortSignal) })
      expect(transport?.signal?.aborted).toBe(false)
    }
    expect(chatMock.mock.calls[0][0].conversationId).not.toBe(
      chatMock.mock.calls[1][0].conversationId
    )
    expect(listProfilesMock).not.toHaveBeenCalled()
    expect(recordUsageMock).toHaveBeenCalledTimes(2)
    for (const [identity, update] of recordUsageMock.mock.calls) {
      const serialized = JSON.stringify({ identity, update })
      expect(update.activity).toBe('project-comparison')
      expect(serialized).not.toContain('proxy-secret')
      expect(serialized).not.toContain('Synthetic project A and project B.')
    }
  })

  it.each([
    { message: 'Legacy text is not a comparison request' },
    { ...wireRequest(), conversationId: 'renderer-selected-conversation' },
    { ...wireRequest(), comparisonRouting: 'configured' },
    { ...wireRequest(), messages: [{ role: 'user', content: 'Only one message' }] },
    {
      ...wireRequest(),
      messages: [
        { role: 'system', content: 'Synthetic', attachments: [] },
        { role: 'user', content: 'Synthetic' }
      ]
    },
    { ...wireRequest(), maxOutputTokens: 1201 },
    { ...wireRequest(), temperature: 1.1 }
  ])('rejects non-protocol payloads without reaching legacy chat: %j', async (body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid project comparison request.'
    })
    expect(chatMock).not.toHaveBeenCalled()
  })

  it('does not register prefix/suffix aliases or treat GET chat as legacy chat', async () => {
    for (const pathname of [`${chatPath}/`, `${profilesPath}/extra`]) {
      const response = await request(pathname)
      expect(response.status).toBe(404)
      await response.text()
    }
    const response = await request(chatPath)
    expect(response.status).toBe(400)
    await response.text()
    expect(chatMock).not.toHaveBeenCalled()
    expect(listProfilesMock).not.toHaveBeenCalled()
  })

  it('returns a sanitized 409 for a stale revision without retrying or downgrading', async () => {
    chatMock.mockRejectedValue(
      new ServiceError('provider-only-secret stale detail', {
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
    )
    const response = await post(wireRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'PROFILE_CONFIGURATION_CHANGED',
      message: 'Model configuration changed; review and confirm again.'
    })
    expect(chatMock).toHaveBeenCalledOnce()
    expect(listProfilesMock).not.toHaveBeenCalled()
  })

  it('does not let a previously authorized revision reuse a rotated access token', async () => {
    const listed = await request(profilesPath)
    expect(listed.status).toBe(200)
    await listed.text()
    currentConfig.local_llm_server_config.access_tokens![0].token = 'rotated-proxy-secret'
    const denied = await post(wireRequest())
    expect(denied.status).toBe(401)
    await denied.text()
    expect(chatMock).not.toHaveBeenCalled()
    const accepted = await post(wireRequest(), 'rotated-proxy-secret')
    expect(accepted.status).toBe(200)
    await accepted.text()
    expect(chatMock).toHaveBeenCalledOnce()
  })

  it('aborts the actual service signal when the HTTP client disconnects', async () => {
    chatMock.mockImplementation(
      (_req, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
            once: true
          })
        })
    )
    const controller = new AbortController()
    controllers.add(controller)
    const outcome = post(wireRequest(), 'proxy-secret', controller.signal).catch(
      (error: unknown) => error
    )
    try {
      await vi.waitFor(() => expect(chatMock).toHaveBeenCalledOnce())
      const signal = chatMock.mock.calls[0][1]!.signal!
      expect(signal.aborted).toBe(false)
      controller.abort()
      await outcome
      await vi.waitFor(() => expect(signal.aborted).toBe(true))
    } finally {
      controller.abort()
      await outcome
    }
  })

  it('bounds in-flight comparisons at 16, authenticates before capacity, and releases disconnected slots', async () => {
    chatMock.mockImplementation(
      (_req, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
            once: true
          })
        })
    )
    const pending: Promise<unknown>[] = []
    try {
      for (let index = 0; index < 16; index++) {
        const controller = new AbortController()
        controllers.add(controller)
        pending.push(
          post(
            wireRequest(),
            'proxy-secret',
            AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])
          ).catch((error: unknown) => error)
        )
      }
      await vi.waitFor(() => expect(chatMock).toHaveBeenCalledTimes(16), { timeout: 2000 })
      const denied = await request(profilesPath, {}, 'wrong-secret')
      expect(denied.status).toBe(401)
      await denied.text()
      const busy = await request(profilesPath)
      expect(busy.status).toBe(429)
      expect(await busy.json()).toEqual({
        code: 'BUSY',
        message: 'Project comparison capacity reached.'
      })
      expect(listProfilesMock).not.toHaveBeenCalled()
    } finally {
      for (const controller of controllers) controller.abort()
      await Promise.all(pending)
      await vi.waitFor(() =>
        expect(chatMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
      )
    }
    const available = await request(profilesPath)
    expect(available.status).toBe(200)
    await available.text()
    expect(listProfilesMock).toHaveBeenCalledOnce()
  })
})
