import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { createBinaryChunkTransport } from '@shared/binaryChunkProtocol'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { validateImageRequestImageDescriptors } from '@shared/llm/imageRequestContract'
import * as configModule from '../config/config'
import type { AssistantRuntime } from '../assistantRuntime/runtime'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { tripoMainLlmProxyExtension } from '../extensions/tripoMainExtension'
import {
  clearTrustedLocalFileSelectionsForTest,
  rememberTrustedLocalFileSelections
} from './trustedFileSelection'
import {
  createElectronRequestFetch,
  type ElectronClientRequestLike,
  LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE,
  LLMProxySvcImpl,
  materializeChunkedBinaryAttachments
} from './svcLLMProxyImpl'

const {
  generateFromMessagesMock,
  tripoGenerateFromMessagesMock,
  Hunyuan3DClientMock,
  Tripo3DClientMock,
  clearHy3dCosPrefixMock,
  uploadLocalHy3dModelMock,
  uploadBufferedHy3dModelMock,
  signHy3dCosModelMock,
  fetchMock,
  useActualHunyuan3DClient,
  listToolsMock,
  callToolMock,
  webContentsFromIdMock,
  browserWindowFromWebContentsMock
} = vi.hoisted(() => ({
  generateFromMessagesMock: vi.fn(),
  tripoGenerateFromMessagesMock: vi.fn(),
  Hunyuan3DClientMock: vi.fn(),
  Tripo3DClientMock: vi.fn(),
  clearHy3dCosPrefixMock: vi.fn(),
  uploadLocalHy3dModelMock: vi.fn(),
  uploadBufferedHy3dModelMock: vi.fn(),
  signHy3dCosModelMock: vi.fn(),
  fetchMock: vi.fn(),
  useActualHunyuan3DClient: { current: false },
  listToolsMock: vi.fn(),
  callToolMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn()
}))

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

vi.mock(import('@shared/llm'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/llm')>()
  return {
    ...actual,
    cliFromProfile: vi.fn()
  }
})

vi.mock(import('../llmProxy/hunyuan3dClient'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmProxy/hunyuan3dClient')>()
  return {
    Hunyuan3DClient: Hunyuan3DClientMock.mockImplementation(function MockHunyuan3DClient(
      ...args: ConstructorParameters<typeof actual.Hunyuan3DClient>
    ) {
      if (useActualHunyuan3DClient.current) {
        return new actual.Hunyuan3DClient(...args)
      }
      return {
        generateFromMessages: generateFromMessagesMock
      }
    })
  }
})

vi.mock(import('../llmProxy/tripo3dClient'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmProxy/tripo3dClient')>()
  return {
    ...actual,
    Tripo3DClient: Tripo3DClientMock.mockImplementation(function MockTripo3DClient() {
      return {
        generateFromMessages: tripoGenerateFromMessagesMock
      }
    })
  }
})

vi.mock(import('../llmProxy/hunyuan3dCos'), () => ({
  signHy3dCosModel: signHy3dCosModelMock,
  uploadBufferedHy3dModel: uploadBufferedHy3dModelMock,
  uploadLocalHy3dModel: uploadLocalHy3dModelMock,
  clearHy3dCosPrefix: clearHy3dCosPrefixMock
}))

vi.mock(import('../assistantRuntime/runtime'), () => ({
  getAssistantRuntime: vi.fn(
    () =>
      ({
        listTools: listToolsMock,
        callTool: callToolMock
      }) as unknown as AssistantRuntime
  )
}))

vi.mock(import('../mcp/runtime'), () => ({
  syncMcpClientManager: vi.fn(async () => undefined)
}))

// Minimal Electron surface: `net` is preserved for the fetch fallback; `webContents.fromId` and
// `BrowserWindow.fromWebContents` default to undefined so the canvas approval helper is a no-op for
// the old relative-path fixtures (no native confirmation is needed there). Eligible-window tests
// override these to return a live sender/parent.
vi.mock('electron', () => ({
  net: {},
  webContents: { fromId: webContentsFromIdMock },
  BrowserWindow: { fromWebContents: browserWindowFromWebContentsMock }
}))

const mockConfig = (overrides: Partial<Config>): void => {
  vi.mocked(configModule.getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    ...overrides,
    llm_config: {
      ...DEFAULT_CONFIG.llm_config,
      ...(overrides.llm_config || {})
    },
    plugin_config: {
      ...DEFAULT_CONFIG.plugin_config!,
      ...(overrides.plugin_config || {})
    }
  } as Config)
}

const mockAgentProfile = (): void => {
  mockConfig({
    llm_config: {
      ...DEFAULT_CONFIG.llm_config,
      api_profiles: [
        {
          id: 'agent-profile',
          model_name: 'Agent Model',
          base_url: 'https://agent.example/v1',
          api_key: 'agent-key'
        }
      ]
    }
  })
}

const mockHunyuanCredentials = (
  overrides: Partial<NonNullable<Config['aigc3d_config']>> = {}
): void => {
  mockConfig({
    aigc3d_config: {
      ...DEFAULT_CONFIG.aigc3d_config!,
      tencent_secret_id: 'secret-id',
      tencent_secret_key: 'secret-key',
      api_region: 'ap-shanghai',
      cos_region: 'ap-guangzhou',
      ...overrides
    }
  })
}

describe('createElectronRequestFetch', () => {
  it('writes large JSON bodies through Electron ClientRequest and maps the response', async () => {
    const requestEvents = new EventEmitter()
    const responseEvents = new EventEmitter() as EventEmitter & {
      headers: Record<string, string[]>
      statusCode: number
      statusMessage: string
    }
    responseEvents.headers = { 'content-type': ['application/json'], 'x-test': ['ok'] }
    responseEvents.statusCode = 200
    responseEvents.statusMessage = 'OK'

    const headers = new Map<string, string>()
    let writtenBody: Buffer | undefined
    const clientRequest = Object.assign(requestEvents, {
      abort: vi.fn(),
      end: vi.fn((chunk?: string | Buffer) => {
        writtenBody = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      }),
      setHeader: vi.fn((name: string, value: string) => headers.set(name, value))
    }) as unknown as ElectronClientRequestLike
    const requestFactory = vi.fn(() => clientRequest)
    const fetchImpl = createElectronRequestFetch(requestFactory)
    const payload = JSON.stringify({ image: 'x'.repeat(1_000_000) })

    const responsePromise = fetchImpl('https://example.com/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: payload
    })
    await vi.waitFor(() => expect(clientRequest.end).toHaveBeenCalledOnce())
    requestEvents.emit('response', responseEvents)
    responseEvents.emit('data', Buffer.from('{"ok":'))
    const response = await responsePromise
    responseEvents.emit('data', Buffer.from('true}'))
    responseEvents.emit('end')

    expect(requestFactory).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://example.com/responses',
      redirect: 'follow'
    })
    expect(writtenBody?.toString()).toBe(payload)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.has('content-length')).toBe(false)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-test')).toBe('ok')
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('aborts Electron ClientRequest when the Fetch signal is aborted', async () => {
    const requestEvents = new EventEmitter()
    const clientRequest = Object.assign(requestEvents, {
      abort: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn()
    }) as unknown as ElectronClientRequestLike
    const fetchImpl = createElectronRequestFetch(() => clientRequest)
    const controller = new AbortController()
    const responsePromise = fetchImpl('https://example.com/responses', {
      method: 'POST',
      body: '{}',
      signal: controller.signal
    })

    await vi.waitFor(() => expect(clientRequest.end).toHaveBeenCalledOnce())
    controller.abort()

    await expect(responsePromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(clientRequest.abort).toHaveBeenCalledOnce()
  })
})

