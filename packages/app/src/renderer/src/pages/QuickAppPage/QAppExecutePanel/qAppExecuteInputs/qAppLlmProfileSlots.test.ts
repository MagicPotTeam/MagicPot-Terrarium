import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import {
  isQAppLlmProfileUsableInWorkflow,
  resolveQAppLlmProfileSlotValues
} from './qAppLlmProfileSlots'

const originalLlmProfileExtensions = [...sharedHostExtensionApiV1.llmProfiles]
const profile: LLMAPIProfile = {
  id: 'neutral-workflow-profile',
  model_name: 'neutral-model',
  base_url: 'https://neutral.example/v1',
  api_key: 'neutral-key'
}
const config: Config = DEFAULT_CONFIG

afterEach(() => {
  sharedHostExtensionApiV1.llmProfiles.splice(
    0,
    sharedHostExtensionApiV1.llmProfiles.length,
    ...originalLlmProfileExtensions
  )
})

describe('QuickApp LLM workflow profile extension delegation', () => {
  it('blocks retired profiles before slot export or provider extension overrides', () => {
    const retired = { ...profile, call_type: ['chat', 'gpt', '-web-playwright'].join('') }
    sharedHostExtensionApiV1.llmProfiles.push({ id: 'must-not-override-retirement', isQAppLlmProfileUsableInWorkflow: () => true, resolveQAppLlmProfileSlotValues: () => ({ modelName: 'bypass', baseUrl: 'https://api.test', apiKey: 'secret', isOllama: false }) })
    expect(isQAppLlmProfileUsableInWorkflow(config, retired)).toBe(false)
    expect(() => resolveQAppLlmProfileSlotValues(config, retired)).toThrow('removed')
    expect(retired.api_key).toBe('neutral-key')
  })
  it('uses the normal slot fallback when the public registry is empty', () => {
    sharedHostExtensionApiV1.llmProfiles.splice(0)

    expect(isQAppLlmProfileUsableInWorkflow(config, profile)).toBe(true)
    expect(resolveQAppLlmProfileSlotValues(config, profile)).toEqual({
      modelName: 'neutral-model',
      baseUrl: 'https://neutral.example/v1',
      apiKey: 'neutral-key',
      isOllama: false
    })
  })

  it('uses a registered neutral extension for workflow usability and slot values', () => {
    const extensionConfig: Config = {
      ...config,
      local_llm_server_config: { ...DEFAULT_CONFIG.local_llm_server_config }
    }
    const resolvedSlotValues = {
      modelName: 'extension-model',
      baseUrl: 'https://extension.example/v1',
      apiKey: 'extension-key',
      isOllama: false
    }
    sharedHostExtensionApiV1.llmProfiles.push({
      id: 'neutral-workflow-extension',
      isQAppLlmProfileUsableInWorkflow: (candidate, candidateConfig) => {
        expect(candidate).toBe(profile)
        expect(candidateConfig).toBe(extensionConfig)
        return false
      },
      resolveQAppLlmProfileSlotValues: (candidate, candidateConfig) => {
        expect(candidate).toBe(profile)
        expect(candidateConfig).toBe(extensionConfig)
        return resolvedSlotValues
      }
    })

    expect(isQAppLlmProfileUsableInWorkflow(extensionConfig, profile)).toBe(false)
    expect(resolveQAppLlmProfileSlotValues(extensionConfig, profile)).toBe(resolvedSlotValues)
  })

  it('continues to the normal fallback when an extension declines both hooks', () => {
    sharedHostExtensionApiV1.llmProfiles.push({
      id: 'neutral-declining-extension',
      isQAppLlmProfileUsableInWorkflow: () => undefined,
      resolveQAppLlmProfileSlotValues: () => undefined
    })

    expect(isQAppLlmProfileUsableInWorkflow(config, profile)).toBe(true)
    expect(resolveQAppLlmProfileSlotValues(config, profile).modelName).toBe('neutral-model')
  })
})
