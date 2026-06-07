import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import {
  ClaudeAPICli,
  MainProcessQAppLLMProxyCli,
  OllamaAPICli,
  cliFromProfile,
  defaultCliFromProfile
} from './LLM'

const { llmProxyChatMock } = vi.hoisted(() => ({
  llmProxyChatMock: vi.fn()
}))

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
  })

  it('creates an Ollama client without requiring an API key', () => {
    const client = cliFromProfile({
      id: 'quick-ollama',
      model_name: 'llama3.2',
      base_url: 'http://localhost:11434',
      api_key: ''
    })

    expect(client).toBeInstanceOf(OllamaAPICli)
  })

  it('respects an explicit provider on generic quick app gateways', () => {
    const client = cliFromProfile({
      id: 'quick-claude',
      model_name: 'claude-3-7-sonnet',
      base_url: 'https://gateway.example/llm',
      api_key: 'sk-test',
      provider: 'claude'
    })

    expect(client).toBeInstanceOf(ClaudeAPICli)
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

    expect(defaultCliFromProfile(config)).toBeInstanceOf(OllamaAPICli)
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

    expect(defaultCliFromProfile(config)).toBeInstanceOf(OllamaAPICli)
  })

  it('normalizes Ollama base URLs that already include /api/chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OllamaAPICli('' as string, 'http://localhost:11434/api/chat', 'llama3.2')
    await expect(client.generatePrompt({ prompt: 'hello' })).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })
})
