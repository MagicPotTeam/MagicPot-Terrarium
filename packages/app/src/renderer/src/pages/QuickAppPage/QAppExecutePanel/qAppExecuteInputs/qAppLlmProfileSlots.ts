import type { Config, LLMAPIProfile } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import { isOllamaProfile } from '@shared/llm'

export const isQAppLlmProfileUsableInWorkflow = (
  config: Config,
  profile: LLMAPIProfile
): boolean => {
  if (!config || !profile) return false
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.isQAppLlmProfileUsableInWorkflow?.(profile, config)
    if (resolved !== undefined) return resolved
  }
  return true
}

export const resolveQAppLlmProfileSlotValues = (config: Config, profile: LLMAPIProfile) => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.resolveQAppLlmProfileSlotValues?.(profile, config)
    if (resolved !== undefined) return resolved
  }
  return {
    modelName: profile.model_name,
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    isOllama: isOllamaProfile(profile)
  }
}
