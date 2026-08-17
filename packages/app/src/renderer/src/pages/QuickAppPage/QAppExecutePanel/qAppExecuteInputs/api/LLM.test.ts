import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import {
  ClaudeAPICli,
  GeminiAPICli,
  MainProcessQAppLLMProxyCli,
  OllamaAPICli,
  cliFromProfile,
  defaultCliFromProfile
} from './LLM'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

const { llmProxyChatMock } = vi.hoisted(() => ({
  llmProxyChatMock: vi.fn()
}))
const originalLlmProfileExtensions = [...sharedHostExtensionApiV1.llmProfiles]

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcLLMProxy: {
      chat: llmProxyChatMock
    }
  })
}))

describe('QuickApp renderer LLM compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    llmProxyChatMock.mockReset()
    sharedHostExtensionApiV1.llmProfiles = [...originalLlmProfileExtensions]
  })

  it.each([
    {
      id: 'quick-ollama',
      model_name: 'llama3.2',
      base_url: 'http://localhost:11434',
      api_key: '',
      provider: 'ollama' as const
    },
    {
      id: 'quick-gemini',
      model_name: 'gemini-2.0-flash',
      base_url: 'https://generativelanguage.googleapis.com',
      api_key: 'key',
      provider: 'gemini' as const
    },
    {
      id: 'quick-claude',
      model_name: 'claude-3-7-sonnet',
      base_url: 'https://gateway.example/llm',
      api_key: 'sk-test',
      provider: 'claude' as const
    }
  ])('routes $provider QuickApp profiles through the guarded proxy', (profile) => {
    expect(cliFromProfile(profile)).toBeInstanceOf(MainProcessQAppLLMProxyCli)
  })

  it('routes model-less CLIProxyAPI image interrogation through the main-process proxy', async () => {
    sharedHostExtensionApiV1.llmProfiles = [
      {
        id: 'cliproxyapi-test',
        isRunnableProfile: (profile) =>
          profile.call_type === 'cliproxyapi'
            ? Boolean(profile.base_url?.trim() && profile.api_key?.trim())
            : undefined,
        resolveProfileCallType: (profile) =>
          profile.call_type === 'cliproxyapi' ? 'cliproxyapi' : undefined
      }
    ]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    llmProxyChatMock.mockResolvedValueOnce({ content: 'interrogated prompt' })

    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-cliproxyapi',
            model_name: '',
            base_url: 'https://proxy.example.test/v1',
            api_key: 'cpa-test',
            call_type: 'cliproxyapi',
            is_vision_model: true
          }
        ]
      }
    }
    const client = defaultCliFromProfile(config, true)

    expect(client).toBeInstanceOf(MainProcessQAppLLMProxyCli)
    await expect(
      client?.generatePrompt({
        prompt: 'describe this canvas image',
        imageObjUrl: PNG_DATA_URL
      })
    ).resolves.toBe('interrogated prompt')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'quick-cliproxyapi',
        profileScope: 'qapp',
        messages: [
          expect.objectContaining({
            attachments: [expect.objectContaining({ url: PNG_DATA_URL })]
          })
        ]
      })
    )
  })

  it('keeps renderer provider classes exported for direct compatibility use', () => {
    expect(new OllamaAPICli('', 'http://localhost:11434', 'llama3.2')).toBeInstanceOf(OllamaAPICli)
    expect(new GeminiAPICli('key', 'https://example.com', 'gemini')).toBeInstanceOf(GeminiAPICli)
    expect(new ClaudeAPICli('key', 'https://example.com', 'claude')).toBeInstanceOf(ClaudeAPICli)
  })

  it('routes video generation profiles through the main-process Quick App proxy', async () => {
    const client = cliFromProfile({
      id: 'quick-video',
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      api_secret: 'secret-key',
      provider: 'kling',
      model_use: 'video'
    })

    expect(client).toBeInstanceOf(MainProcessQAppLLMProxyCli)
    llmProxyChatMock.mockResolvedValueOnce({
      content: '',
      attachments: [{ type: 'video', url: 'https://cdn.example/video.mp4' }]
    })

    await expect(client?.generatePrompt({ prompt: 'make a video' })).resolves.toBe(
      'https://cdn.example/video.mp4'
    )
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'quick-video',
        profileScope: 'qapp',
        messages: [expect.objectContaining({ role: 'user', content: 'make a video' })]
      })
    )
  })

  it('selects a configured Ollama quick app profile without an API key', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llama3.2',
            base_url: 'http://localhost:11434',
            api_key: ''
          }
        ]
      }
    }

    expect(defaultCliFromProfile(config)).toBeInstanceOf(MainProcessQAppLLMProxyCli)
  })

  it('selects an explicitly configured Ollama quick app profile on generic gateways', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llama3.2',
            base_url: 'https://gateway.example/llm',
            api_key: '',
            provider: 'ollama' as const
          }
        ]
      }
    }

    expect(defaultCliFromProfile(config)).toBeInstanceOf(MainProcessQAppLLMProxyCli)
  })

  it('materializes built-in provider images without profile attachment capabilities', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength) }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    llmProxyChatMock.mockResolvedValueOnce({ content: 'ok' })
    const params = { prompt: 'inspect', imageObjUrl: 'blob:https://app.example/image' }
    const client = cliFromProfile({
      id: 'quick-claude',
      model_name: 'claude',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'claude'
    })!

    await expect(client.generatePrompt(params)).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(params.imageObjUrl).toBe('blob:https://app.example/image')
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [
              expect.objectContaining({
                url: PNG_DATA_URL,
                metadata: { internalTransport: 'qapp-renderer-materialized-v1' }
              })
            ]
          })
        ]
      })
    )
  })

  it.each([1, 2])(
    'incrementally encodes image streams split every %i byte(s)',
    async (chunkSize) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < PNG_BYTES.length; offset += chunkSize) {
            controller.enqueue(PNG_BYTES.slice(offset, offset + chunkSize))
          }
          controller.close()
        }
      })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength) }
          })
        )
      )
      llmProxyChatMock.mockResolvedValueOnce({ content: 'ok' })
      const client = cliFromProfile({
        id: 'quick-gemini',
        model_name: 'gemini',
        base_url: 'https://example.com',
        api_key: 'key',
        provider: 'gemini'
      })!

      await client.generatePrompt({
        prompt: 'inspect',
        imageObjUrl: 'blob:https://app.example/image'
      })

      expect(llmProxyChatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              attachments: [expect.objectContaining({ url: PNG_DATA_URL })]
            })
          ]
        })
      )
    }
  )

  it('validates and passes canonical request data URLs without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    llmProxyChatMock.mockResolvedValueOnce({ content: 'ok' })
    const client = cliFromProfile({
      id: 'quick-ollama',
      model_name: 'llama',
      base_url: 'http://localhost:11434',
      api_key: '',
      provider: 'ollama'
    })!

    await client.generatePrompt({ prompt: 'inspect', imageObjUrl: PNG_DATA_URL })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [
              {
                type: 'image',
                url: PNG_DATA_URL,
                mimeType: 'image/png',
                metadata: { internalTransport: 'qapp-renderer-materialized-v1' }
              }
            ]
          })
        ]
      })
    )
  })

  it('rejects non-canonical Base64 data URLs before IPC', async () => {
    const client = cliFromProfile({
      id: 'quick-gemini',
      model_name: 'gemini',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'gemini'
    })!

    await expect(
      client.generatePrompt({ prompt: 'inspect', imageObjUrl: 'data:image/png;base64,AB==' })
    ).rejects.toThrow(/canonical/)
    expect(llmProxyChatMock).not.toHaveBeenCalled()
  })

  it.each([
    ['empty response', new Uint8Array(), 'image/png', /empty/],
    ['spoofed response', new Uint8Array([1, 2, 3]), 'image/png', /image bytes/],
    ['MIME-mismatched response', PNG_BYTES, 'image/jpeg', /MIME mismatch/]
  ])('rejects a %s before IPC', async (_label, bytes, contentType, expectedError) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': contentType,
            'content-length': String(bytes.byteLength)
          }
        })
      )
    )
    const client = cliFromProfile({
      id: 'quick-gemini',
      model_name: 'gemini',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'gemini'
    })!

    await expect(
      client.generatePrompt({ prompt: 'inspect', imageObjUrl: 'blob:https://app.example/image' })
    ).rejects.toThrow(expectedError)
    expect(llmProxyChatMock).not.toHaveBeenCalled()
  })

  it('preserves built-in-provider video image URLs without renderer materialization', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    llmProxyChatMock.mockResolvedValueOnce({ content: 'queued' })
    const imageObjUrl = 'https://cdn.example/input.png?signature=keep'
    const client = cliFromProfile({
      id: 'quick-gemini-video',
      model_name: 'veo',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'gemini',
      model_use: 'video'
    })!

    await client.generatePrompt({ prompt: 'animate', imageObjUrl })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [{ type: 'image', url: imageObjUrl }]
          })
        ]
      })
    )
  })

  it('passes Volcengine image URLs through without renderer materialization', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    llmProxyChatMock.mockResolvedValueOnce({ content: 'queued' })
    const imageObjUrl = 'https://cdn.example/input.png?signature=keep'
    const client = cliFromProfile({
      id: 'quick-volcengine',
      model_name: 'seedance',
      base_url: 'https://ark.cn-beijing.volces.com',
      api_key: 'key',
      provider: 'volcengine',
      model_use: 'video'
    })!

    await client.generatePrompt({ prompt: 'animate', imageObjUrl })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [{ type: 'image', url: imageObjUrl }]
          })
        ]
      })
    )
  })

  it('rejects and cancels a stream once it exceeds the request image limit', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024 * 1024))
        controller.enqueue(new Uint8Array(6 * 1024 * 1024))
      },
      cancel
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'image/webp' }
        })
      )
    )
    const client = cliFromProfile({
      id: 'quick-gemini',
      model_name: 'gemini',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'gemini'
    })!

    await expect(
      client.generatePrompt({ prompt: 'inspect', imageObjUrl: 'blob:https://app.example/image' })
    ).rejects.toThrow(/exceeds/)
    expect(cancel).toHaveBeenCalledOnce()
    expect(llmProxyChatMock).not.toHaveBeenCalled()
  })

  it('rejects an unstreamed response without a bounded content length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        body: null,
        arrayBuffer: vi.fn()
      })
    )
    const client = cliFromProfile({
      id: 'quick-claude',
      model_name: 'claude',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'claude'
    })!

    await expect(
      client.generatePrompt({ prompt: 'inspect', imageObjUrl: 'blob:https://app.example/image' })
    ).rejects.toThrow(/bounded content length/)
    expect(llmProxyChatMock).not.toHaveBeenCalled()
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
  ])('rejects unsafe video image URL %s before IPC', async (imageObjUrl) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = cliFromProfile({
      id: 'quick-kling',
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      api_secret: 'secret-key',
      provider: 'kling',
      model_use: 'video'
    })!

    await expect(client.generatePrompt({ prompt: 'animate', imageObjUrl })).rejects.toThrow(
      /public HTTPS image URL/
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(llmProxyChatMock).not.toHaveBeenCalled()
  })

  it('rejects overlong video image URLs before IPC', async () => {
    const client = cliFromProfile({
      id: 'quick-volcengine',
      model_name: 'seedance',
      base_url: 'https://ark.cn-beijing.volces.com',
      api_key: 'key',
      provider: 'volcengine',
      model_use: 'video'
    })!

    await expect(
      client.generatePrompt({
        prompt: 'animate',
        imageObjUrl: `https://cdn.example/${'a'.repeat(8192)}`
      })
    ).rejects.toThrow(/at most 8192 characters/)
    expect(llmProxyChatMock).not.toHaveBeenCalled()
  })

  it('preserves Kling image URLs untouched on its dedicated proxy route', async () => {
    const imageObjUrl = 'https://cdn.example/source.png?signature=keep-me'
    llmProxyChatMock.mockResolvedValueOnce({ content: 'queued' })
    const client = cliFromProfile({
      id: 'quick-kling',
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      api_secret: 'secret-key',
      provider: 'kling',
      model_use: 'video'
    })!

    await expect(client.generatePrompt({ prompt: 'animate', imageObjUrl })).resolves.toBe('queued')
    expect(llmProxyChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            attachments: [{ type: 'image', url: imageObjUrl }]
          })
        ]
      })
    )
  })

  it('preserves text-only proxy behavior without attachment capabilities', async () => {
    llmProxyChatMock.mockResolvedValueOnce({ content: ' text response ' })
    const client = cliFromProfile({
      id: 'quick-gemini',
      model_name: 'gemini',
      base_url: 'https://example.com',
      api_key: 'key',
      provider: 'gemini'
    })!

    await expect(client.generatePrompt({ prompt: 'hello' })).resolves.toBe('text response')
    expect(llmProxyChatMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes Ollama base URLs that already include /api/chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OllamaAPICli('', 'http://localhost:11434/api/chat', 'llama3.2')
    await expect(client.generatePrompt({ prompt: 'hello' })).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })
})
