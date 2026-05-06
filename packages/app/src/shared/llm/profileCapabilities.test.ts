import { describe, expect, it } from 'vitest'
import { resolveChatProfileCapabilities } from './profileCapabilities'

describe('resolveChatProfileCapabilities', () => {
  it('exposes gpt-5.5 reasoning efforts with medium default for API key profiles', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'gpt-5.5',
      provider: 'openai',
      auth_mode: 'api_key'
    })

    expect(capabilities.defaultReasoningEffort).toBe('medium')
    expect(capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(capabilities.contextWindowTokens).toBe(258_000)
  })

  it('keeps gpt-5.4 API profiles on the larger OpenAI context window', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'gpt-5.4',
      provider: 'openai',
      auth_mode: 'api_key'
    })

    expect(capabilities.defaultReasoningEffort).toBe('none')
    expect(capabilities.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(capabilities.contextWindowTokens).toBe(1_050_000)
    expect(capabilities.contextBudgetTokens).toBe(682_500)
  })
})
