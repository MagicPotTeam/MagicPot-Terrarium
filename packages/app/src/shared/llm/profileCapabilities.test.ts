import { describe, expect, it } from 'vitest'
import { resolveChatProfileCapabilities } from './profileCapabilities'

describe('resolveChatProfileCapabilities', () => {
  it('does not expose reasoning controls for normal API key profiles', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'gpt-5.5',
      provider: 'openai',
      auth_mode: 'api_key'
    })

    expect(capabilities.defaultReasoningEffort).toBeUndefined()
    expect(capabilities.reasoningEfforts).toEqual([])
    expect(capabilities.contextWindowTokens).toBeUndefined()
    expect(capabilities.supportsAutoContextCompression).toBe(false)
    expect(capabilities.supportsSessionContinuation).toBe(false)
  })

  it('exposes gpt-5.5 reasoning efforts for Codex call type profiles', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'gpt-5.5',
      provider: 'openai',
      call_type: 'codex'
    })

    expect(['medium', 'xhigh']).toContain(capabilities.defaultReasoningEffort)
    expect(capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(capabilities.contextWindowTokens).toBe(258_000)
  })

  it('does not expose reasoning or context-compression controls for normal gpt-5.4 API profiles', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'gpt-5.4',
      provider: 'openai',
      auth_mode: 'api_key'
    })

    expect(capabilities.defaultReasoningEffort).toBeUndefined()
    expect(capabilities.reasoningEfforts).toEqual([])
    expect(capabilities.contextWindowTokens).toBeUndefined()
    expect(capabilities.contextBudgetTokens).toBeUndefined()
    expect(capabilities.supportsAutoContextCompression).toBe(false)
  })

  it('uses explicit context metadata for non-Codex profiles without exposing reasoning efforts', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'compact-chat',
      provider: 'openai',
      auth_mode: 'api_key',
      context_window_tokens: 128_000,
      context_budget_tokens: 64_000
    })

    expect(capabilities.defaultReasoningEffort).toBeUndefined()
    expect(capabilities.reasoningEfforts).toEqual([])
    expect(capabilities.contextWindowTokens).toBe(128_000)
    expect(capabilities.contextBudgetTokens).toBe(64_000)
    expect(capabilities.supportsAutoContextCompression).toBe(true)
    expect(capabilities.supportsSessionContinuation).toBe(false)
  })

  it('enables session continuation only when a profile explicitly declares support', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'continuation-chat',
      provider: 'openai',
      auth_mode: 'api_key',
      supports_session_continuation: true
    })

    expect(capabilities.supportsSessionContinuation).toBe(true)
  })

  it('ignores non-positive or non-finite context metadata for non-Codex profiles', () => {
    const capabilities = resolveChatProfileCapabilities({
      model_name: 'compact-chat',
      provider: 'openai',
      auth_mode: 'api_key',
      context_window_tokens: Number.POSITIVE_INFINITY,
      context_budget_tokens: 0
    })

    expect(capabilities.reasoningEfforts).toEqual([])
    expect(capabilities.contextWindowTokens).toBeUndefined()
    expect(capabilities.contextBudgetTokens).toBeUndefined()
    expect(capabilities.supportsAutoContextCompression).toBe(false)
  })
})
