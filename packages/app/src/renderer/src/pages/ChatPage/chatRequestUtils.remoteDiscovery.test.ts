import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  type Config,
  type LLMAPIProfile,
  type LLMOpenAIApiMode
} from '@shared/config/config'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatMessage } from '@shared/llm'
import { resolveChatProfileCapabilities } from '@shared/llm'
import { LLMProxySvcImpl } from '../../../../main/api/svcLLMProxyImpl'
import { getConfig } from '../../../../main/config/config'
import { normalizeRemoteLlmProfiles } from '@renderer/utils/llmProfileUtils'
import {
  preflightChatRequestImages,
  requestChatCompletion,
  requestChatCompletionStream,
  resolveAttachmentRequestCapabilities
} from './chatRequestUtils'

// Exercise genuine discovery, normalization, policy and preparation, never a real
// provider, Electron runtime, user config/file, or actual network transport.
vi.mock('electron', () => ({ net: {} }))
vi.mock('node:fs', async () => {
  const { fs } = await import('memfs')
  return { ...fs, default: fs }
})
vi.mock('node:fs/promises', async () => {
  const { fs } = await import('memfs')
  return { ...fs.promises, default: fs.promises }
})
vi.mock('fs/promises', async () => {
  const { fs } = await import('memfs')
  return { ...fs.promises, default: fs.promises }
})
vi.mock('../../../../main/config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn()
}))
vi.mock('../../../../main/assistantRuntime/runtime', () => ({
  getAssistantRuntime: vi.fn(() => ({
    listTools: vi.fn(() => [])
  }))
}))
vi.mock('../../../../main/mcp/runtime', () => ({
  syncMcpClientManager: vi.fn(() => {
    throw new Error('Unexpected MCP sync during discovery')
  })
}))
vi.mock('../../../../main/extensions/generatedRegistry', () => ({
  mainHostExtensionApiV1: { apiServices: [], llmProxy: [] }
}))

