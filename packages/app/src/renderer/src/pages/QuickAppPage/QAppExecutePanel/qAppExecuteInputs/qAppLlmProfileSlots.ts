import type { Config, LLMAPIProfile } from '@shared/config/config'
import { isOllamaProfile } from '@shared/llm'

export const isQAppLlmProfileUsableInWorkflow = (config: Config, profile: LLMAPIProfile): boolean =>
  Boolean(config) && Boolean(profile)

export const resolveQAppLlmProfileSlotValues = (config: Config, profile: LLMAPIProfile) => {
  return {
    modelName: profile.model_name,
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    isOllama: isOllamaProfile(profile)
  }
}
