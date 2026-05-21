import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli, OpenAIAPICli } from './clients'
import {
  cliFromProfile,
  isClaudeUrl,
  isGeminiUrl,
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
  })

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

  it('does not treat cloud OpenAI profiles as runnable without a stored API key', () => {
    const profile = {
      model_name: 'gpt-5',
      base_url: 'https://api.openai.com/v1',
      api_key: ''
    }

    expect(isRunnableProfile(profile)).toBe(false)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('requires cloud API profiles to provide an endpoint before they can run', () => {
    const profile = {
      model_name: 'gpt-5',
      base_url: '',
      api_key: 'sk-test'
    }

    expect(isRunnableProfile(profile)).toBe(false)
    expect(cliFromProfile(profile)).toBeUndefined()
  })

  it('sends OpenAI-compatible chat requests without private priority flags', async () => {
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
      api_key: 'sk-test'
    }

    const cli = cliFromProfile(profile)
    expect(cli).toBeInstanceOf(OpenAIAPICli)

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })

    const requestInit = fetchMock.mock.calls[0]?.[1]
    const requestBody = JSON.parse(String(requestInit?.body))
    expect(requestBody).toMatchObject({ model: 'gpt-5' })
    expect(requestBody).not.toHaveProperty('service_tier')
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

  it('matches Gemini and Claude providers by hostname only', () => {
    expect(isGeminiUrl('generativelanguage.googleapis.com/v1beta')).toBe(true)
    expect(isGeminiUrl('https://evil.example/generativelanguage.googleapis.com/v1beta')).toBe(false)
    expect(isClaudeUrl('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isClaudeUrl('https://gateway.example/claude/v1/messages')).toBe(false)
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
})
