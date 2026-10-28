import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli, OpenAIAPICli } from './clients'
import { KlingVideoAPICli, VolcengineSeedanceAPICli } from './videoClients'
import {
  cliFromProfile,
  isOllamaProfile,
  isOllamaUrl,
  isRunnableProfile,
  resolveProfileCallType,
  resolveProfileModelUse
} from './utils'

describe('shared llm ollama compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const stableFetch = (() => Promise.reject(new Error('not used'))) as typeof fetch

  it('detects the default Ollama host and allows profiles without API keys', () => {
    const profile = {
      model_name: 'llama3.2',
      base_url: 'http://localhost:11434',
      api_key: ''
    }

    expect(isOllamaUrl(profile.base_url)).toBe(true)
    expect(isOllamaProfile(profile)).toBe(true)
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeInstanceOf(OllamaAPICli)
  })

  it('honors explicit ollama mode on non-standard hosts', () => {
    const profile = {
      model_name: 'llama3.2',
      base_url: 'https://gateway.example/llm',
      api_key: '',
      is_ollama: true
    }

    expect(isOllamaProfile(profile)).toBe(true)
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeInstanceOf(OllamaAPICli)
  })

  it('allows explicit ollama providers on generic gateways without API keys', () => {
    const profile = {
      model_name: 'llama3.2',
      base_url: 'https://gateway.example/llm',
      api_key: '',
      provider: 'ollama' as const
    }

    expect(isOllamaProfile(profile)).toBe(true)
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeInstanceOf(OllamaAPICli)
  })

  it('treats local vision profiles as non-runnable local-model entries', () => {
    const profile = {
      model_name: 'Local CLIP',
      base_url: '',
      api_key: '',
      call_type: 'local' as const,
      local_model_path: 'D:/models/clip/model.onnx'
    }

    expect(resolveProfileCallType(profile)).toBe('local')
    expect(isRunnableProfile(profile)).toBe(false)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('still requires API keys for non-Ollama profiles', () => {
    const profile = {
      model_name: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
      api_key: ''
    }

    expect(isOllamaProfile(profile)).toBe(false)
    expect(isRunnableProfile(profile)).toBe(false)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('keeps OpenAI-compatible profiles on the OpenAI client path', () => {
    const profile = {
      model_name: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test'
    }

    expect(cliFromProfile(profile)).toBeInstanceOf(OpenAIAPICli)
  })

  it('treats official Codex OAuth profiles as runnable without a stored API key', () => {
    const profile = {
      model_name: 'gpt-5',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      auth_mode: 'codex_oauth' as const
    }

    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('treats model-less Codex OAuth profiles with an implicit official endpoint as runnable', () => {
    const profile = {
      model_name: '',
      base_url: '',
      api_key: '',
      auth_mode: 'codex_oauth' as const
    }

    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('maps Codex fast mode to OpenAI priority processing on the official endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const profile = {
      model_name: 'gpt-5',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      codex_fast_mode: true
    }

    const cli = cliFromProfile(profile)
    expect(cli).toBeInstanceOf(OpenAIAPICli)

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })

    const requestInit = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'gpt-5',
      service_tier: 'priority'
    })
  })

  it('treats model-less CLIProxyAPI/Codex profiles as runnable when endpoint and key are present', () => {
    const profile = {
      model_name: '',
      base_url: 'https://proxy.example.test/v1/',
      api_key: 'cpa-test',
      call_type: 'cliproxyapi' as const
    }

    expect(resolveProfileCallType(profile)).toBe('cliproxyapi')
    expect(isRunnableProfile(profile)).toBe(true)
  })

  it('uses Responses SSE and provider-hosted web search for CLIProxyAPI profiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      })
    })

    const profile = {
      model_name: 'gpt-5.4-mini',
      base_url: 'https://proxy.example.test/v1',
      api_key: 'cpa-test',
      call_type: 'cliproxyapi' as const
    }

    expect(resolveProfileCallType(profile)).toBe('cliproxyapi')
    const cli = cliFromProfile(profile, { fetchImpl: fetchMock as typeof fetch })
    expect(cli).toBeInstanceOf(OpenAIAPICli)

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://proxy.example.test/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({
      model: 'gpt-5.4-mini',
      service_tier: 'priority',
      stream: true
    })
    expect(requestBody.tools).toEqual([expect.objectContaining({ type: 'web_search' })])
    expect(requestBody.include).toEqual(['web_search_call.action.sources'])
  })

  it('auto-detects Gemini profiles from the API address when provider stays on default', () => {
    const profile = {
      model_name: 'gemini-2.5-flash',
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      api_key: 'sk-test',
      provider: 'default' as const
    }

    expect(cliFromProfile(profile)).toBeInstanceOf(GeminiAPICli)
  })

  it('propagates profile request_timeout_ms to every non-OpenAI provider client', async () => {
    vi.useFakeTimers()
    const profiles = [
      {
        profile: {
          model_name: 'gemini-2.5-flash',
          base_url: 'https://generativelanguage.googleapis.com/v1beta',
          api_key: 'gemini-key',
          provider: 'gemini' as const
        },
        client: GeminiAPICli
      },
      {
        profile: {
          model_name: 'claude-3-7-sonnet',
          base_url: 'https://api.anthropic.com',
          api_key: 'claude-key',
          provider: 'claude' as const
        },
        client: ClaudeAPICli
      },
      {
        profile: {
          model_name: 'llama3.2',
          base_url: 'http://127.0.0.1:11434',
          api_key: '',
          provider: 'ollama' as const
        },
        client: OllamaAPICli
      }
    ] as const

    for (const { profile, client } of profiles) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise<Response>(() => undefined))
      const cli = cliFromProfile(
        { ...profile, request_timeout_ms: 1_000 },
        { fetchImpl: fetchMock }
      )
      expect(cli).toBeInstanceOf(client)

      const pending = cli!.chat({ messages: [{ role: 'user', content: 'hello' }] })
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'MODEL_REQUEST_TIMEOUT'
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
    }
  })

  it('allows local OpenAI-compatible gateways without API keys', () => {
    const profile = {
      model_name: 'qwen2.5-vl',
      base_url: 'http://127.0.0.1:8000/v1',
      api_key: '',
      provider: 'openai' as const,
      deployment: 'local' as const
    }

    expect(isOllamaProfile(profile)).toBe(false)
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile)).toBeInstanceOf(OpenAIAPICli)
  })

  it('prefers explicit provider routing over URL heuristics', () => {
    const profile = {
      model_name: 'claude-3-7-sonnet',
      base_url: 'https://gateway.example/llm',
      api_key: 'sk-test',
      provider: 'claude' as const
    }

    expect(cliFromProfile(profile)).toBeInstanceOf(ClaudeAPICli)
  })

  it('can keep anthropic-looking gateways on the OpenAI-compatible path when requested', () => {
    const profile = {
      model_name: 'gpt-4o-mini',
      base_url: 'https://proxy.anthropic.com/v1/messages',
      api_key: 'sk-test',
      provider: 'openai' as const
    }

    expect(cliFromProfile(profile)).toBeInstanceOf(OpenAIAPICli)
  })

  it('infers OCR model use from the GLM-OCR model name even without an explicit model_use', () => {
    const profile = {
      model_name: 'GLM-OCR',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key: 'glm-key',
      provider: 'openai' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('ocr')
  })

  it('keeps explicit image-generation model use selections', () => {
    const profile = {
      model_name: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      model_use: 'image' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('image')
  })

  it('keeps explicit general-agent model use selections', () => {
    const profile = {
      model_name: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      model_use: 'agent' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('agent')
  })

  it('routes configured Kling video profiles to the Kling client only when both access key and secret are present', () => {
    const incompleteProfile = {
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      provider: 'kling' as const,
      model_use: 'video' as const
    }
    const profile = {
      ...incompleteProfile,
      api_secret: 'secret-key'
    }

    expect(resolveProfileModelUse(profile)).toBe('video')
    expect(isRunnableProfile(incompleteProfile)).toBe(false)
    expect(cliFromProfile(incompleteProfile)).toBeUndefined()
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile, { fetchImpl: stableFetch })).toBeInstanceOf(KlingVideoAPICli)
  })

  it('routes Volcengine Seedance video profiles without falling through to OpenAI', () => {
    const profile = {
      model_name: 'doubao-seedance-1-0-pro-250528',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'ark-key',
      provider: 'volcengine' as const,
      model_use: 'video' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('video')
    expect(isRunnableProfile(profile)).toBe(true)
    expect(cliFromProfile(profile, { fetchImpl: stableFetch })).toBeInstanceOf(
      VolcengineSeedanceAPICli
    )
  })

  it('infers Volcengine Seedance routing from the default Ark base URL only for video profiles', () => {
    const profile = {
      model_name: 'doubao-seedance-1-0-pro-250528',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'ark-key',
      model_use: 'video' as const
    }
    const chatProfile = {
      model_name: 'doubao-seed-1-6-250615',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'ark-key'
    }

    expect(cliFromProfile(profile, { fetchImpl: stableFetch })).toBeInstanceOf(
      VolcengineSeedanceAPICli
    )
    expect(resolveProfileModelUse(chatProfile)).toBe('chat')
    expect(cliFromProfile(chatProfile, { fetchImpl: stableFetch })).toBeInstanceOf(OpenAIAPICli)
  })

  it('does not route explicit non-video Ark profiles through the Volcengine video client', () => {
    const profile = {
      model_name: 'doubao-seed-1-6-250615',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'ark-key',
      provider: 'volcengine' as const,
      model_use: 'chat' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('chat')
    expect(cliFromProfile(profile, { fetchImpl: stableFetch })).toBeInstanceOf(OpenAIAPICli)
  })

  it('does not re-infer Kling video routing after a profile is switched to non-video use', () => {
    const profile = {
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      api_secret: 'stale-secret',
      provider: 'default' as const,
      model_use: 'default' as const
    }

    expect(resolveProfileModelUse(profile)).toBe('chat')
    expect(cliFromProfile(profile, { fetchImpl: stableFetch })).toBeInstanceOf(OpenAIAPICli)
  })
})
