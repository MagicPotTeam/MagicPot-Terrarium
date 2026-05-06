import {
  DEFAULT_IMAGE_INTERROGATION_PROMPT,
  Config,
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
  DEFAULT_PROMPT_TRANSLATION_SYSTEM_PROMPT,
  DEFAULT_PROMPT_TRANSLATION_USER_PROMPT
} from '@shared/config/config'

export type QAppPromptSettings = {
  usePromptTranslation: boolean
  promptTranslationSystemPrompt: string
  promptTranslationUserPrompt: string
  promptTranslationProfileId?: string
  useImageInterrogation: boolean
  imageInterrogationSystemPrompt: string
  imageInterrogationUserPrompt: string
  imageInterrogationProfileId?: string
}

const REPLACE_PROMPT = '{{prompt}}'

const normalizeLegacyImageInterrogationPrompt = (prompt?: string) => {
  const trimmedPrompt = prompt?.trim() || ''
  if (!trimmedPrompt || trimmedPrompt === DEFAULT_IMAGE_INTERROGATION_PROMPT) {
    return ''
  }
  return trimmedPrompt
}

const resolveLegacyPromptTranslationPrompt = (promptTemplate: string) =>
  promptTemplate.includes(REPLACE_PROMPT)
    ? {
        systemPrompt: DEFAULT_PROMPT_TRANSLATION_USER_PROMPT,
        userPrompt: promptTemplate
      }
    : {
        systemPrompt: promptTemplate,
        userPrompt: DEFAULT_PROMPT_TRANSLATION_USER_PROMPT
      }

const resolvePromptTranslationPrompts = (config: Config) => {
  const pluginSystemPrompt = config.plugin_config?.promptTranslationSystemPrompt?.trim() || ''
  const pluginUserPrompt = config.plugin_config?.promptTranslationUserPrompt?.trim() || ''
  const pluginLegacyPrompt = config.plugin_config?.promptTranslationPrompt?.trim() || ''
  const llmLegacyPrompt = config.llm_config.promptTranslationPrompt?.trim() || ''

  const systemUsesDefaultOrEmpty =
    !pluginSystemPrompt || pluginSystemPrompt === DEFAULT_PROMPT_TRANSLATION_SYSTEM_PROMPT
  const userUsesDefaultOrEmpty =
    !pluginUserPrompt || pluginUserPrompt === DEFAULT_PROMPT_TRANSLATION_USER_PROMPT

  if (pluginLegacyPrompt && systemUsesDefaultOrEmpty && userUsesDefaultOrEmpty) {
    return resolveLegacyPromptTranslationPrompt(pluginLegacyPrompt)
  }

  if (!pluginLegacyPrompt && systemUsesDefaultOrEmpty && userUsesDefaultOrEmpty) {
    if (llmLegacyPrompt) {
      return resolveLegacyPromptTranslationPrompt(llmLegacyPrompt)
    }

    return {
      systemPrompt: DEFAULT_PROMPT_TRANSLATION_SYSTEM_PROMPT,
      userPrompt: DEFAULT_PROMPT_TRANSLATION_USER_PROMPT
    }
  }

  return {
    systemPrompt: pluginSystemPrompt,
    userPrompt: pluginUserPrompt
  }
}

const resolveImageInterrogationSystemPrompt = (config: Config): string => {
  const pluginSystemPrompt = normalizeLegacyImageInterrogationPrompt(
    config.plugin_config?.imageInterrogationSystemPrompt
  )
  const pluginLegacyPrompt = normalizeLegacyImageInterrogationPrompt(
    config.plugin_config?.imageInterrogationPrompt
  )
  const llmLegacyPrompt = normalizeLegacyImageInterrogationPrompt(
    config.llm_config.imageInterrogationPrompt
  )

  if (
    pluginLegacyPrompt &&
    (!pluginSystemPrompt || pluginSystemPrompt === DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT)
  ) {
    return pluginLegacyPrompt
  }

  return (
    pluginSystemPrompt ||
    pluginLegacyPrompt ||
    llmLegacyPrompt ||
    DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT
  )
}

export const getQAppPromptSettings = (config: Config): QAppPromptSettings => {
  const pluginConfig = config.plugin_config
  const llmConfig = config.llm_config
  const translationPrompts = resolvePromptTranslationPrompts(config)

  return {
    usePromptTranslation: pluginConfig?.usePromptTranslation ?? llmConfig.usePromptTranslation,
    promptTranslationSystemPrompt: translationPrompts.systemPrompt,
    promptTranslationUserPrompt: translationPrompts.userPrompt,
    promptTranslationProfileId:
      pluginConfig?.promptTranslationProfileId ?? llmConfig.promptTranslationProfileId,
    useImageInterrogation: pluginConfig?.useImageInterrogation ?? llmConfig.useImageInterrogation,
    imageInterrogationSystemPrompt: resolveImageInterrogationSystemPrompt(config),
    imageInterrogationUserPrompt:
      pluginConfig?.imageInterrogationUserPrompt?.trim() || DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
    imageInterrogationProfileId:
      pluginConfig?.imageInterrogationProfileId ?? llmConfig.imageInterrogationProfileId
  }
}