describe('LLMProxySvcImpl', () => {
  it('materializes chunked binary attachments into canonical provider data URLs', async () => {
    const payload = Uint8Array.from([0, 1, 2, 3, 4])
    const transport = await createBinaryChunkTransport(payload, {
      mimeType: 'application/octet-stream',
      chunkSize: 2
    })
    const result = await materializeChunkedBinaryAttachments({
      messages: [
        {
          role: 'user',
          content: 'file',
          attachments: [
            {
              type: 'file',
              url: 'local-media://managed/file',
              media: {
                version: 1,
                kind: 'managed',
                relativePath: 'originals/aa/managed-file.bin'
              },
              binary: { transport: 'chunked-binary-v1', ...transport }
            }
          ]
        }
      ]
    })

    const attachment = result.messages[0].attachments?.[0]
    expect(attachment).toMatchObject({
      type: 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: payload.byteLength,
      url: 'data:application/octet-stream;base64,AAECAwQ='
    })
    expect(attachment).not.toHaveProperty('binary')
    expect(attachment).not.toHaveProperty('media')
  })

  it('accepts out-of-order frames while preserving the assembled object', async () => {
    const transport = await createBinaryChunkTransport(Uint8Array.from([10, 11, 12, 13]), {
      mimeType: 'application/octet-stream',
      chunkSize: 2
    })
    const result = await materializeChunkedBinaryAttachments({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'file',
              url: '',
              binary: {
                transport: 'chunked-binary-v1',
                reference: transport.reference,
                chunks: [...transport.chunks].reverse()
              }
            }
          ]
        }
      ]
    })
    expect(result.messages[0].attachments?.[0].url).toBe(
      'data:application/octet-stream;base64,CgsMDQ=='
    )
  })

  it('rejects malformed chunk sets and unknown binary transports at the boundary', async () => {
    const transport = await createBinaryChunkTransport(Uint8Array.from([1, 2, 3, 4]), {
      mimeType: 'application/octet-stream',
      chunkSize: 2
    })
    await expect(
      materializeChunkedBinaryAttachments({
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'file',
                url: '',
                binary: {
                  transport: 'chunked-binary-v1',
                  reference: transport.reference,
                  chunks: [transport.chunks[0], transport.chunks[0]]
                }
              }
            ]
          }
        ]
      })
    ).rejects.toThrow(/invalid chunked binary payload/i)

    await expect(
      materializeChunkedBinaryAttachments({
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'file',
                url: '',
                binary: { transport: 'unknown' }
              } as never
            ]
          }
        ]
      })
    ).rejects.toThrow(/unknown or malformed binary attachment transport/i)
  })

  it('rejects oversized chunked objects before allocating their payload', async () => {
    await expect(
      materializeChunkedBinaryAttachments({
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'file',
                url: '',
                binary: {
                  transport: 'chunked-binary-v1',
                  reference: {
                    version: 1,
                    kind: 'content-addressed-binary',
                    sha256: '0'.repeat(64),
                    sizeBytes: 64 * 1024 * 1024 + 1,
                    mimeType: 'application/octet-stream',
                    chunkSize: 256 * 1024,
                    chunkCount: 1
                  },
                  chunks: []
                }
              }
            ]
          }
        ]
      })
    ).rejects.toThrow(/exceeds the 67108864 byte request limit/i)
  })

  it('allows main-process LLM extensions to normalize requests and provide clients', async () => {
    const extensionChat = vi.fn().mockResolvedValue({ content: 'extension response' })
    const createCli = vi.fn().mockReturnValue({ chat: extensionChat })
    const normalizeRequestedProfileId = vi.fn((profileId: string | undefined) =>
      profileId === 'alias-profile' ? 'agent-profile' : undefined
    )

    mainHostExtensionApiV1.llmProxy.push({
      id: 'test-extension',
      createCli,
      normalizeRequestedProfileId
    })
    vi.mocked(cliFromProfile).mockReturnValue(undefined as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'alias-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(normalizeRequestedProfileId).toHaveBeenCalledWith('alias-profile')
    expect(createCli).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-profile',
        model_name: 'Agent Model'
      }),
      expect.objectContaining({
        config: expect.any(Object),
        fetchImpl: expect.any(Function),
        rawProfileId: 'alias-profile',
        requestedProfileId: 'agent-profile'
      })
    )
    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(extensionChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'hello' }],
        // Stateless requests must still opt into the main-owned transient
        // provider retry policy; a conversation id is not required for this.
        retryCapacity: true
      })
    )
    expect(resp).toEqual({ content: 'extension response' })
  })

  it('does not impose built-in inline-image assumptions on extension-created clients', async () => {
    const extensionChat = vi.fn().mockResolvedValue('extension image response')
    mainHostExtensionApiV1.llmProxy.push({
      id: 'test-image-extension',
      createCli: () => ({ chat: extensionChat }) as never
    })
    vi.mocked(cliFromProfile).mockReturnValue(undefined as never)
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'extension-ollama',
            model_name: 'extension-model',
            base_url: 'https://extension.example',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    const response = await new LLMProxySvcImpl().chat({
      profileId: 'extension-ollama',
      messages: [
        {
          role: 'user',
          content: 'extension-owned image',
          attachments: [
            { type: 'image', url: 'https://extension.example/image.png', mimeType: 'image/png' }
          ]
        }
      ]
    })

    expect(extensionChat).toHaveBeenCalledOnce()
    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(response.content).toBe('extension image response')
  })

  it('allows main-process LLM extensions to transform runtime profile listings', async () => {
    const transformListedProfiles = vi.fn((profiles) => [
      ...profiles,
      {
        id: 'agent-profile::variant',
        base_profile_id: 'agent-profile',
        model_name: 'Agent Variant',
        deployment: 'cloud' as const,
        model_use: 'chat' as const
      }
    ])
    mainHostExtensionApiV1.llmProxy.push({
      id: 'test-profile-list',
      transformListedProfiles
    })
    mockAgentProfile()

    const profiles = await new LLMProxySvcImpl().listProfiles({})

    expect(transformListedProfiles).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'agent-profile', model_name: 'Agent Model' })],
      expect.objectContaining({ config: expect.any(Object), fetchImpl: expect.any(Function) })
    )
    expect(profiles.profiles).toContainEqual(
      expect.objectContaining({
        id: 'agent-profile::variant',
        base_profile_id: 'agent-profile',
        model_name: 'Agent Variant'
      })
    )
  })

  it('allows main-process LLM extensions to short-circuit chat requests', async () => {
    const handleChatRequest = vi.fn().mockReturnValue({ content: 'handled by extension' })
    mainHostExtensionApiV1.llmProxy.push({
      id: 'test-handler',
      handleChatRequest
    })

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(handleChatRequest).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'agent-profile' }),
      expect.objectContaining({
        config: expect.any(Object),
        fetchImpl: expect.any(Function),
        rawProfileId: 'agent-profile',
        requestedProfileId: 'agent-profile'
      })
    )
    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(resp).toEqual({ content: 'handled by extension' })
  })

  afterEach(() => {
    mainHostExtensionApiV1.apiServices.splice(0)
    mainHostExtensionApiV1.llmProxy.splice(
      0,
      mainHostExtensionApiV1.llmProxy.length,
      tripoMainLlmProxyExtension
    )
    clearTrustedLocalFileSelectionsForTest()
    useActualHunyuan3DClient.current = false
    fetchMock.mockReset()
    listToolsMock.mockReset()
    callToolMock.mockReset()
    webContentsFromIdMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps normal chat on Agent API profiles even when Quick App profiles are present', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system prompt'
    })

    expect(cliFromProfile).toHaveBeenCalledTimes(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(cliFromProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-profile'
      })
    )
    expect(agentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        imageGenerationOptions: undefined,
        imageHistoryPolicy: undefined,
        imageRequest: undefined,
        maxOutputTokens: undefined,
        messages: [{ role: 'user', content: 'hello' }],
        onDelta: expect.any(Function),
        reasoningEffort: undefined,
        retryCapacity: true,
        sessionUrl: undefined,
        signal: undefined,
        systemPrompt: 'system prompt',
        temperature: undefined,
        videoGenerationOptions: undefined
      })
    )
    expect(agentChat.mock.calls[0]?.[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(resp.content).toBe('agent response')
  })

  it('uses Quick App API profiles when the request asks for qapp profile scope', async () => {
    const quickChat = vi.fn().mockResolvedValue('quick response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: quickChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileScope: 'qapp',
      profileId: 'quick-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-profile',
        model_name: 'Quick Model',
        base_url: 'https://quick.example/v1',
        api_key: 'quick-key'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(quickChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        imageGenerationOptions: undefined,
        imageHistoryPolicy: undefined,
        imageRequest: undefined,
        maxOutputTokens: undefined,
        messages: [{ role: 'user', content: 'hello' }],
        onDelta: expect.any(Function),
        reasoningEffort: undefined,
        retryCapacity: true,
        sessionUrl: undefined,
        signal: undefined,
        systemPrompt: undefined,
        temperature: undefined,
        videoGenerationOptions: undefined
      })
    )
    expect(quickChat.mock.calls[0]?.[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(resp.content).toBe('quick response')
  })

  it('skips video-only Quick App profiles for default qapp text routing', async () => {
    const quickChat = vi.fn().mockResolvedValue('quick response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: quickChat } as never)

    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            model_use: 'video'
          },
          {
            id: 'quick-text',
            model_name: 'Quick Text Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileScope: 'qapp',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-text',
        model_name: 'Quick Text Model'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(resp.content).toBe('quick response')
  })

  it('rejects default qapp text routing when only video Quick App profiles are configured', async () => {
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            model_use: 'video'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileScope: 'qapp',
        messages: [{ role: 'user', content: 'hello' }]
      })
    ).rejects.toThrow('No suitable LLM profile available')
  })

  it('preserves video attachments from API profile clients', async () => {
    const videoChat = vi.fn().mockResolvedValue({
      content: '',
      attachments: [
        {
          type: 'video',
          url: 'https://cdn.example/video.mp4',
          mimeType: 'video/mp4',
          fileName: 'video.mp4'
        }
      ]
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: videoChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'video-profile',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            model_use: 'video'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'video-profile',
      messages: [{ role: 'user', content: 'make a video' }]
    })

    expect(resp.content).toBe('')
    expect(resp.attachments).toEqual([
      {
        type: 'video',
        url: 'https://cdn.example/video.mp4',
        mimeType: 'video/mp4',
        fileName: 'video.mp4'
      }
    ])
  })

  it('forwards videoGenerationOptions exactly to the selected video client', async () => {
    const videoChat = vi.fn().mockResolvedValue({
      content: '',
      attachments: [
        {
          type: 'video',
          url: 'https://cdn.example/video.mp4',
          mimeType: 'video/mp4',
          fileName: 'video.mp4'
        }
      ]
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: videoChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'video-profile',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            model_use: 'video'
          }
        ]
      }
    })

    const videoGenerationOptions = {
      duration: 5,
      callbackUrl: 'https://webhook.example/kling',
      externalTaskId: 'external-123',
      cameraSimpleControls: { horizontal: 3 },
      advancedJson: {
        shot_type: 'multi',
        multi_shot: true
      },
      requestOverride: {
        mode: 'pro'
      }
    }

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'video-profile',
      messages: [{ role: 'user', content: 'make a video' }],
      videoGenerationOptions
    })

    expect(videoChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        imageGenerationOptions: undefined,
        imageHistoryPolicy: undefined,
        imageRequest: undefined,
        maxOutputTokens: undefined,
        messages: [{ role: 'user', content: 'make a video' }],
        onDelta: expect.any(Function),
        reasoningEffort: undefined,
        sessionUrl: undefined,
        signal: undefined,
        systemPrompt: undefined,
        temperature: undefined,
        videoGenerationOptions
      })
    )
    expect(videoChat.mock.calls[0]?.[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('passes AbortSignal through to the selected LLM client', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const controller = new AbortController()
    const svc = new LLMProxySvcImpl()
    await svc.chat(
      {
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'hello' }]
      },
      {
        signal: controller.signal
      }
    )

    expect(agentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: undefined,
        signal: expect.any(AbortSignal)
      })
    )
    expect(agentChat.mock.calls[0]?.[0]?.signal).not.toBe(controller.signal)
    expect(agentChat.mock.calls[0]?.[0]?.signal?.aborted).toBe(false)
  })

  it('rejects a duplicate conversation request without replacing or cancelling the original', async () => {
    let resolveOriginal!: (value: string) => void
    let originalSignal: AbortSignal | undefined
    const originalResult = new Promise<string>((resolve) => {
      resolveOriginal = resolve
    })
    const agentChat = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      originalSignal = signal
      return originalResult
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const original = svc.chat({
      conversationId: 'conversation-duplicate',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'first' }]
    })
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1))

    await expect(
      svc.chat({
        conversationId: 'conversation-duplicate',
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'second' }]
      })
    ).rejects.toMatchObject({
      code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE,
      message: 'A request is already active for conversation "conversation-duplicate".'
    })

    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(originalSignal?.aborted).toBe(false)

    resolveOriginal('first response')
    await expect(original).resolves.toEqual({ content: 'first response' })
  })

  it('keeps the original duplicate-guarded request cancellable', async () => {
    let originalSignal: AbortSignal | undefined
    const agentChat = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          originalSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          )
        })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const original = svc.chat({
      conversationId: 'conversation-cancellable',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'first' }]
    })
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1))

    await expect(
      svc.chat({
        conversationId: 'conversation-cancellable',
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'second' }]
      })
    ).rejects.toMatchObject({ code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE })

    await expect(
      svc.cancelConversation({ conversationId: 'conversation-cancellable' })
    ).resolves.toEqual({ cancelled: true })
    await expect(original).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Conversation cancelled by the user.'
    })
    expect(originalSignal?.aborted).toBe(true)
  })

  it('allows a conversationId to be reused after the active request completes', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('first response')
      .mockResolvedValueOnce('second response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const request = {
      conversationId: 'conversation-reusable',
      profileId: 'agent-profile',
      messages: [{ role: 'user' as const, content: 'hello' }]
    }

    await expect(svc.chat(request)).resolves.toEqual({ content: 'first response' })
    await expect(svc.chat(request)).resolves.toEqual({ content: 'second response' })
    expect(agentChat).toHaveBeenCalledTimes(2)
  })

  it('reuses a cancelled chat while its provider drains without letting stale cleanup or cancel touch the new owner', async () => {
    const resolvers: Array<(value: string) => void> = []
    const signals: Array<AbortSignal | undefined> = []
    const agentChat = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      signals.push(signal)
      return new Promise<string>((resolve) => resolvers.push(resolve))
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    mockAgentProfile()
    const svc = new LLMProxySvcImpl()
    const request = {
      conversationId: 'cancel-then-send',
      profileId: 'agent-profile',
      messages: [{ role: 'user' as const, content: 'Owned fixture' }]
    }
    const old = svc.chat({ ...request, cancellationId: 'first-request' }).catch((error) => error)
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1))
    expect(await svc.cancelConversation({ ...request, cancellationId: 'first-request' })).toEqual({
      cancelled: true
    })

    const next = svc.chat({ ...request, cancellationId: 'second-request' })
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    resolvers[0]('A cancelled provider completed late')
    expect(await old).toMatchObject({ name: 'AbortError' })
    await expect(svc.chat({ ...request, cancellationId: 'third-request' })).rejects.toMatchObject({
      code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE
    })
    expect(await svc.cancelConversation({ ...request, cancellationId: 'first-request' })).toEqual({
      cancelled: false
    })
    expect(signals[1]?.aborted).toBe(false)
    resolvers[1]('The new request owns this response')
    await expect(next).resolves.toEqual({ content: 'The new request owns this response' })
  })

  it.each(['success', 'failure'] as const)(
    'releases a local stream before its %s terminal callback starts the next request',
    async (outcome) => {
      const agentChat = vi.fn()
      if (outcome === 'success') agentChat.mockResolvedValueOnce('First response')
      else agentChat.mockRejectedValueOnce(new Error('Owned provider failure'))
      agentChat.mockResolvedValueOnce('Next response')
      vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
      mockAgentProfile()
      const svc = new LLMProxySvcImpl()
      const request = {
        conversationId: `stream-terminal-${outcome}`,
        profileId: 'agent-profile',
        messages: [{ role: 'user' as const, content: 'Owned fixture' }]
      }
      let next: ReturnType<LLMProxySvcImpl['chat']> | undefined
      await svc.chatStream(
        { ...request, cancellationId: 'first-stream' },
        {
          onData: (event) => {
            if (event.type === 'done') {
              next = svc.chat({ ...request, cancellationId: 'next-request' })
              void next.catch(() => undefined)
            }
          }
        }
      )
      expect(next).toBeDefined()
      await expect(next).resolves.toEqual({ content: 'Next response' })
      expect(agentChat).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['chat', false],
    ['chat', true],
    ['chatStream', false],
    ['chatStream', true]
  ] as const)(
    'never dispatches late cancelled %s provider tool calls (native: %s) into a successor request',
    async (method, nativeTools) => {
      mockAgentProfile()
      listToolsMock.mockReturnValue([
        { name: 'files.write', description: 'Owned fixture write', inputSchema: { type: 'object' } }
      ])
      const resolvers: Array<(value: unknown) => void> = []
      const signals: Array<AbortSignal | undefined> = []
      const agentChat = vi.fn(({ signal }: { signal?: AbortSignal }) => {
        signals.push(signal)
        return new Promise((resolve) => resolvers.push(resolve))
      })
      vi.mocked(cliFromProfile).mockReturnValue({
        supportsNativeTools: nativeTools,
        chat: agentChat
      } as never)
      const svc = new LLMProxySvcImpl()
      const request = {
        conversationId: `late-tool-${method}-${nativeTools}`,
        profileId: 'agent-profile',
        messages: [{ role: 'user' as const, content: 'Owned tool cancellation fixture' }],
        skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.write'] }] }
      }
      const oldEvents: Array<{ type: string; finishReason?: string }> = []
      const oldRequest = { ...request, cancellationId: 'cancelled-owner' }
      const old = (
        method === 'chat'
          ? svc.chat(oldRequest)
          : svc.chatStream(oldRequest, {
              onData: (event) => {
                oldEvents.push(event)
              }
            })
      ).catch((error: unknown) => error)
      await vi.waitFor(() => expect(agentChat).toHaveBeenCalledOnce())
      expect(
        await svc.cancelConversation({
          conversationId: request.conversationId,
          cancellationId: 'cancelled-owner'
        })
      ).toEqual({ cancelled: true })
      const next = svc.chat({ ...request, cancellationId: 'next-owner' })
      await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2))
      resolvers[0](
        nativeTools
          ? {
              content: '',
              finishReason: 'tool_call',
              toolCalls: [
                {
                  id: 'late-write',
                  name: 'files.write',
                  wireName: 'mp_tool_0',
                  arguments: JSON.stringify({ path: 'owned-late.txt', content: 'must not run' })
                }
              ]
            }
          : {
              content:
                '{"toolName":"files.write","args":{"path":"owned-late.txt","content":"must not run"}}'
            }
      )
      const oldResult = await old
      if (method === 'chat') expect(oldResult).toMatchObject({ name: 'AbortError' })
      else
        expect(oldEvents).toEqual([
          expect.objectContaining({ type: 'done', finishReason: 'cancelled' })
        ])
      expect(callToolMock).not.toHaveBeenCalled()
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[1]?.aborted).toBe(false)
      await expect(
        svc.chat({ ...request, cancellationId: 'duplicate-owner' })
      ).rejects.toMatchObject({ code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE })
      expect(
        await svc.cancelConversation({
          conversationId: request.conversationId,
          cancellationId: 'cancelled-owner'
        })
      ).toEqual({ cancelled: false })
      expect(signals[1]?.aborted).toBe(false)
      resolvers[1]({ content: 'Successor output' })
      await expect(next).resolves.toEqual({ content: 'Successor output' })
      expect(agentChat).toHaveBeenCalledTimes(2)
      expect(callToolMock).not.toHaveBeenCalled()
    }
  )

  it('signals an already running tool, preserves its real completed effect, and never starts the remaining old batch after cancellation', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue([
      { name: 'files.write', description: 'Owned fixture write', inputSchema: { type: 'object' } }
    ])
    let finishTool!: (value: { content: string }) => void
    let finishNext!: (value: { content: string }) => void
    let toolSignal: AbortSignal | undefined
    callToolMock.mockImplementation((_route, _name, _args, options) => {
      toolSignal = options.signal
      return new Promise((resolve) => {
        finishTool = resolve
      })
    })
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_call',
        toolCalls: ['one', 'two'].map((id) => ({
          id,
          name: 'files.write',
          wireName: 'mp_tool_0',
          arguments: JSON.stringify({ path: `owned-${id}.txt`, content: id })
        }))
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNext = resolve
          })
      )
    vi.mocked(cliFromProfile).mockReturnValue({
      supportsNativeTools: true,
      chat: agentChat
    } as never)
    const svc = new LLMProxySvcImpl()
    const request = {
      conversationId: 'cancel-in-flight-tool-owner',
      profileId: 'agent-profile',
      messages: [{ role: 'user' as const, content: 'Owned in-flight cancellation fixture' }],
      skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.write'] }] }
    }
    const old = svc
      .chat({ ...request, cancellationId: 'old-tool-owner' })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(callToolMock).toHaveBeenCalledOnce())
    await svc.cancelConversation({
      conversationId: request.conversationId,
      cancellationId: 'old-tool-owner'
    })
    expect(toolSignal?.aborted).toBe(true)
    const next = svc.chat({ ...request, cancellationId: 'successor-owner' })
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2))
    // A tool that already committed can ignore cancellation; the request owner cannot recall it.
    finishTool({ content: 'OWNED_COMMITTED_EFFECT' })
    expect(await old).toMatchObject({
      name: 'AbortError',
      metadata: {
        toolHistory: [
          expect.objectContaining({
            toolName: 'files.write',
            status: 'completed',
            content: 'OWNED_COMMITTED_EFFECT'
          })
        ]
      }
    })
    expect(callToolMock).toHaveBeenCalledOnce()
    await expect(svc.chat({ ...request, cancellationId: 'duplicate-owner' })).rejects.toMatchObject(
      { code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE }
    )
    expect(
      await svc.cancelConversation({
        conversationId: request.conversationId,
        cancellationId: 'old-tool-owner'
      })
    ).toEqual({ cancelled: false })
    finishNext({ content: 'New owner finishes independently' })
    await expect(next).resolves.toEqual({ content: 'New owner finishes independently' })
    expect(agentChat).toHaveBeenCalledTimes(2)
    expect(callToolMock).toHaveBeenCalledOnce()
  })

  it('does not replace an active owner with a pre-aborted request or a wrong cancellation identity', async () => {
    let resolve!: (value: string) => void
    let signal: AbortSignal | undefined
    const agentChat = vi.fn((options: { signal?: AbortSignal }) => {
      signal = options.signal
      return new Promise<string>((yes) => {
        resolve = yes
      })
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    mockAgentProfile()
    const svc = new LLMProxySvcImpl()
    const request = {
      conversationId: 'pre-aborted-owner',
      cancellationId: 'original-owner',
      profileId: 'agent-profile',
      messages: [{ role: 'user' as const, content: 'Owned fixture' }]
    }
    const original = svc.chat(request)
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledOnce())
    const stopped = new AbortController()
    stopped.abort(new DOMException('Not dispatched', 'AbortError'))
    await expect(svc.chat(request, { signal: stopped.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(
      await svc.cancelConversation({
        conversationId: request.conversationId,
        cancellationId: 'unrelated-request'
      })
    ).toEqual({ cancelled: false })
    expect(signal?.aborted).toBe(false)
    resolve('Original still owns the conversation')
    await expect(original).resolves.toEqual({ content: 'Original still owns the conversation' })
  })

  it.each(['chat', 'chatStream'] as const)(
    'lets a trusted default canvas %s request read a path through the existing tool loop',
    async (method) => {
      const { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } =
        await import('../magicAgentRuntime/trustedRouteBinding')
      const route = {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'owned-project',
        threadId: 'owned-pane'
      } as const
      const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=owned-project'
      registerMagicAgentTrustedRouteBinding(23, route, {
        trustedUrl: url,
        trustedWebContents: { id: 23, isDestroyed: () => false }
      })
      try {
        mockAgentProfile()
        const sender = {
          id: 23,
          isDestroyed: () => false,
          getURL: () => url,
          on: vi.fn(),
          removeListener: vi.fn()
        }
        webContentsFromIdMock.mockReturnValue(sender)
        // The strengthened helper requires parent.webContents to be the exact sender instance.
        browserWindowFromWebContentsMock.mockReturnValue({
          isDestroyed: () => false,
          webContents: sender
        })
        listToolsMock.mockReturnValue([
          {
            name: 'files.read',
            description: 'Read bounded text from the workspace',
            inputSchema: {
              type: 'object',
              required: ['path'],
              properties: { path: { type: 'string' } }
            }
          }
        ])
        callToolMock.mockResolvedValue({ content: 'OWNED_FILE_CONTENT' })
        const agentChat = vi
          .fn()
          .mockResolvedValueOnce('{"toolName":"files.read","args":{"path":"notes/readme.txt"}}')
          .mockResolvedValueOnce('Read the requested file.')
        vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
        const request = {
          profileId: 'agent-profile',
          conversationId: 'owned-conversation',
          route,
          messages: [{ role: 'user' as const, content: 'Read notes/readme.txt' }]
        }
        const invocation = {
          methodName: 'svcLLMProxy.' + method,
          senderId: 23,
          isMainFrame: true,
          frameUrl: url,
          senderUrl: url
        }
        const svc = new LLMProxySvcImpl()
        if (method === 'chat')
          expect(await svc.chat(request, invocation)).toMatchObject({
            content: 'Read the requested file.'
          })
        else {
          const onData = vi.fn()
          await svc.chatStream(request, { onData }, invocation)
          expect(onData).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'done', content: 'Read the requested file.' })
          )
        }
        expect(listToolsMock).toHaveBeenCalledWith(
          expect.arrayContaining(['files.read', 'files.write', 'files.edit'])
        )
        expect(callToolMock).toHaveBeenCalledOnce()
        expect(callToolMock).toHaveBeenCalledWith(
          expect.objectContaining(route),
          'files.read',
          { path: 'notes/readme.txt' },
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            allowedToolNames: expect.arrayContaining(['files.read']),
            readExternalFile: expect.any(Function)
          })
        )
        expect(JSON.stringify(agentChat.mock.calls[1][0].messages)).toContain('OWNED_FILE_CONTENT')
        expect(request.messages).toEqual([{ role: 'user', content: 'Read notes/readme.txt' }])
      } finally {
        clearMagicAgentTrustedRouteBindingsForTest()
      }
    }
  )

  it.each(['bare-with-prose', 'fenced-with-prose'])(
    'executes a leading DOCX read %s without leaking its pre-result refusal',
    async (mode) => {
      mockAgentProfile()
      const ownedPath = String.raw`D:\owned\中文 文档.docx`
      const invocation = { toolName: 'files.read', args: { path: ownedPath, maxBytes: 1048576 } }
      const json = JSON.stringify(invocation)
      const content =
        (mode === 'fenced-with-prose' ? '```json\n' + json + '\n```' : json) +
        ' 抱歉，我目前无法读取该本地路径中的 DOCX 文件。'
      listToolsMock.mockReturnValue([
        {
          name: 'files.read',
          description: 'Read approved local document text',
          inputSchema: { type: 'object' }
        }
      ])
      callToolMock.mockResolvedValue({ content: 'OWNED_DOCX_TEXT: 项目计划包括三个阶段。' })
      const snapshots: Array<unknown> = []
      const agentChat = vi.fn().mockImplementation(async (input) => {
        snapshots.push(structuredClone(input.messages))
        if (snapshots.length === 1) {
          for (let offset = 0; offset < content.length; offset += 3)
            input.onDelta?.({ type: 'text-delta', delta: content.slice(offset, offset + 3) })
          return { content }
        }
        input.onDelta?.({ type: 'text-delta', delta: '文档包含三个阶段。' })
        return { content: '文档包含三个阶段。' }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
      const events: Array<{ type: string; delta?: string; content?: string }> = []
      await new LLMProxySvcImpl().chatStream(
        {
          profileId: 'agent-profile',
          conversationId: 'docx-framing-' + mode,
          messages: [{ role: 'user', content: `读取 "${ownedPath}"，总结内容。` }],
          skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.read'] }] }
        },
        {
          onData: (event) => {
            events.push(event)
          }
        }
      )
      expect(callToolMock).toHaveBeenCalledOnce()
      expect(callToolMock.mock.calls[0][1]).toBe('files.read')
      expect(callToolMock.mock.calls[0][2]).toEqual(invocation.args)
      expect(agentChat).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(snapshots[1])).toContain('OWNED_DOCX_TEXT')
      expect(JSON.stringify(snapshots[1])).not.toContain('无法读取')
      expect(
        events
          .filter((e) => e.type === 'text-delta')
          .map((e) => e.delta)
          .join('')
      ).toBe('文档包含三个阶段。')
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
      expect(events.at(-1)?.content).toBe('文档包含三个阶段。')
    }
  )

  it('checkpoints completed tool results before waiting for the next model response', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue([
      { name: 'files.write', description: 'Write', inputSchema: { type: 'object' } }
    ])
    callToolMock.mockResolvedValue({ content: 'OWNED_COMMITTED_FILE_RESULT' })
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"toolName":"files.write","args":{"path":"owned.txt","content":"owned"}}'
      })
      .mockImplementationOnce(
        async ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
      )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    const events: Array<Record<string, unknown>> = []
    const service = new LLMProxySvcImpl()
    const pending = service.chatStream(
      {
        conversationId: 'owned-checkpoint',
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'write once' }],
        skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.write'] }] }
      },
      {
        onData: (event) => {
          events.push(event as unknown as Record<string, unknown>)
        }
      }
    )
    try {
      await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2))
      const checkpoint = events.find(
        (event) =>
          event.type === 'tool-status' &&
          (event.toolStatus as { status: string })?.status === 'completed'
      )
      expect(checkpoint?.metadata).toMatchObject({
        toolHistory: [
          { toolName: 'files.write', status: 'completed', content: 'OWNED_COMMITTED_FILE_RESULT' }
        ]
      })
      expect(events.some((event) => event.type === 'done')).toBe(false)
    } finally {
      await service.cancelConversation({ conversationId: 'owned-checkpoint' })
      await pending
    }
    expect(callToolMock).toHaveBeenCalledOnce()
  })

  it('repairs malformed Windows-path tool JSON once before dispatch without guessing file authority', async () => {
    mockAgentProfile()
    const valid = JSON.stringify({
      toolName: 'files.read',
      args: { path: 'D:/owned/中文 文档.docx' }
    })
    const malformed = String.raw`{"toolName":"files.read","args":{"path":"D:\owned\中文 文档.docx"}} 抱歉不能读取。`
    listToolsMock.mockReturnValue([
      { name: 'files.read', description: 'Read', inputSchema: { type: 'object' } }
    ])
    callToolMock.mockResolvedValue({ content: 'OWNED_DOCX_REPAIRED' })
    const responses = [malformed, valid, '实际内容总结']
    const agentChat = vi.fn().mockImplementation(async (input) => {
      const content = responses.shift()!
      input.onDelta?.({ type: 'text-delta', delta: content })
      return { content }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    const events: Array<{ type: string; delta?: string }> = []
    await new LLMProxySvcImpl().chatStream(
      {
        profileId: 'agent-profile',
        conversationId: 'docx-malformed-tool',
        messages: [{ role: 'user', content: '读取 D:/owned/中文 文档.docx' }],
        skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.read'] }] }
      },
      {
        onData: (event) => {
          events.push(event)
        }
      }
    )
    expect(callToolMock).toHaveBeenCalledOnce()
    expect(callToolMock.mock.calls[0][2]).toEqual({ path: 'D:/owned/中文 文档.docx' })
    expect(agentChat).toHaveBeenCalledTimes(3)
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join('')
    ).toBe('实际内容总结')
  })

  it('stops after one malformed-tool correction and never publishes or executes the broken frame', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue([
      { name: 'files.read', description: 'Read', inputSchema: { type: 'object' } }
    ])
    const broken = '{"toolName":"files.read","args":'
    const agentChat = vi.fn().mockImplementation(async (input) => {
      input.onDelta?.({ type: 'text-delta', delta: broken })
      return { content: broken }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    const events: Array<{ type: string; delta?: string; error?: string }> = []
    await new LLMProxySvcImpl().chatStream(
      {
        profileId: 'agent-profile',
        conversationId: 'malformed-tool-budget',
        messages: [{ role: 'user', content: 'Read owned document' }],
        skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.read'] }] }
      },
      {
        onData: (event) => {
          events.push(event)
        }
      }
    )
    expect(agentChat).toHaveBeenCalledTimes(2)
    expect(callToolMock).not.toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(0)
    expect(
      events.some((e) => e.type === 'error' && e.error?.includes('invalid or ambiguous tool call'))
    ).toBe(true)
  })

  it('passes the active tool-call signal and stable run/tool ids into runtime execution', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('{"toolName":"session.status","args":{"verbose":true}}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: { type: 'object' }
      }
    ])

    let capturedOptions: Record<string, unknown> | undefined
    let releaseTool: (() => void) | undefined
    callToolMock.mockImplementation(
      (
        _route: unknown,
        _name: string,
        _args: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        capturedOptions = options
        return new Promise((resolve) => {
          releaseTool = () => resolve({ content: 'tool result' })
        })
      }
    )
    mockAgentProfile()
    const controller = new AbortController()
    const svc = new LLMProxySvcImpl()
    const pending = svc.chat(
      {
        conversationId: 'conversation-signal',
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'use the status tool' }],
        skillRuntime: {
          skillId: 'signal-skill',
          bindings: [{ appId: 'magicpot.core', toolNames: ['session.status'] }]
        }
      },
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(callToolMock).toHaveBeenCalledOnce())
    expect(capturedOptions).toEqual(
      expect.objectContaining({
        allowedToolNames: ['session.status'],
        signal: expect.any(AbortSignal),
        runId: expect.stringMatching(/^run-/),
        toolCallId: expect.stringMatching(/^run-.*:tool:/)
      })
    )

    const runId = capturedOptions?.runId
    const toolCallId = capturedOptions?.toolCallId
    expect(runId).toEqual(expect.stringMatching(/^run-/))
    expect(runId).not.toBe('conversation-signal')
    expect(toolCallId).toBe(`${String(runId)}:tool:0`)

    controller.abort()
    expect((capturedOptions?.signal as AbortSignal | undefined)?.aborted).toBe(true)
    releaseTool?.()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not execute a tool when the running status callback cancels first', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('{"toolName":"session.status","args":{"secret":"never-run"}}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: { type: 'object' }
      }
    ])
    mockAgentProfile()

    const conversationId = 'cancel-before-tool'
    const svc = new LLMProxySvcImpl()
    const events: Array<{ type: string; toolStatus?: { status?: string } }> = []
    const onData = vi.fn((event: { type: string; toolStatus?: { status?: string } }) => {
      events.push(event)
      if (event.type === 'tool-status' && event.toolStatus?.status === 'running') {
        void svc.cancelConversation({ conversationId })
      }
    })

    await svc.chatStream(
      {
        conversationId,
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'use the status tool' }],
        skillRuntime: {
          skillId: 'cancel-before-tool-skill',
          bindings: [{ appId: 'magicpot.core', toolNames: ['session.status'] }]
        }
      },
      { onData }
    )

    expect(agentChat).toHaveBeenCalledOnce()
    expect(callToolMock).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        toolStatus: expect.objectContaining({ status: 'running' })
      })
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        toolStatus: expect.objectContaining({ status: 'completed' })
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'cancelled' })
  })

  it('preserves completed tool history when the turn is cancelled after tool success', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('{"toolName":"session.status","args":{"secret":"do-not-leak"}}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: { type: 'object' }
      }
    ])
    callToolMock.mockResolvedValue({ content: 'ready', metadata: { state: 'ok' } })
    mockAgentProfile()

    const conversationId = 'cancel-after-tool-success'
    const svc = new LLMProxySvcImpl()
    const events: Array<{ type: string; toolStatus?: { status?: string } }> = []
    const options = {
      onDelta: (event: { type: string; toolStatus?: { status?: string } }): void => {
        events.push(event)
        if (event.type === 'tool-status' && event.toolStatus?.status === 'completed') {
          void svc.cancelConversation({ conversationId })
        }
      }
    }

    const pending = svc.chat(
      {
        conversationId,
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'use the status tool' }],
        skillRuntime: {
          skillId: 'cancel-after-tool-success-skill',
          bindings: [{ appId: 'magicpot.core', toolNames: ['session.status'] }]
        }
      },
      options as unknown as Parameters<typeof svc.chat>[1]
    )

    let failure: unknown
    try {
      await pending
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      name: 'AbortError',
      metadata: {
        toolHistory: [
          expect.objectContaining({
            toolName: 'session.status',
            status: 'completed',
            content: 'ready',
            metadata: { state: 'ok' }
          })
        ]
      }
    })
    expect(callToolMock).toHaveBeenCalledOnce()
    expect(agentChat).toHaveBeenCalledOnce()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        toolStatus: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('does not rotate sibling profiles or backup ownership while continuing a session', async () => {
    const agentChat = vi.fn().mockResolvedValue('continued response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'profile-a',
            model_name: 'Shared Model',
            base_url: 'https://shared.example/v1',
            api_key: 'key-a',
            backup_api_keys: ['backup-a']
          },
          {
            id: 'profile-b',
            model_name: 'Shared Model',
            base_url: 'https://shared.example/v1',
            api_key: 'key-b'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const request = {
      conversationId: 'continuation-owner',
      profileId: 'profile-a',
      sessionUrl: 'session-owner-a',
      messages: [{ role: 'user' as const, content: 'continue' }]
    }
    await svc.chat(request)
    await svc.chat(request)

    expect(
      vi.mocked(cliFromProfile).mock.calls.map(([profile]) => (profile as LLMAPIProfile).id)
    ).toEqual(['profile-a', 'profile-a'])
    expect(vi.mocked(cliFromProfile).mock.calls.map(([profile]) => profile.api_key)).toEqual([
      'key-a',
      'key-a'
    ])
  })

  it('aggregates usage across a tool loop and keeps the last step usage for context calibration', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"toolName":"session.status","args":{"secret":"do-not-leak"}}',
        usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 }
      })
      .mockResolvedValueOnce({
        content: 'The status is ready.',
        usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 }
      })
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: { type: 'object' }
      }
    ])
    callToolMock.mockResolvedValue({ content: 'ready', metadata: { state: 'ok' } })
    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const response = await svc.chat({
      conversationId: 'usage-tool-loop',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'check status' }],
      skillRuntime: {
        skillId: 'usage-skill',
        bindings: [{ appId: 'magicpot.core', toolNames: ['session.status'] }]
      }
    })

    expect(response.usage).toMatchObject({
      promptTokens: 20,
      completionTokens: 13,
      totalTokens: 33
    })
    expect(response.metadata).toEqual(
      expect.objectContaining({
        runId: expect.stringMatching(/^run-/),
        lastStepUsage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 }
      })
    )

    const followUpMessages = agentChat.mock.calls[1]?.[0]?.messages as Array<{
      content?: string
      metadata?: Record<string, unknown>
    }>
    expect(JSON.stringify(followUpMessages)).toContain('do-not-leak')
    expect(JSON.stringify(followUpMessages)).toContain('[Tool Result]')
  })

  it('forwards sanitized remote tool-status events without args or metadata', async () => {
    const { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } =
      await import('../magicAgentRuntime/trustedRouteBinding')
    const route = {
      channel: 'canvas',
      scopeType: 'thread',
      scopeId: 'remote-project',
      threadId: 'remote-pane'
    } as const
    const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=remote-project'
    registerMagicAgentTrustedRouteBinding(31, route, {
      trustedUrl: url,
      trustedWebContents: { id: 31, isDestroyed: () => false }
    })
    const remoteStream = JSON.stringify({
      type: 'tool-status',
      delta: 'ignored',
      done: true,
      toolStatus: {
        runId: ' backend-run-1 ',
        toolCallId: ' backend-run-1:tool:0 ',
        toolName: 'session.status',
        status: 'running',
        args: { secret: 'do-not-forward' },
        metadata: { credential: 'do-not-forward' }
      }
    })
    mockConfig({
      use_remote_llm: true,
      remote_llm_server_config: {
        server_origin: 'https://remote.example',
        access_token: 'remote-token'
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/x-ndjson' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${remoteStream}\n`))
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ type: 'done', delta: '', done: true, finishReason: 'stop' })}\n`
            )
          )
          controller.close()
        }
      })
    })

    const onData = vi.fn()
    try {
      await new LLMProxySvcImpl().chatStream(
        {
          profileId: 'remote-profile',
          conversationId: 'remote-conversation',
          route,
          messages: [{ role: 'user', content: String.raw`Read "D:\Project Notes\report.txt"` }]
        },
        { onData },
        {
          methodName: 'svcLLMProxy.chatStream',
          senderId: 31,
          isMainFrame: true,
          frameUrl: url,
          senderUrl: url
        }
      )
    } finally {
      clearMagicAgentTrustedRouteBindingsForTest()
    }

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      skillRuntime?: unknown
      systemPrompt?: string
    }
    expect(requestBody.skillRuntime).toBeUndefined()
    expect(requestBody.systemPrompt || '').not.toContain('Use the available read-only file tools')
    // Remote transport must never construct or carry the local read callback.
    expect(webContentsFromIdMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()

    expect(onData).toHaveBeenCalledWith({
      type: 'tool-status',
      delta: '',
      done: false,
      fullContent: undefined,
      toolStatus: {
        runId: 'backend-run-1',
        toolCallId: 'backend-run-1:tool:0',
        toolName: 'session.status',
        status: 'running'
      }
    })
    const forwardedToolStatus = onData.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'tool-status')
    expect(forwardedToolStatus.toolStatus).not.toHaveProperty('args')
    expect(forwardedToolStatus.toolStatus).not.toHaveProperty('metadata')
    expect(onData).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'done', done: true, finishReason: 'stop' })
    )
  })

  it('aborts an upstream streaming request without a conversationId when the renderer closes the stream', async () => {
    let upstreamSignal: AbortSignal | undefined
    const agentChat = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          upstreamSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          )
        })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const [abortSender, abortReceiver] = newAbortHandler()
    const onData = vi.fn()
    const svc = new LLMProxySvcImpl()
    const streaming = svc.chatStream(
      {
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'stream' }]
      },
      { onData, abortReceiver }
    )
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1))

    abortSender.abort()
    await streaming

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toMatchObject({
      name: 'AbortError',
      message: 'Streaming request aborted by the renderer.'
    })
    expect(onData).not.toHaveBeenCalled()
  })

  it('aborts an upstream streaming request when the renderer closes the stream', async () => {
    let upstreamSignal: AbortSignal | undefined
    const agentChat = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          upstreamSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true }
          )
        })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const [abortSender, abortReceiver] = newAbortHandler()
    const onData = vi.fn()
    const svc = new LLMProxySvcImpl()
    const streaming = svc.chatStream(
      {
        conversationId: 'conversation-stream',
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'stream' }]
      },
      { onData, abortReceiver }
    )
    await vi.waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1))

    abortSender.abort()
    await streaming

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toMatchObject({
      name: 'AbortError',
      message: 'Streaming request aborted by the renderer.'
    })
    expect(onData).not.toHaveBeenCalled()
    await expect(
      svc.cancelConversation({ conversationId: 'conversation-stream' })
    ).resolves.toEqual({
      cancelled: false
    })
  })

  it('cancels an in-flight conversation by conversationId', async () => {
    const agentChat = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = signal.reason instanceof Error ? signal.reason : new Error('aborted')
              if (!('name' in error) || !error.name) {
                ;(error as Error).name = 'AbortError'
              }
              reject(error)
            },
            { once: true }
          )
          if (signal?.aborted) {
            const error = signal.reason instanceof Error ? signal.reason : new Error('aborted')
            ;(error as Error).name = 'AbortError'
            reject(error)
            return
          }
        })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const pending = svc.chat({
      conversationId: 'conversation-1',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    await expect(svc.cancelConversation({ conversationId: 'conversation-1' })).resolves.toEqual({
      cancelled: true
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('exposes bound MCP tools to normal chat and executes them through the local runtime', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('{"toolName":"mcp.github.issues.list","args":{"repo":"magicpot"}}')
      .mockResolvedValueOnce('Found 3 issues in magicpot.')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      mcp_config: {
        ...DEFAULT_CONFIG.mcp_config,
        client: {
          ...DEFAULT_CONFIG.mcp_config.client,
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'github-mcp'
            }
          ]
        }
      }
    })

    listToolsMock.mockImplementation((allowedToolNames?: string[] | null) => {
      const tools = [
        {
          name: 'mcp.github.issues.list',
          description: 'List issues',
          inputSchema: {
            type: 'object',
            properties: {
              repo: { type: 'string' }
            }
          }
        },
        {
          name: 'mcp.github.pulls.list',
          description: 'List pulls',
          inputSchema: {
            type: 'object'
          }
        }
      ]
      return Array.isArray(allowedToolNames)
        ? tools.filter((tool) => allowedToolNames.includes(tool.name))
        : tools
    })
    callToolMock.mockResolvedValue({
      content: 'Issue #1\nIssue #2\nIssue #3',
      metadata: { ok: true }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-conv',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'List recent GitHub issues for magicpot.' }],
      skillRuntime: {
        skillId: 'github-agent',
        bindings: [
          {
            appId: 'mcp.github',
            toolNames: [' mcp.github.issues.list ', 'mcp.github.issues.list']
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith(['mcp.github.issues.list'])
    expect(agentChat).toHaveBeenCalledTimes(2)
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toContain('Tool: mcp.github.issues.list')
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).not.toContain('mcp.github.pulls.list')
    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'tagging-conv'
      },
      'mcp.github.issues.list',
      { repo: 'magicpot' },
      {
        allowedToolNames: ['mcp.github.issues.list'],
        signal: expect.any(AbortSignal),
        runId: expect.stringMatching(/^run-/),
        toolCallId: expect.stringMatching(/^run-.*:tool:0$/)
      }
    )
    expect(agentChat.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: 'List recent GitHub issues for magicpot.' },
      {
        role: 'assistant',
        content: '{"toolName":"mcp.github.issues.list","args":{"repo":"magicpot"}}'
      },
      {
        role: 'assistant',
        content:
          '[Tool Result]\ntoolName: mcp.github.issues.list\nargs:\n{\n  "repo": "magicpot"\n}\n\nIssue #1\nIssue #2\nIssue #3'
      }
    ])
    expect(resp.content).toBe('Found 3 issues in magicpot.')
  })

  it('gives a MagicAgent default binding read-only web tools without requiring a search prompt', async () => {
    const agentChat = vi.fn().mockResolvedValue('Current answer with sources.')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    const webTools = [
      { name: 'web_search', description: 'Search public web', inputSchema: { type: 'object' } },
      { name: 'web_fetch', description: 'Fetch public page', inputSchema: { type: 'object' } }
    ]
    listToolsMock.mockImplementation((allowedToolNames?: string[] | null) =>
      Array.isArray(allowedToolNames)
        ? webTools.filter((tool) => allowedToolNames.includes(tool.name))
        : webTools
    )
    mockAgentProfile()

    const response = await new LLMProxySvcImpl().chat({
      conversationId: 'magic-agent-default-web',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'What changed on the public project?' }],
      skillRuntime: {
        skillId: 'magicpot.default.chat',
        bindings: [
          {
            appId: 'magicpot.default.chat',
            source: 'magicAgentRuntime'
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith(['web_search', 'web_fetch'])
    expect(agentChat).toHaveBeenCalledOnce()
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toContain('Tool: web_search')
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toContain('Tool: web_fetch')
    expect(response.content).toBe('Current answer with sources.')
  })

  it('does not leak unbound MCP tools into normal chat tool visibility', async () => {
    const agentChat = vi.fn().mockResolvedValue('No external tools are available for this skill.')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'mcp.github.issues.list',
        description: 'List issues',
        inputSchema: {}
      }
    ])

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-unbound',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Can you use GitHub MCP here?' }],
      skillRuntime: {
        skillId: 'no-tools-skill',
        bindings: [
          {
            appId: 'mcp.github',
            resourceUris: ['magicpot://chat/tools']
          }
        ]
      }
    })

    expect(listToolsMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(agentChat.mock.calls[0]?.[0]?.messages).toEqual([
      { role: 'user', content: 'Can you use GitHub MCP here?' }
    ])
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toBeUndefined()
    expect(resp.content).toBe('No external tools are available for this skill.')
  })

  it('does not mistake ordinary structured JSON output for a tool invocation', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":"ready"}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'structured-output',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Return a JSON summary.' }],
      skillRuntime: {
        skillId: 'structured-skill',
        execution: {
          outputMode: 'structured'
        },
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' }
          }
        }
      }
    })

    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(resp).toEqual({
      content: '{\n  "summary": "ready"\n}'
    })
  })

  it('ignores tool-shaped JSON when the requested tool is not bound to the current skill', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"toolName":"mcp.github.pulls.list","args":{}}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    listToolsMock.mockReturnValue([
      {
        name: 'mcp.github.issues.list',
        description: 'List issues',
        inputSchema: {}
      }
    ])

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tool-shaped-json',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Return JSON only.' }],
      skillRuntime: {
        skillId: 'github-agent',
        bindings: [
          {
            appId: 'mcp.github',
            toolNames: ['mcp.github.issues.list']
          }
        ]
      }
    })

    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(resp).toEqual({
      content: '{"toolName":"mcp.github.pulls.list","args":{}}'
    })
  })

  it('short-circuits /tools through the local runtime when skillRuntime binds tools', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: {}
      }
    ])

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-conv',
      messages: [{ role: 'user', content: '/tools' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: [' session.status ', 'session.status']
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith(['session.status'])
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp.content).toContain('Available chat tools:')
    expect(resp.content).toContain('- session.status: Status')
  })

  it('keeps explicit empty tool bindings when short-circuiting /tools', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([])

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-empty',
      messages: [{ role: 'user', content: '/tools' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: []
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith([])
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp.content).toBe('No chat tools are available.')
  })

  it('short-circuits /tool through the local runtime with allowedToolNames', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    callToolMock.mockResolvedValue({
      content: 'tool output',
      metadata: { ok: true }
    })

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-tool',
      messages: [{ role: 'user', content: '/tool session.status {"verbose":true}' }],
      skillRuntime: {
        skillId: 'built-in.tagging',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status']
          }
        ]
      }
    })

    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'tagging-tool'
      },
      'session.status',
      { verbose: true },
      {
        allowedToolNames: ['session.status']
      }
    )
    expect(listToolsMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp).toEqual({
      content: 'tool output'
    })
  })

  it('falls back to sessionUrl when building the shared skill runtime route', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    callToolMock.mockResolvedValue({
      content: 'tool output',
      metadata: { ok: true }
    })

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      sessionUrl: ' https://example.com/sessions/skill-42 ',
      messages: [{ role: 'user', content: '/tool session.status {"verbose":false}' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status']
          }
        ]
      }
    })

    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'https://example.com/sessions/skill-42'
      },
      'session.status',
      { verbose: false },
      {
        allowedToolNames: ['session.status']
      }
    )
  })

  it('runs chat in isolated mode with only the latest message', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      systemPrompt: 'system prompt',
      messages: [
        { role: 'system', content: 'old turn' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          mode: 'isolated'
        }
      }
    })

    expect(agentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        imageGenerationOptions: undefined,
        imageHistoryPolicy: undefined,
        imageRequest: undefined,
        maxOutputTokens: undefined,
        messages: [{ role: 'user', content: 'latest question' }],
        onDelta: expect.any(Function),
        reasoningEffort: undefined,
        retryCapacity: true,
        sessionUrl: undefined,
        signal: undefined,
        systemPrompt: 'system prompt',
        temperature: undefined,
        videoGenerationOptions: undefined
      })
    )
    expect(agentChat.mock.calls[0]?.[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(resp.content).toBe('agent response')
  })

  it('honors no-history policy by dropping prior messages', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'history reply' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          allowHistory: false
        }
      }
    })

    expect(agentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        imageGenerationOptions: undefined,
        imageHistoryPolicy: undefined,
        imageRequest: undefined,
        maxOutputTokens: undefined,
        messages: [{ role: 'user', content: 'latest question' }],
        onDelta: expect.any(Function),
        reasoningEffort: undefined,
        retryCapacity: true,
        sessionUrl: undefined,
        signal: undefined,
        systemPrompt: undefined,
        temperature: undefined,
        videoGenerationOptions: undefined
      })
    )
    expect(agentChat.mock.calls[0]?.[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(resp.content).toBe('agent response')
  })

  it('limits skill runtime context and disables session continuation for finite context', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'agent-profile',
      sessionUrl: 'session-should-not-continue',
      messages: [
        { role: 'user', content: 'm1' },
        { role: 'assistant', content: 'm2' },
        { role: 'user', content: 'm3' },
        { role: 'assistant', content: 'm4' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          mode: 'inherit',
          allowHistory: true,
          contextMessageLimit: 3,
          persistSessionUrl: false
        }
      }
    })

    const chatRequest = agentChat.mock.calls[0]?.[0]
    expect(chatRequest.messages).toEqual([
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
      { role: 'user', content: 'latest question' }
    ])
    expect(chatRequest.sessionUrl).toBeUndefined()
  })

  it('validates structured skill output against the declared schema', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":"ok"}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'return structured json' }],
      skillRuntime: {
        execution: {
          outputMode: 'structured'
        },
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' }
          }
        }
      }
    })

    expect(resp).toEqual({
      content: '{\n  "summary": "ok"\n}'
    })
  })

  it('rejects structured skill output that does not satisfy the declared schema', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":1}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockAgentProfile()

    const svc = new LLMProxySvcImpl()

    await expect(
      svc.chat({
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'return structured json' }],
        skillRuntime: {
          execution: {
            outputMode: 'structured'
          },
          outputSchema: {
            type: 'object',
            required: ['summary'],
            properties: {
              summary: { type: 'string' }
            }
          }
        }
      })
    ).rejects.toThrow('Structured output validation failed')
  })

  it('routes builtin tagging skill requests through Tagger Provider V2', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        '{"tags":["red dragon"],"tagsText":"red dragon","caption":"A red dragon icon."}'
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const correlationId = 'a'.repeat(32)
    const resp = await svc.chat({
      profileId: 'tagger-profile',
      correlationId,
      messages: [{ role: 'user', content: 'tag this asset' }],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://127.0.0.1:7860/api/tagger/v2/infer')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-key',
        'Content-Type': 'application/json',
        'X-MagicPot-Correlation-Id': correlationId
      }
    })
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      provider: {
        id: 'wdtagger',
        name: 'WDTagger',
        family: 'tagger',
        endpoint: 'http://127.0.0.1:7860/api',
        cacheKey: expect.any(String)
      },
      profile: {
        id: 'tagger-profile',
        modelName: 'WD14 Local',
        taggerProvider: 'wdtagger',
        taggerEndpoint: 'http://127.0.0.1:7860/api'
      },
      request: {
        skillId: 'builtin-tagging',
        outputMode: 'structured'
      }
    })
    expect(resp.content).toContain('"tags"')
    expect(resp.content).toContain('"caption"')
  })

  it('applies the caller structured-output contract to Tagger Provider V2 responses', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"tags":["red dragon"],"caption":"A red dragon icon."}'
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'tagger-profile',
      messages: [{ role: 'user', content: 'tag this asset' }],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: { outputMode: 'text' }
      },
      structuredOutput: {
        name: 'tagger_result',
        schema: {
          type: 'object',
          required: ['caption'],
          properties: { caption: { type: 'string' } }
        }
      }
    })

    expect(JSON.parse(resp.content)).toEqual({
      tags: ['red dragon'],
      caption: 'A red dragon icon.'
    })
  })

  it('rejects Tagger Provider V2 responses that violate the caller structured-output contract', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"tags":["red dragon"]}'
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'tagger-profile',
        messages: [{ role: 'user', content: 'tag this asset' }],
        skillRuntime: {
          skillId: 'builtin-tagging',
          execution: { outputMode: 'text' }
        },
        structuredOutput: {
          name: 'tagger_result',
          schema: {
            type: 'object',
            required: ['caption'],
            properties: { caption: { type: 'string' } }
          }
        }
      })
    ).rejects.toThrow('Provider output does not match the requested schema.')
  })

  it('preserves structured OCR payloads returned by Tagger Provider V2', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          content:
            '{"results":[{"fileName":"doc.png","tags":["wdtagger"],"tagsText":"wdtagger","caption":"doc caption","ocrResult":{"kind":"document","text":"invoice #1"}}]}',
          ocrResult: {
            kind: 'document',
            text: 'invoice #1'
          }
        })
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'tagger-profile',
      messages: [
        {
          role: 'user',
          content: 'read and tag this asset',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'doc.png',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    expect(resp.content).toContain('"results"')
    expect(resp.ocrResult).toEqual({
      kind: 'document',
      text: 'invoice #1'
    })
  })

  it('routes OCR-capable qinglong providers through the same Tagger Provider V2 endpoint', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          content:
            '{"results":[{"fileName":"invoice.png","tags":[],"tagsText":"","caption":"Invoice #42","ocrResult":{"kind":"document","text":"Invoice #42","sourceImageUrl":"data:image/png;base64,UE5H"}}]}',
          ocrResult: {
            kind: 'document',
            text: 'Invoice #42',
            sourceImageUrl: 'data:image/png;base64,UE5H'
          },
          attachments: [
            {
              type: 'file',
              url: 'file:///C:/magicpot/invoice.md',
              fileName: 'invoice.md',
              mimeType: 'text/markdown'
            }
          ]
        })
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ocr-provider-profile',
            model_name: 'PaddleOCR VL',
            base_url: 'http://127.0.0.1:7860',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            model_use: 'ocr',
            tagger_provider: 'paddle_ocr',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'ocr-provider-profile',
      messages: [
        {
          role: 'user',
          content: 'read this invoice',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'invoice.png',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://127.0.0.1:7860/api/tagger/v2/infer')
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      provider: {
        id: 'paddle_ocr',
        name: 'Paddle OCR',
        family: 'ocr'
      },
      profile: {
        id: 'ocr-provider-profile',
        modelName: 'PaddleOCR VL',
        taggerProvider: 'paddle_ocr'
      }
    })
    expect(resp.content).toContain('"ocrResult"')
    expect(resp.ocrResult).toEqual({
      kind: 'document',
      text: 'Invoice #42',
      sourceImageUrl: 'data:image/png;base64,UE5H'
    })
    expect(resp.attachments).toEqual([
      {
        type: 'file',
        url: 'file:///C:/magicpot/invoice.md',
        fileName: 'invoice.md',
        mimeType: 'text/markdown'
      }
    ])
  })

  it('includes tagger provider metadata in runtime profile listing', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'cella110n/cl_tagger',
            base_url: 'http://127.0.0.1:7861',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'cl_tagger',
            tagger_runtime_cache_scope: 'endpoint'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      expect.objectContaining({
        id: 'tagger-profile',
        model_name: 'cella110n/cl_tagger',
        deployment: 'local',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false,
        tagger_provider: 'cl_tagger',
        tagger_runtime_cache_scope: 'endpoint',
        tagger_runtime_key: expect.stringContaining('http://127.0.0.1:7861')
      })
    ])
  })

  it('reports only Agent API profiles in runtime profile listing and status', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})

    expect(profiles.profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        api_mode: 'chat-completions',
        provider: 'openai',
        call_type: 'api',
        deployment: 'cloud',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false,
        attachment_transports: [],
        supports_session_continuation: false,
        openai_api_modes: {
          auto: 'chat-completions',
          default: 'chat-completions',
          'chat-completions': 'chat-completions',
          responses: 'responses',
          images: 'images'
        }
      }
    ])
    expect(status.availableProfiles).toBe(1)
  })

  it('keeps keyless Ollama profiles available to Agent runtime', async () => {
    const agentChat = vi.fn().mockResolvedValue('ollama response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llama3.2',
            base_url: 'http://localhost:11434',
            api_key: '',
            is_ollama: true
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})
    const resp = await svc.chat({
      profileId: 'ollama-profile',
      messages: [{ role: 'user', content: 'hello ollama' }]
    })

    expect(profiles.profiles).toEqual([
      {
        id: 'ollama-profile',
        model_name: 'llama3.2',
        provider: 'ollama',
        call_type: 'api',
        deployment: 'local',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false,
        attachment_transports: [],
        supports_session_continuation: false
      }
    ])
    expect(status.availableProfiles).toBe(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ollama-profile',
        model_name: 'llama3.2',
        base_url: 'http://localhost:11434',
        api_key: '',
        is_ollama: true
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(resp.content).toBe('ollama response')
  })

  it('exposes multimodal profiles as vision-capable in the runtime profile list', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'multimodal-profile',
            model_name: 'GPT-4o',
            base_url: 'https://example.com/v1',
            api_key: 'agent-key',
            model_use: 'multimodal'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      {
        id: 'multimodal-profile',
        model_name: 'GPT-4o',
        api_mode: 'chat-completions',
        provider: 'openai',
        call_type: 'api',
        deployment: 'cloud',
        model_use: 'multimodal',
        is_vision_model: true,
        is_ocr_model: false,
        attachment_transports: [],
        supports_session_continuation: false,
        openai_api_modes: {
          auto: 'chat-completions',
          default: 'chat-completions',
          'chat-completions': 'chat-completions',
          responses: 'responses',
          images: 'images'
        }
      }
    ])
  })

  it('exposes general-agent profiles as vision-capable in the runtime profile list', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'gpt-5.4',
            base_url: 'https://api.openai.com/v1',
            api_key: 'agent-key',
            model_use: 'agent'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'gpt-5.4',
        api_mode: 'responses',
        provider: 'openai',
        call_type: 'api',
        deployment: 'cloud',
        model_use: 'agent',
        is_vision_model: true,
        is_ocr_model: false,
        attachment_transports: [],
        supports_session_continuation: false,
        openai_api_modes: {
          auto: 'responses',
          default: 'responses',
          'chat-completions': 'chat-completions',
          responses: 'responses',
          images: 'images'
        }
      }
    ])
  })

  it('accepts a marked qapp materialized image without persisted attachment capability', async () => {
    const providerChat = vi.fn().mockResolvedValue('image accepted')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })
    const messages = [
      {
        role: 'user' as const,
        content: 'describe this image',
        attachments: [
          {
            type: 'image' as const,
            url: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
            metadata: { internalTransport: 'qapp-renderer-materialized-v1' }
          }
        ]
      }
    ]

    await expect(
      new LLMProxySvcImpl().chat({
        profileScope: 'qapp',
        profileId: 'quick-ollama',
        messages
      })
    ).resolves.toMatchObject({ content: 'image accepted' })
    expect(providerChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [
              expect.objectContaining({
                url: 'data:image/png;base64,iVBORw0KGgo=',
                metadata: undefined
              })
            ]
          })
        ]
      })
    )
  })

  it.each([
    ['gemini', 'Gemini Video'],
    ['claude', 'Claude Video'],
    ['ollama', 'Ollama Video']
  ] as const)(
    'preserves qapp %s video URL image attachments for provider chat',
    async (provider, modelName) => {
      const providerChat = vi.fn().mockResolvedValue('video queued')
      vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
      mockConfig({
        plugin_config: {
          ...DEFAULT_CONFIG.plugin_config!,
          api_profiles: [
            {
              id: `quick-${provider}-video`,
              model_name: modelName,
              base_url: 'https://video.example',
              api_key: provider === 'ollama' ? '' : 'key',
              provider,
              model_use: 'video'
            }
          ]
        }
      })
      const attachment = {
        type: 'image' as const,
        url: 'https://cdn.example/input.png?signature=keep'
      }

      await expect(
        new LLMProxySvcImpl().chat({
          profileScope: 'qapp',
          profileId: `quick-${provider}-video`,
          messages: [{ role: 'user', content: 'animate', attachments: [attachment] }]
        })
      ).resolves.toMatchObject({ content: 'video queued' })
      expect(providerChat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [expect.objectContaining({ attachments: [attachment] })]
        })
      )
    }
  )

  it('enforces a finite per-image request limit without allocating an oversized buffer', () => {
    const limits = {
      maxImages: 4,
      maxBytesPerImage: 4,
      maxTotalBytes: 8,
      maxRequestBodyBytes: 16
    }

    expect(() => validateImageRequestImageDescriptors([{ sizeBytes: 5 }], limits)).toThrow(
      'Image exceeds the 4-byte decoded limit.'
    )
    expect(validateImageRequestImageDescriptors([{ sizeBytes: 4 }], limits)).toEqual({
      imageCount: 1,
      totalBytes: 4
    })
  })

  it('rejects a marked qapp malformed image before built-in provider chat', async () => {
    const providerChat = vi.fn().mockResolvedValue('should not run')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileScope: 'qapp',
        profileId: 'quick-ollama',
        messages: [
          {
            role: 'user',
            content: 'describe this image',
            attachments: [
              {
                type: 'image',
                url: 'data:image/png;base64,UE5H==',
                mimeType: 'image/png',
                metadata: { internalTransport: 'qapp-renderer-materialized-v1' }
              }
            ]
          }
        ]
      })
    ).rejects.toThrow(/malformed image base64/)
    expect(providerChat).not.toHaveBeenCalled()
  })

  it('rejects a marked qapp image whose declared MIME does not match its bytes', async () => {
    const providerChat = vi.fn().mockResolvedValue('should not run')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileScope: 'qapp',
        profileId: 'quick-ollama',
        messages: [
          {
            role: 'user',
            content: 'describe this image',
            attachments: [
              {
                type: 'image',
                url: 'data:image/jpeg;base64,iVBORw0KGgo=',
                mimeType: 'image/jpeg',
                metadata: { internalTransport: 'qapp-renderer-materialized-v1' }
              }
            ]
          }
        ]
      })
    ).rejects.toThrow(/MIME mismatch/)
    expect(providerChat).not.toHaveBeenCalled()
  })

  it('rejects inline images for an undeclared Ollama attachment transport before provider chat', async () => {
    const providerChat = vi.fn().mockResolvedValue('should not run')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileId: 'ollama-profile',
        messages: [
          {
            role: 'user',
            content: 'describe this image',
            attachments: [
              {
                type: 'image',
                url: 'data:image/png;base64,UE5H',
                mimeType: 'image/png'
              }
            ]
          }
        ]
      })
    ).rejects.toThrow('must declare "request-data-url"')

    expect(providerChat).not.toHaveBeenCalled()
  })

  it('accepts an already materialized data image when Ollama declares request-data-url', async () => {
    const providerChat = vi.fn().mockResolvedValue('image accepted')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama',
            ...({ attachment_transports: ['request-data-url'] } as Partial<LLMAPIProfile> & {
              attachment_transports: string[]
            })
          }
        ]
      }
    })

    const messages = [
      {
        role: 'user' as const,
        content: 'describe this image',
        attachments: [
          {
            type: 'image' as const,
            url: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png'
          }
        ]
      }
    ]
    const response = await new LLMProxySvcImpl().chat({
      profileId: 'ollama-profile',
      messages
    })

    expect(providerChat).toHaveBeenCalledWith(expect.objectContaining({ messages }))
    expect(response.content).toBe('image accepted')
  })

  it.each([
    ['empty payload', 'data:image/png;base64,'],
    ['missing base64 marker', 'data:image/png,UE5H'],
    ['invalid base64 characters', 'data:image/png;base64,not-base64'],
    ['non-canonical base64', 'data:image/png;base64,UE5H=='],
    ['unsupported image MIME', 'data:image/svg+xml;base64,PHN2Zz4=']
  ])('rejects %s before built-in provider chat', async (_label, url) => {
    const providerChat = vi.fn().mockResolvedValue('should not run')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llava',
            base_url: 'http://localhost:11434',
            api_key: '',
            provider: 'ollama',
            ...({ attachment_transports: ['request-data-url'] } as Partial<LLMAPIProfile> & {
              attachment_transports: string[]
            })
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileId: 'ollama-profile',
        messages: [
          {
            role: 'user',
            content: 'describe this image',
            attachments: [{ type: 'image', url, mimeType: 'image/png' }]
          }
        ]
      })
    ).rejects.toThrow(/canonical base64|malformed image base64|non-canonical image base64/)
    expect(providerChat).not.toHaveBeenCalled()
  })

  it('passes every public HTTPS video image URL to the provider unchanged', async () => {
    const providerChat = vi.fn().mockResolvedValue('queued')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            model_use: 'video'
          }
        ]
      }
    })
    const messages = [
      {
        role: 'user' as const,
        content: 'animate',
        attachments: [
          { type: 'image' as const, url: 'https://cdn.example/one.png?signature=keep' },
          { type: 'image' as const, url: 'https://media.example/two.jpg' }
        ]
      }
    ]

    await new LLMProxySvcImpl().chat({
      profileScope: 'qapp',
      profileId: 'quick-video',
      messages
    })

    expect(providerChat).toHaveBeenCalledWith(expect.objectContaining({ messages }))
  })

  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:https://app.example/image',
    'file:///tmp/image.png',
    'local-media://asset/image.png',
    'https://user:secret@cdn.example/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
    'https://10.0.0.8/image.png',
    'http://cdn.example/image.png'
  ])('rejects unsafe video image URL %s before provider chat', async (url) => {
    const providerChat = vi.fn().mockResolvedValue('should not run')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: providerChat } as never)
    mockConfig({
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'seedance',
            base_url: 'https://ark.cn-beijing.volces.com',
            api_key: 'key',
            provider: 'volcengine',
            model_use: 'video'
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileScope: 'qapp',
        profileId: 'quick-video',
        messages: [
          {
            role: 'user',
            content: 'animate',
            attachments: [{ type: 'image', url }]
          }
        ]
      })
    ).rejects.toThrow(/public HTTPS image URLs/)
    expect(providerChat).not.toHaveBeenCalled()
  })

  it('enforces a finite aggregate request limit without allocating oversized buffers', () => {
    const limits = {
      maxImages: 4,
      maxBytesPerImage: 6,
      maxTotalBytes: 8,
      maxRequestBodyBytes: 16
    }

    expect(() =>
      validateImageRequestImageDescriptors([{ sizeBytes: 5 }, { sizeBytes: 4 }], limits)
    ).toThrow('Images exceed the 8-byte aggregate decoded limit.')
    expect(validateImageRequestImageDescriptors([{ sizeBytes: 5 }], limits)).toEqual({
      imageCount: 1,
      totalBytes: 5
    })
  })

  it('accepts explicit Ollama providers on generic Agent gateways without API keys', async () => {
    const agentChat = vi.fn().mockResolvedValue('ollama response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llama3.2',
            base_url: 'https://gateway.example/llm',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})
    const resp = await svc.chat({
      profileId: 'ollama-profile',
      messages: [{ role: 'user', content: 'hello ollama' }]
    })

    expect(profiles.profiles).toEqual([
      {
        id: 'ollama-profile',
        model_name: 'llama3.2',
        provider: 'ollama',
        call_type: 'api',
        deployment: 'cloud',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false,
        attachment_transports: [],
        supports_session_continuation: false
      }
    ])
    expect(status.availableProfiles).toBe(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ollama-profile',
        model_name: 'llama3.2',
        base_url: 'https://gateway.example/llm',
        api_key: '',
        provider: 'ollama'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(resp.content).toBe('ollama response')
  })

  it('parses structured OCR responses returned as JSON strings', async () => {
    const agentChat = vi.fn().mockResolvedValue(
      JSON.stringify({
        content: 'OCR completed',
        attachments: [
          {
            type: 'file',
            url: 'file:///C:/magicpot/result.xlsx',
            fileName: 'result.xlsx'
          }
        ],
        ocrResult: {
          kind: 'table',
          text: 'A1'
        }
      })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ocr-profile',
            model_name: 'OCR Model',
            base_url: 'http://127.0.0.1:8000/v1',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            model_use: 'ocr'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'ocr-profile',
      messages: [{ role: 'user', content: 'read this image' }]
    })

    expect(resp).toEqual({
      content: 'OCR completed',
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/magicpot/result.xlsx',
          fileName: 'result.xlsx'
        }
      ],
      ocrResult: {
        kind: 'table',
        text: 'A1'
      }
    })
  })

  it('routes BigModel OCR profiles through layout_parsing and returns OCR output', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: '# OCR Result\nhello world',
        layout_visualization: ['https://cdn.example.com/layout.png'],
        layout_details: [[{ label: 'text', bbox_2d: [0.1, 0.2, 0.5, 0.4] }]],
        data_info: {
          pages: [{ width: 1000, height: 500 }]
        }
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const correlationId = 'b'.repeat(32)
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      correlationId,
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'page.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('https://open.bigmodel.cn/api/paas/v4/layout_parsing')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer glm-key',
        'Content-Type': 'application/json',
        'X-MagicPot-Correlation-Id': correlationId
      }
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'UE5H'
    })
    expect(resp).toEqual({
      content: '# OCR Result\nhello world',
      attachments: [
        {
          type: 'image',
          url: 'https://cdn.example.com/layout.png',
          fileName: 'glm-ocr-layout-1.png',
          mimeType: 'image/png'
        }
      ],
      ocrResult: {
        kind: 'document',
        text: '# OCR Result\nhello world',
        sourceImageUrl: 'data:image/png;base64,UE5H',
        boxes: [
          {
            x: 100,
            y: 100,
            width: 400,
            height: 100,
            page: 1,
            label: 'text'
          }
        ]
      }
    })
  })

  it('applies the caller structured-output contract to BigModel OCR responses', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: '{"text":"hello world"}'
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const resp = await new LLMProxySvcImpl().chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'page.png',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      structuredOutput: {
        name: 'ocr_result',
        schema: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } }
        }
      }
    })

    expect(resp.content).toBe('{"text":"hello world"}')
  })

  it('rejects BigModel OCR responses that violate the caller structured-output contract', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: '# OCR Result\nhello world'
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    await expect(
      new LLMProxySvcImpl().chat({
        profileId: 'glm-ocr-profile',
        messages: [
          {
            role: 'user',
            content: 'read this image',
            attachments: [
              {
                type: 'image',
                url: 'data:image/png;base64,UE5H',
                fileName: 'page.png',
                mimeType: 'image/png'
              }
            ]
          }
        ],
        structuredOutput: {
          name: 'ocr_result',
          schema: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string' } }
          }
        }
      })
    ).rejects.toThrow('Provider returned invalid structured output JSON.')
  })

  it('prefers source attachments over the canvas snapshot for BigModel OCR', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: 'source result'
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,U09VUkNF',
              fileName: 'asset.png',
              mimeType: 'image/png'
            },
            {
              type: 'image',
              url: 'data:image/png;base64,U05BUFNIT1Q=',
              fileName: 'canvas-target-selection.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, requestInit] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'U09VUkNF'
    })
    expect(resp.content).toBe('source result')
    expect(resp.ocrResult?.sourceImageUrl).toBe('data:image/png;base64,U09VUkNF')
  })

  it('falls back to the canvas snapshot only when all source attachments fail for BigModel OCR', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":{"code":"1214","message":"OCR仅支持PDF、JPG、PNG、JPEG格式"}}'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'GLM-OCR',
          md_results: 'snapshot result'
        }),
        text: async () => ''
      })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,U09VUkNF',
              fileName: 'asset.png',
              mimeType: 'image/png'
            },
            {
              type: 'image',
              url: 'data:image/png;base64,U05BUFNIT1Q=',
              fileName: 'canvas-target-selection.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchMock.mock.calls[1]
    expect(JSON.parse(String(secondInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'U05BUFNIT1Q='
    })
    expect(resp.content).toBe('snapshot result')
    expect(resp.ocrResult?.sourceImageUrl).toBe('data:image/png;base64,U05BUFNIT1Q=')
  })

  it.each([
    ['file URL', 'file:///C:/magicpot/invoice.png'],
    ['local-media URL', 'local-media:///C:/magicpot/invoice.png'],
    ['absolute local path', 'C:/magicpot/invoice.png']
  ])('rejects %s attachments on BigModel OCR without reading local disk', async (_label, url) => {
    vi.stubGlobal('fetch', fetchMock)
    const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('should-not-read'))

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'glm-ocr-profile',
        messages: [
          {
            role: 'user',
            content: 'read this image',
            attachments: [
              {
                type: 'image',
                url,
                fileName: 'invoice.png',
                mimeType: 'image/png'
              }
            ]
          }
        ]
      })
    ).rejects.toThrow('local file attachments')

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes the configured Tencent region into Hunyuan3D requests', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockHunyuanCredentials()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: '一个简约风格的白色马克杯' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-shanghai'
    )
    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: '一个简约风格的白色马克杯' }],
      'SubmitHunyuanTo3DRapidJob',
      expect.objectContaining({
        EnablePBR: false,
        FaceLevel: 'low',
        PolygonType: 'triangle',
        ProfileTemplate: 'DEFAULT'
      })
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/cup.glb)')
  })

  it('applies the caller structured-output contract to Hunyuan3D responses', async () => {
    generateFromMessagesMock.mockResolvedValue('{"modelUrl":"https://example.com/cup.glb"}')

    mockHunyuanCredentials()

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'return a structured model result' }],
      structuredOutput: {
        name: 'hunyuan_result',
        schema: {
          type: 'object',
          required: ['modelUrl'],
          properties: { modelUrl: { type: 'string', format: 'uri' } }
        }
      }
    })

    expect(resp.content).toBe('{"modelUrl":"https://example.com/cup.glb"}')
  })

  it('rejects Hunyuan3D responses that violate the caller structured-output contract', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockHunyuanCredentials()

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
        messages: [{ role: 'user', content: 'return a structured model result' }],
        structuredOutput: {
          name: 'hunyuan_result',
          schema: {
            type: 'object',
            required: ['modelUrl'],
            properties: { modelUrl: { type: 'string', format: 'uri' } }
          }
        }
      })
    ).rejects.toThrow('Provider returned invalid structured output JSON.')
  })

  it('trims configured Tencent credentials before constructing the Hunyuan3D client', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockHunyuanCredentials({
      tencent_secret_id: '  secret-id  ',
      tencent_secret_key: '\nsecret-key\t'
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'trim secrets before use' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-shanghai'
    )
  })

  it('passes legacy encoded model source file name hints into Hunyuan3D post-process requests', async () => {
    generateFromMessagesMock.mockResolvedValue(
      '[Generated OBJ Package.zip](https://example.com/cup.zip)'
    )

    mockHunyuanCredentials()

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId:
        'hunyuan3d-pro::SubmitTextureTo3DJob::3.1::Normal::500000::DEFAULT::triangle::triangle::0::DEFAULT::Generated%20OBJ%20Package.zip',
      messages: [
        { role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }
      ]
    })

    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }],
      'SubmitTextureTo3DJob',
      expect.objectContaining({
        SourceFileName: 'Generated OBJ Package.zip'
      })
    )
  })

  it('parses keyed model source file name hints for Hunyuan3D fallback requests', async () => {
    generateFromMessagesMock.mockResolvedValue(
      '[Generated OBJ Package.zip](https://example.com/cup.zip)'
    )

    mockHunyuanCredentials()

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId:
        'hunyuan3d-pro::SubmitTextureTo3DJob::3.1::Normal::500000::DEFAULT::triangle::triangle::0::DEFAULT::source=Generated%20OBJ%20Package.zip::task=tripo-task-1',
      messages: [
        { role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }
      ]
    })

    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }],
      'SubmitTextureTo3DJob',
      expect.objectContaining({
        SourceFileName: 'Generated OBJ Package.zip'
      })
    )
  })

  it('uses ap-guangzhou when neither Tencent API region nor COS region is configured', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockHunyuanCredentials({ api_region: '', cos_region: '' })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'missing region' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-guangzhou'
    )
  })

  it('does not reuse the COS region when a dedicated Tencent API region is not configured', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockHunyuanCredentials({ api_region: '', cos_region: 'ap-singapore' })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'default api region' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-guangzhou'
    )
  })

  it('allows the Pro REST path to run with a Hunyuan API profile even when Tencent secrets are absent', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'api token pro path' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      'hy-token',
      'https://proxy.example',
      '',
      '',
      'ap-guangzhou'
    )
    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'api token pro path' }],
      'SubmitHunyuanTo3DProJob',
      expect.any(Object)
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/cup.glb)')
  })

  it('routes explicit Tripo3D quick app requests to Tripo regardless of Hunyuan preference', async () => {
    tripoGenerateFromMessagesMock.mockResolvedValue(
      '[Generated 3D Model](https://example.com/tripo.glb)'
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example',
            api_key: 'hy-token'
          },
          {
            id: 'plugin-tripo',
            model_name: 'Tripo v3.1',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: 'tripo-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId:
        'tripo3d-pro::SubmitHunyuanTo3DProJob::3.1::Normal::500000::DEFAULT::triangle::triangle::1',
      messages: [{ role: 'user', content: 'a small robot' }]
    })

    expect(Tripo3DClientMock).toHaveBeenCalledWith(
      'tripo-token',
      'https://api.tripo3d.ai/v2/openapi',
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(Hunyuan3DClientMock).not.toHaveBeenCalled()
    expect(tripoGenerateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'a small robot' }],
      'SubmitHunyuanTo3DProJob',
      expect.objectContaining({
        Model: '3.1',
        GenerateType: 'Normal',
        FaceCount: 500000,
        EnablePBR: true
      })
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/tripo.glb)')
  })

  it('routes legacy Hunyuan3D quick app requests to Tripo when Tripo is preferred', async () => {
    tripoGenerateFromMessagesMock.mockResolvedValue(
      '[Generated 3D Model](https://example.com/tripo-legacy.glb)'
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-tripo',
            model_name: 'Tripo v3.1',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: 'tripo-token'
          },
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId:
        'hunyuan3d-pro::SubmitHunyuanTo3DProJob::3.1::Normal::500000::DEFAULT::triangle::triangle::1',
      messages: [{ role: 'user', content: 'legacy tripo route' }]
    })

    expect(Tripo3DClientMock).toHaveBeenCalledWith(
      'tripo-token',
      'https://api.tripo3d.ai/v2/openapi',
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(Hunyuan3DClientMock).not.toHaveBeenCalled()
    expect(tripoGenerateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'legacy tripo route' }],
      'SubmitHunyuanTo3DProJob',
      expect.objectContaining({
        Model: '3.1',
        GenerateType: 'Normal',
        FaceCount: 500000,
        EnablePBR: true
      })
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/tripo-legacy.glb)')
  })

  it('lets legacy Hunyuan3D requests fall through when Hunyuan is preferred', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/hy.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example',
            api_key: 'hy-token'
          },
          {
            id: 'plugin-tripo',
            model_name: 'Tripo v3.1',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: 'tripo-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'hunyuan route' }]
    })

    expect(Tripo3DClientMock).not.toHaveBeenCalled()
    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      'hy-token',
      'https://proxy.example',
      '',
      '',
      'ap-guangzhou'
    )
    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hunyuan route' }],
      'SubmitHunyuanTo3DProJob',
      expect.any(Object)
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/hy.glb)')
  })

  it('passes Tripo profile extras through to the Tripo client', async () => {
    tripoGenerateFromMessagesMock.mockResolvedValue(
      '[Generated 3D Model](https://example.com/rigged.glb)'
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-tripo',
            model_name: 'Tripo v3.1',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: 'tripo-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId:
        'hunyuan3d-pro::TripoRig::3.1::Normal::500000::DEFAULT::triangle::triangle::0::DEFAULT::task=task-rig-1::rigType=quadruped::rigSpec=mixamo::imageModel=flux-dev::template=toy::editView=left::animation=preset%3Arun',
      messages: [{ role: 'user', content: 'task-rig-1' }]
    })

    expect(tripoGenerateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'task-rig-1' }],
      'TripoRig',
      expect.objectContaining({
        OriginalTaskId: 'task-rig-1',
        RigType: 'quadruped',
        RigSpec: 'mixamo',
        ImageModelVersion: 'flux-dev',
        ImageTemplate: 'toy',
        EditView: 'left',
        Animation: 'preset:run'
      })
    )
  })

  it('verifies the Pro API-key submit and poll flow end-to-end through the service layer', async () => {
    useActualHunyuan3DClient.current = true
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            JobId: 'job-pro-1'
          }
        }),
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=mesh-1'
              }
            ]
          }
        }),
        text: async () => ''
      })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example/v1',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resultPromise = svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'a bronze dragon statue' }]
    })
    const expectation = expect(resultPromise).resolves.toEqual({
      content: '[Generated 3D Model](https://example.com/download?id=mesh-1)'
    })

    await vi.advanceTimersByTimeAsync(5000)
    await expectation

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      'hy-token',
      'https://proxy.example/v1',
      '',
      '',
      'ap-guangzhou'
    )

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]
    expect(submitUrl).toBe('https://proxy.example/v1/ai3d/submit')
    expect(submitInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer hy-token',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(submitInit?.body))).toMatchObject({
      Prompt: 'a bronze dragon statue',
      GenerateType: 'Normal',
      EnablePBR: false
    })

    const [queryUrl, queryInit] = fetchMock.mock.calls[1]
    expect(queryUrl).toBe('https://proxy.example/v1/ai3d/query')
    expect(JSON.parse(String(queryInit?.body))).toEqual({ JobId: 'job-pro-1' })
  })

  it('preserves Tencent RequestId when the Pro API-key poll path fails through the service layer', async () => {
    useActualHunyuan3DClient.current = true
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            JobId: 'job-pro-fail-1'
          }
        }),
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            Status: 'FAIL',
            ErrorCode: 'InvalidParameter',
            ErrorMessage: 'bad prompt',
            RequestId: 'req-pro-fail-1'
          }
        }),
        text: async () => ''
      })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example/v1',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resultPromise = svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'bad request' }]
    })
    const expectation = expect(resultPromise).rejects.toThrow('RequestId=req-pro-fail-1')

    await vi.advanceTimersByTimeAsync(5000)
    await expectation
  })

  it('clears the configured Hunyuan3D COS prefix', async () => {
    clearHy3dCosPrefixMock.mockResolvedValue({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 3,
      deletedCount: 3,
      errorCount: 0
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.clearHy3DCosPrefix({})

    expect(clearHy3dCosPrefixMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: 'magicpot/hunyuan3d'
      }
    )
    expect(resp).toEqual({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 3,
      deletedCount: 3,
      errorCount: 0
    })
  })

  it('clears the selected Hunyuan3D quick app profile COS prefix', async () => {
    clearHy3dCosPrefixMock.mockResolvedValue({
      bucket: 'profile-bucket-1250000000',
      region: 'ap-shanghai',
      keyPrefix: 'profiles/hy3d',
      matchedCount: 1,
      deletedCount: 1,
      errorCount: 0
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'legacy-secret-id',
        tencent_secret_key: 'legacy-secret-key',
        cos_bucket: 'legacy-bucket-1250000000',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'legacy/hy3d'
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://api.ai3d.cloud.tencent.com',
            api_key: '',
            tencent_secret_id: 'profile-secret-id',
            tencent_secret_key: 'profile-secret-key',
            cos_bucket: 'profile-bucket-1250000000',
            cos_region: 'ap-shanghai',
            cos_key_prefix: 'profiles/hy3d'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.clearHy3DCosPrefix({ profileId: 'plugin-hunyuan' })

    expect(clearHy3dCosPrefixMock).toHaveBeenCalledWith(
      { secretId: 'profile-secret-id', secretKey: 'profile-secret-key' },
      {
        bucket: 'profile-bucket-1250000000',
        region: 'ap-shanghai',
        keyPrefix: 'profiles/hy3d'
      }
    )
  })

  it('uploads a local model file via uploadHy3DModel', async () => {
    uploadLocalHy3dModelMock.mockResolvedValue({
      url: 'https://cos.example/signed-url',
      key: 'magicpot/hunyuan3d/2026/04/04/model.glb',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      fileName: 'model.glb',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    rememberTrustedLocalFileSelections(['C:/models/model.glb'])

    const svc = new LLMProxySvcImpl()
    const resp = await svc.uploadHy3DModel({ filePath: 'C:/models/model.glb' })

    expect(uploadLocalHy3dModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      { bucket: 'magicpot-1314265479', region: 'ap-guangzhou', keyPrefix: 'magicpot/hunyuan3d' },
      'C:/models/model.glb'
    )
    expect(resp.key).toBe('magicpot/hunyuan3d/2026/04/04/model.glb')
    expect(resp.fileName).toBe('model.glb')
  })

  it('rejects renderer-supplied local model paths that were not selected through the trusted dialog', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.uploadHy3DModel({ filePath: 'C:/models/secret.glb' })).rejects.toThrow(
      'trusted dialog'
    )
    expect(uploadLocalHy3dModelMock).not.toHaveBeenCalled()
  })

  it('uploads a buffered model via uploadHy3DModel', async () => {
    uploadBufferedHy3dModelMock.mockResolvedValue({
      url: 'https://cos.example/signed-url',
      key: 'magicpot/hunyuan3d/2026/04/04/cube.obj',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      fileName: 'cube.obj',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const base64Data = Buffer.from('cube-data').toString('base64')
    const svc = new LLMProxySvcImpl()
    const resp = await svc.uploadHy3DModel({ fileName: 'cube.obj', fileDataBase64: base64Data })

    expect(uploadBufferedHy3dModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      { bucket: 'magicpot-1314265479', region: 'ap-guangzhou', keyPrefix: 'magicpot/hunyuan3d' },
      'cube.obj',
      expect.any(Buffer)
    )
    expect(resp.fileName).toBe('cube.obj')
  })

  it('signs an existing COS model key via signHy3DModel', async () => {
    signHy3dCosModelMock.mockReturnValue({
      url: 'https://cos.example/signed-url?sign=abc',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.signHy3DModel({
      key: 'magicpot/hunyuan3d/model.glb',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou'
    })

    expect(signHy3dCosModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: 'magicpot/hunyuan3d'
      },
      'magicpot/hunyuan3d/model.glb'
    )
    expect(resp.url).toContain('signed-url')
  })

  it('refuses to sign a COS model outside the configured bucket or region', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()

    await expect(
      svc.signHy3DModel({
        key: 'magicpot/hunyuan3d/model.glb',
        bucket: 'other-bucket',
        region: 'ap-guangzhou'
      })
    ).rejects.toThrow('outside the configured bucket and region')

    await expect(
      svc.signHy3DModel({
        key: 'magicpot/hunyuan3d/model.glb',
        bucket: 'magicpot-1314265479',
        region: 'ap-shanghai'
      })
    ).rejects.toThrow('outside the configured bucket and region')

    expect(signHy3dCosModelMock).not.toHaveBeenCalled()
  })

  it('throws a field-specific error when only SecretId is missing', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow('SecretId')
    await expect(svc.clearHy3DCosPrefix({})).rejects.not.toThrow('SecretKey')
  })

  it('throws a field-specific error when only COS Bucket is missing', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: '',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow('COS Bucket')
    await expect(svc.clearHy3DCosPrefix({})).rejects.not.toThrow('COS Region')
  })

  it('surfaces a clearer message when COS rejects the configured SecretId', async () => {
    clearHy3dCosPrefixMock.mockRejectedValue(
      new Error(
        'InvalidAccessKeyId: The Access Key Id you provided does not exist in our records. requestId:req-cos-123 traceId:trace-cos-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow(
      'The configured Tencent Cloud SecretId is invalid or has expired'
    )
  })

  it('throws when Hunyuan3D chat is attempted without Tencent credentials', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: ''
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
        messages: [{ role: 'user', content: 'test' }]
      })
    ).rejects.toThrow('SecretId')
  })

  it('surfaces a clearer message when Tencent rejects the configured SecretId', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        'The SecretId is not found, please ensure that your SecretId is correct. requestId:req-123 traceId:trace-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
        messages: [{ role: 'user', content: 'test' }]
      })
    ).rejects.toThrow('The configured Tencent Cloud SecretId is invalid or has expired')
  })

  it('preserves Hunyuan3D client errors that are already normalized', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        '[Hunyuan3D] UV 展开提交在 5 次尝试后仍失败，请稍后重试。当前输入是 GLB；如果持续失败，可先用“格式转换”输出 FBX，再重新执行 UV 展开。 requestId:req-uv-123 traceId:trace-uv-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DUVJob',
        messages: [{ role: 'user', content: 'https://example.com/models/robot.glb' }]
      })
    ).rejects.toThrow('UV 展开提交在 5 次尝试后仍失败')
  })

  it('rewrites generic Hunyuan3D internal job failures into actionable UV guidance', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        '[Hunyuan3D] Job failed: FailedOperation.InnerError 服务内部错误，请重试。 RequestId=req-uv-inner-123'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    const error = await svc
      .chat({
        profileId:
          'hunyuan3d-pro::SubmitHunyuanTo3DUVJob::3.1::Normal::500000::DEFAULT::quadrilateral::quadrilateral::0::DEFAULT::robot.glb',
        messages: [{ role: 'user', content: 'https://example.com/models/robot.glb' }]
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'Tencent 3D service is temporarily unavailable and the job failed'
    )
    expect((error as Error).message).toContain('Current input is GLB')
    expect((error as Error).message).toContain('requestId:req-uv-inner-123')
  })

  it('throws when uploadHy3DModel is called without file path or buffer', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.uploadHy3DModel({})).rejects.toThrow(
      '[Hunyuan3D] Missing model file to upload.'
    )
  })
})

describe('native Agent tool loop', () => {
  afterEach(() => {
    vi.clearAllMocks()
    callToolMock.mockReset()
    listToolsMock.mockReset()
  })
  const bound = [
    {
      name: 'files.read',
      description: 'Read owned file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  ]
  const request = () => ({
    conversationId: 'owned-native-loop',
    profileId: 'agent-profile',
    messages: [{ role: 'user' as const, content: 'Inspect six files and summarize' }],
    skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.read'] }] }
  })
  const call = (id: string, path = 'a.txt') => ({
    id,
    name: 'files.read',
    wireName: 'mp_tool_0',
    arguments: JSON.stringify({ path })
  })
  it('executes six native calls, returns paired outputs, and preserves structured history', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockImplementation(async (_route, _name, args) => ({
      content: 'file:' + args.path
    }))
    const seen: unknown[] = []
    const chat = vi.fn(async (params: any) => {
      seen.push(
        structuredClone({
          tools: params.tools,
          toolTurns: params.toolTurns,
          messages: params.messages
        })
      )
      const n = params.toolTurns?.length || 0
      return n < 6
        ? {
            content: '',
            toolCalls: [call('call_' + n, n + '.txt')],
            finishReason: 'tool_call' as const
          }
        : { content: 'Six files read.' }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(chat).toHaveBeenCalledTimes(7)
    expect(callToolMock).toHaveBeenCalledTimes(6)
    expect((seen[6] as any).toolTurns.map((x: any) => x.results[0])).toEqual(
      Array.from({ length: 6 }, (_, i) => ({ callId: 'call_' + i, output: 'file:' + i + '.txt' }))
    )
    expect(result.metadata?.toolHistory).toHaveLength(6)
    expect(result.content).toBe('Six files read.')
    expect((seen[0] as any).tools).toEqual(bound)
  })
  it('executes a native batch serially and stops before the next tool on cancellation', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    const abort = new AbortController()
    const chat = vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [call('one'), call('two', 'b.txt')],
      finishReason: 'tool_call'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    callToolMock.mockImplementation(async () => {
      abort.abort()
      return { content: 'first result' }
    })
    await expect(
      new LLMProxySvcImpl().chat(request(), { signal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(callToolMock).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledOnce()
  })
  it('assigns distinct internal tool ids to every member of a native batch', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    const capturedToolCallIds: unknown[] = []
    callToolMock.mockImplementation(async (_route, _name, _args, options) => {
      capturedToolCallIds.push(options?.toolCallId)
      return { content: 'owned' }
    })
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [call('one', 'a.txt'), call('two', 'b.txt')],
        finishReason: 'tool_call'
      })
      .mockResolvedValueOnce({ content: 'done' })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)

    await expect(new LLMProxySvcImpl().chat(request())).resolves.toMatchObject({
      content: 'done'
    })
    expect(capturedToolCallIds).toHaveLength(2)
    expect(capturedToolCallIds[0]).toMatch(/^run-.*:tool:0$/)
    expect(capturedToolCallIds[1]).toMatch(/^run-.*:tool:1$/)
    expect(capturedToolCallIds[0]).not.toBe(capturedToolCallIds[1])
  })
  it('validates the full native batch before executing any member', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    const chat = vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [call('one'), { ...call('two'), name: 'shell.unbound' }],
      finishReason: 'tool_call'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    await expect(new LLMProxySvcImpl().chat(request())).rejects.toThrow(/unbound/i)
    expect(callToolMock).not.toHaveBeenCalled()
  })
  it('never executes a duplicate native call id twice', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockResolvedValue({ content: 'actual' })
    const chat = vi
      .fn()
      .mockResolvedValue({ content: '', toolCalls: [call('same')], finishReason: 'tool_call' })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    await expect(new LLMProxySvcImpl().chat(request())).rejects.toThrow(/duplicate/i)
    expect(callToolMock).toHaveBeenCalledOnce()
  })
  it('also permits more than four legacy JSON calls for providers without native tools', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockResolvedValue({ content: 'owned' })
    let n = 0
    const chat = vi.fn(async () =>
      ++n <= 6
        ? { content: JSON.stringify({ toolName: 'files.read', args: { path: n + '.txt' } }) }
        : { content: 'legacy completed' }
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat } as never)
    expect((await new LLMProxySvcImpl().chat(request())).content).toBe('legacy completed')
    expect(callToolMock).toHaveBeenCalledTimes(6)
  })
  it('falls back once only for a pre-output native capability rejection', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockResolvedValue({ content: 'owned' })
    const chat = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('tools is not supported'), { statusCode: 400 })
      )
      .mockResolvedValueOnce({ content: '{"toolName":"files.read","args":{"path":"a.txt"}}' })
      .mockResolvedValueOnce({ content: 'fallback done' })
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    expect((await new LLMProxySvcImpl().chat(request())).content).toBe('fallback done')
    expect(chat.mock.calls[0][0].tools).toEqual(bound)
    expect(chat.mock.calls[1][0].tools).toBeUndefined()
    expect(callToolMock).toHaveBeenCalledOnce()
  })
  it('does not use native fallback to bypass authentication or retry executed tools', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    const chat = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('tools is not supported'), { statusCode: 401 }))
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    await expect(new LLMProxySvcImpl().chat(request())).rejects.toThrow('not supported')
    expect(chat).toHaveBeenCalledOnce()
    expect(callToolMock).not.toHaveBeenCalled()
  })
  it('retains successful tools when the following model request fails without replay', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockResolvedValue({ content: 'saved tool result' })
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call('one')] })
      .mockRejectedValue(new Error('terminal model failure'))
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    const err = await new LLMProxySvcImpl().chat(request()).catch((e) => e)
    expect(err.message).toBe('terminal model failure')
    expect(err.metadata.toolHistory[0]).toMatchObject({
      status: 'completed',
      content: 'saved tool result'
    })
    expect(callToolMock).toHaveBeenCalledOnce()
  })
  it('enforces a finite 64-call budget rather than running forever', async () => {
    mockAgentProfile()
    listToolsMock.mockReturnValue(bound)
    callToolMock.mockResolvedValue({ content: 'owned' })
    let n = 0
    const chat = vi.fn(async () => ({ content: '', toolCalls: [call('budget_' + n++)] }))
    vi.mocked(cliFromProfile).mockReturnValue({ supportsNativeTools: true, chat } as never)
    await expect(new LLMProxySvcImpl().chat(request())).rejects.toThrow(/budget exhausted/)
    expect(callToolMock).toHaveBeenCalledTimes(64)
    expect(chat).toHaveBeenCalledTimes(65)
  })
})