const profile: LLMAPIProfile = {
  id: 'remote-only',
  model_name: 'opaque',
  base_url: 'https://api.openai.com/v1',
  api_key: 'fixture-secret-sentinel',
  api_mode: 'auto',
  call_type: 'api',
  provider: 'openai',
  model_use: 'vision',
  attachment_transports: ['request-data-url'],
  supports_session_continuation: true
}
const serverConfig = (overrides: Partial<LLMAPIProfile> = {}): Config => ({
  ...DEFAULT_CONFIG,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ ...profile, ...overrides }] }
})
const clientConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: true,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] },
  remote_llm_server_config: { server_origin: 'https://fixture-proxy.example', access_token: '' }
})
const localClientConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [profile] }
})
const message = (count: number, managed = false): ChatMessage => ({
  role: 'user',
  content: 'Fixture discovery-to-preflight input.',
  attachments: Array.from({ length: count }, (_, index) => ({
    type: 'image',
    url: `local-media:///fixture/reference-${index}.png`,
    ...(managed
      ? {
          media: {
            version: 1 as const,
            kind: 'managed' as const,
            relativePath: `originals/aa/${'a'.repeat(64)}.png`,
            sha256: 'a'.repeat(64),
            sizeBytes: 5,
            mimeType: 'image/png',
            originalFileName: `reference-${index}.png`
          }
        }
      : {})
  }))
  // Real raster validation belongs to separate managed-media tests; no model is called here.
})
const fixture = () => {
  const fetchMock = vi
    .fn<(url: unknown, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (url) => {
      if (url !== 'https://fixture-proxy.example/api/chat') throw new Error('Image fetch sentinel')
      return new Response(
        JSON.stringify({ content: 'Fixture result.', sessionUrl: 'fixture-next' }),
        {
          headers: { 'content-type': 'application/json' }
        }
      )
    })
  const materializeForRequest = vi
    .fn<ManagedMediaSvc['materializeForRequest']>()
    .mockResolvedValue({
      transport: 'request-data-url',
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      mimeType: 'image/png',
      sizeBytes: 5
    })
  vi.stubGlobal('fetch', fetchMock)
  window.api = {
    svcManagedMedia: { materializeForRequest },
    svcLLMProxy: {
      chat: vi.fn(async () => ({ content: 'Fixture local result.' })),
      chatStream: vi.fn(async (_request: unknown, payload: { onData: (data: unknown) => void }) => {
        payload.onData({ type: 'text-delta', delta: 'Fixture local result.' })
        payload.onData({
          type: 'done',
          done: true,
          delta: '',
          fullContent: 'Fixture local result.'
        })
      })
    }
  } as unknown as Window['api']
  return { fetchMock, materializeForRequest }
}
const discover = async (
  overrides: Partial<LLMAPIProfile> & { openai_api_modes?: Record<string, LLMOpenAIApiMode> } = {}
) => {
  vi.mocked(getConfig).mockReturnValue(serverConfig(overrides))
  const listed = await new LLMProxySvcImpl().listProfiles({})
  expect(JSON.stringify(listed)).not.toContain('fixture-secret-sentinel')
  expect(listed.profiles[0]).not.toHaveProperty('base_url')
  const profiles = normalizeRemoteLlmProfiles(listed)
  expect(profiles).toHaveLength(1)
  return profiles[0]
}
const run = (stream: boolean, input: Parameters<typeof requestChatCompletion>[0]) =>
  stream
    ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
    : requestChatCompletion(input)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('actual discovery record through renderer image request preparation', () => {
  it.each([false, true])(
    'accepts 11 managed images under the official Responses Infinity policy (stream=%s)',
    async (_stream) => {
      const f = fixture()
      await discover()
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(
        preflightChatRequestImages({
          config: localClientConfig(),
          profileId: profile.id,
          remoteProfile: undefined,
          apiMode: 'responses',
          messages: [message(11, true)],
          externalAgentSkill: undefined
        })
      ).toBe(Infinity)
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'allows the discovered within-limit managed transport and continuation (stream=%s)',
    async (stream) => {
      const f = fixture(),
        remoteProfile = await discover()
      expect(resolveChatProfileCapabilities(remoteProfile)).toMatchObject({
        supportsSessionContinuation: false,
        attachmentTransports: ['request-data-url']
      })
      expect(
        resolveChatProfileCapabilities({
          ...remoteProfile,
          api_mode: 'chat-completions',
          base_url: 'https://openai-compatible.example/v1',
          openai_api_modes: {
            default: 'chat-completions',
            auto: 'chat-completions',
            responses: 'chat-completions',
            'chat-completions': 'chat-completions',
            images: 'chat-completions'
          },
          supports_session_continuation: true
        })
      ).toMatchObject({ supportsSessionContinuation: true })
      const continuationProfile = await discover({
        api_mode: 'chat-completions',
        base_url: 'https://openai-compatible.example/v1/chat/completions',
        supports_session_continuation: true
      })
      expect(
        (
          continuationProfile as typeof continuationProfile & {
            openai_api_modes?: Record<string, LLMOpenAIApiMode>
          }
        ).openai_api_modes
      ).toMatchObject({ default: 'chat-completions' })
      expect(resolveChatProfileCapabilities(continuationProfile).supportsSessionContinuation).toBe(
        true
      )
      await expect(
        run(stream, {
          config: clientConfig(),
          profileId: profile.id,
          remoteProfile: continuationProfile,
          messages: [message(10, true)],
          sessionUrl: 'fixture-prior'
        })
      ).resolves.toBeDefined()
      expect(f.materializeForRequest).toHaveBeenCalledTimes(10)
      expect(
        f.materializeForRequest.mock.calls.every(
          ([request]) => request.transport === 'request-data-url'
        )
      ).toBe(true)
      expect(f.fetchMock).toHaveBeenCalledTimes(1)
      const body = JSON.parse(String(f.fetchMock.mock.calls[0][1]?.body))
      expect(body).toMatchObject({
        profileId: profile.id,
        apiMode: 'chat-completions',
        sessionUrl: 'fixture-prior'
      })
      expect(body.messages[0].attachments).toHaveLength(10)
      expect(JSON.stringify(body)).not.toContain('fixture-secret-sentinel')
      expect(body).not.toHaveProperty('remoteProfile')
      expect(body).not.toHaveProperty('openai_api_modes')
    }
  )

  it('checks the actual remote standard Responses override despite a configured Images mode', async () => {
    const f = fixture(),
      remoteProfile = await discover({
        api_mode: 'images',
        model_use: 'chat',
        attachment_transports: ['request-data-url']
      })
    expect(
      preflightChatRequestImages({
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        messages: [message(11, true)],
        apiMode: 'responses'
      })
    ).toBe(Infinity)
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('checks Zen actual Responses even when an override asks for Images', async () => {
    const f = fixture(),
      remoteProfile = await discover({
        base_url: 'https://opencode.ai/zen/v1',
        model_name: 'o3',
        provider: 'claude',
        api_mode: 'responses',
        attachment_transports: ['request-data-url']
      })
    expect(
      preflightChatRequestImages({
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        messages: [message(11, true)],
        apiMode: 'responses'
      })
    ).toBe(Infinity)
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'does not grant Images transport for a within-limit Zen Responses override (stream=%s)',
    async (stream) => {
      const f = fixture()
      const remoteProfile = await discover({
        base_url: 'https://opencode.ai/zen/v1',
        model_name: 'o3',
        api_mode: 'images',
        attachment_transports: []
      })
      expect(
        resolveAttachmentRequestCapabilities(clientConfig(), profile.id, 'images', remoteProfile)
      ).toEqual({
        allowManagedRequestDataUrl: false,
        allowRequestDataUrl: false,
        allowAccessibleUrl: false,
        preserveRemoteUrl: false
      })
      await expect(
        run(stream, {
          config: clientConfig(),
          profileId: profile.id,
          remoteProfile,
          apiMode: 'images',
          messages: [message(1, true)]
        })
      ).rejects.toThrow('Unable to prepare attachment')
      expect(f.materializeForRequest).not.toHaveBeenCalled()
      expect(f.fetchMock).not.toHaveBeenCalled()
    }
  )

  it('allows declared Zen transport without acquiring Images URL privileges', async () => {
    const f = fixture()
    const remoteProfile = await discover({
      base_url: 'https://opencode.ai/zen/v1',
      model_name: 'o3',
      api_mode: 'images'
    })
    expect(
      resolveAttachmentRequestCapabilities(clientConfig(), profile.id, 'images', remoteProfile)
    ).toEqual({
      allowManagedRequestDataUrl: true,
      allowRequestDataUrl: true,
      allowAccessibleUrl: false,
      preserveRemoteUrl: false
    })
    await expect(
      run(false, {
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        apiMode: 'images',
        messages: [message(1, true)]
      })
    ).resolves.toMatchObject({ content: 'Fixture result.' })
    expect(f.materializeForRequest).toHaveBeenCalledTimes(1)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retains Images reference transport when the actual auto override routes to Images', async () => {
    const f = fixture()
    const remoteProfile = await discover({
      base_url: 'https://api.openai.com/v1/images/generations',
      model_name: 'opaque',
      model_use: 'chat',
      api_mode: 'responses',
      attachment_transports: []
    })
    expect(remoteProfile).toMatchObject({
      base_url: '',
      openai_api_modes: { default: 'responses', auto: 'images' }
    })
    expect(
      resolveAttachmentRequestCapabilities(clientConfig(), profile.id, 'auto', remoteProfile)
    ).toEqual({
      allowManagedRequestDataUrl: true,
      allowRequestDataUrl: true,
      allowAccessibleUrl: false,
      preserveRemoteUrl: true
    })
    await expect(
      run(false, {
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        apiMode: 'auto',
        messages: [message(1, true)]
      })
    ).resolves.toMatchObject({ content: 'Fixture result.' })
    expect(f.materializeForRequest).toHaveBeenCalledTimes(1)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['responses', false],
    ['responses', true],
    ['chat-completions', false],
    ['chat-completions', true]
  ] as const)(
    'carries discovered %s URLs through renderer, receiving validator and real serializer (stream=%s)',
    async (apiMode, stream) => {
      const remoteProfile = await discover({
        api_mode: apiMode,
        call_type: 'api',
        // The built-in Chat Completions client takes a full configured endpoint.
        base_url: 'https://api.openai.com/v1/chat/completions',
        attachment_transports: ['accessible-url']
      })
      expect(remoteProfile).toMatchObject({
        base_url: '',
        provider: 'openai',
        api_mode: apiMode,
        openai_api_modes: {
          default: apiMode
        }
      })
      const proxyBodies: unknown[] = []
      const publicUrl = 'https://cdn.example/fixture.png?signature=preserve'
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (url !== 'https://fixture-proxy.example/api/chat') {
          throw new Error('Unexpected composed discovery destination')
        }
        proxyBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ content: 'Fixture composed result.' })
      })
      const materializeForRequest = vi.fn()
      window.api = {
        svcManagedMedia: { materializeForRequest },
        svcLLMProxy: {
          chat: vi.fn(async () => ({ content: 'Fixture local result.' })),
          chatStream: vi.fn(
            async (_request: unknown, receiver: { onData: (data: unknown) => void }) => {
              receiver.onData({
                type: 'text-delta',
                delta: 'Fixture composed result.',
                fullContent: 'Fixture composed result.',
                done: false
              })
              receiver.onData({
                type: 'done',
                done: true,
                delta: '',
                fullContent: 'Fixture composed result.',
                content: 'Fixture composed result.'
              })
            }
          )
        }
      } as unknown as Window['api']
      vi.stubGlobal('fetch', fetchMock)
      const response = await run(stream, {
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        messages: [
          {
            role: 'user',
            content: 'Fixture input.',
            attachments: [{ type: 'image', url: publicUrl }]
          }
        ]
      })
      expect(stream ? (response as { result: unknown }).result : response).toMatchObject({
        content: 'Fixture composed result.'
      })
      expect(materializeForRequest).not.toHaveBeenCalled()
      const usesLocalResponsesStream = apiMode === 'responses' && stream
      expect(fetchMock).toHaveBeenCalledTimes(usesLocalResponsesStream ? 0 : 1)
      expect(proxyBodies).toHaveLength(usesLocalResponsesStream ? 0 : 1)
      if (!usesLocalResponsesStream) {
        expect(proxyBodies[0]).toMatchObject({ profileId: profile.id, apiMode })
      }
      expect(JSON.stringify(proxyBodies)).not.toContain('fixture-secret-sentinel')
      expect(JSON.stringify(proxyBodies)).not.toContain('openai_api_modes')
    }
  )

  it('does not apply Responses count policy to actual remote Chat Completions', async () => {
    const f = fixture(),
      remoteProfile = await discover({ api_mode: 'chat-completions' })
    await expect(
      run(false, {
        config: clientConfig(),
        profileId: profile.id,
        remoteProfile,
        messages: [message(11, true)]
      })
    ).resolves.toMatchObject({ content: 'Fixture result.' })
    expect(f.materializeForRequest).toHaveBeenCalledTimes(11)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })
})
