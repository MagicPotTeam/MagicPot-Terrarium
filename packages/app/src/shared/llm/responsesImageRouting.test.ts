import { describe, expect, it } from 'vitest'
import { resolveOpenAIClientApiMode } from './clients'
import { usesOpenAIResponsesImagePolicy } from './utils'
import type { LLMOpenAIApiMode } from '@shared/config/config'

const official = 'https://api.openai.com/v1'
const gateway = 'https://owned.example/v1'
const profile = {
  model_name: 'owned-opaque-model',
  base_url: official,
  provider: 'openai' as const,
  model_use: 'chat' as const
}

describe('one routing decision for OpenAI dispatch and image count preflight', () => {
  it.each(['responses', 'chat-completions', 'images'] as const)(
    'keeps explicit %s over image model and endpoint inference',
    (apiMode) => {
      expect(
        resolveOpenAIClientApiMode(`${official}/images/edits`, 'gpt-image-owned', {
          apiMode,
          modelUse: 'image'
        })
      ).toBe(apiMode)
    }
  )

  it.each([
    [official, 'opaque', undefined, 'responses'],
    [gateway, 'opaque', undefined, 'chat-completions'],
    [official, 'gpt-image-owned', undefined, 'images'],
    [official, 'gpt-image-owned', 'chat', 'responses'],
    [gateway, 'opaque', 'image', 'images'],
    [`${official}/images/edits`, 'opaque', 'chat', 'images'],
    [`${official}/images/generations?owned=1`, 'opaque', 'chat', 'images']
  ] as const)('resolves auto %s / %s / %s to %s', (url, model, modelUse, expected) => {
    expect(resolveOpenAIClientApiMode(url, model, { apiMode: 'auto', modelUse })).toBe(expected)
  })

  it('applies standard policy to official auto and explicit compatible Responses routes', () => {
    expect(usesOpenAIResponsesImagePolicy(profile)).toBe(true)
    expect(usesOpenAIResponsesImagePolicy({ ...profile, base_url: gateway })).toBe(false)
    expect(
      usesOpenAIResponsesImagePolicy({ ...profile, base_url: gateway, api_mode: 'responses' })
    ).toBe(true)
  })

  it.each(['images', 'chat-completions'] as const)(
    'does not assign Responses count policy to %s profiles',
    (api_mode) => {
      expect(usesOpenAIResponsesImagePolicy({ ...profile, api_mode })).toBe(false)
    }
  )

  it('uses request mode overrides in both directions without mutating the source profile', () => {
    const imageProfile = {
      ...profile,
      api_mode: 'images' as LLMOpenAIApiMode,
      model_use: 'image' as const
    }
    const before = JSON.stringify(imageProfile)
    expect(usesOpenAIResponsesImagePolicy(imageProfile, 'responses')).toBe(true)
    expect(usesOpenAIResponsesImagePolicy(profile, 'images')).toBe(false)
    expect(JSON.stringify(imageProfile)).toBe(before)
  })

  it('preserves implicit image model routing and explicit chat model-use precedence', () => {
    expect(
      usesOpenAIResponsesImagePolicy({
        ...profile,
        model_name: 'gpt-image-owned',
        model_use: undefined
      })
    ).toBe(false)
    expect(usesOpenAIResponsesImagePolicy({ ...profile, model_name: 'gpt-image-owned' })).toBe(true)
    expect(
      usesOpenAIResponsesImagePolicy({ ...profile, base_url: `${official}/images/edits` })
    ).toBe(false)
  })

  it.each(['claude', 'gemini', 'ollama'] as const)(
    'does not assign OpenAI count policy to provider %s',
    (provider) => {
      expect(usesOpenAIResponsesImagePolicy({ ...profile, provider, api_mode: 'responses' })).toBe(
        false
      )
    }
  )

  it('does not infer the standard client policy for a local runtime route', () => {
    expect(usesOpenAIResponsesImagePolicy({ ...profile, call_type: 'local' })).toBe(false)
  })

  it('mirrors Zen GPT-specific Responses routing without changing other Zen providers', () => {
    const zen = { ...profile, base_url: 'https://opencode.ai/zen/v1' }
    expect(usesOpenAIResponsesImagePolicy({ ...zen, model_name: 'gpt-5.1' })).toBe(true)
    expect(usesOpenAIResponsesImagePolicy({ ...zen, model_name: 'claude-owned' })).toBe(false)
    expect(usesOpenAIResponsesImagePolicy({ ...zen, model_name: 'gemini-owned' })).toBe(false)
    expect(usesOpenAIResponsesImagePolicy({ ...zen, model_name: 'opaque' })).toBe(false)
  })
})
