import {
  Config,
  DEFAULT_IMAGE_INTERROGATION_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
} from '@shared/config/config'
import { DeepPartial } from '@shared/utils/utilTypes'
import { Migrator } from './migrator'

type LegacyConfig = {
  llm_config?: {
    imageInterrogationPrompt?: unknown
  } | null
  plugin_config?: {
    imageInterrogationPrompt?: unknown
    imageInterrogationSystemPrompt?: unknown
    imageInterrogationUserPrompt?: unknown
  } | null
} & Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toStringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const normalizeLegacySystemPrompt = (value: unknown): string => {
  const trimmedValue = toStringValue(value).trim()
  if (!trimmedValue || trimmedValue === DEFAULT_IMAGE_INTERROGATION_PROMPT) {
    return ''
  }
  return trimmedValue
}

export const migratorQAppImageInterrogationPrompt: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    if (!isRecord(config)) {
      return config as DeepPartial<Config>
    }

    const nextConfig = config as LegacyConfig
    const pluginConfig = isRecord(nextConfig.plugin_config) ? nextConfig.plugin_config : {}
    const hasUserPrompt = Object.prototype.hasOwnProperty.call(
      pluginConfig,
      'imageInterrogationUserPrompt'
    )

    const llmConfig = isRecord(nextConfig.llm_config) ? nextConfig.llm_config : {}
    const legacySystemPrompt =
      normalizeLegacySystemPrompt(pluginConfig.imageInterrogationSystemPrompt) ||
      normalizeLegacySystemPrompt(pluginConfig.imageInterrogationPrompt) ||
      normalizeLegacySystemPrompt(llmConfig.imageInterrogationPrompt) ||
      DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT
    const normalizedUserPrompt =
      toStringValue(pluginConfig.imageInterrogationUserPrompt).trim() ||
      DEFAULT_IMAGE_INTERROGATION_USER_PROMPT

    return {
      ...nextConfig,
      plugin_config: {
        ...pluginConfig,
        imageInterrogationSystemPrompt: legacySystemPrompt,
        ...(hasUserPrompt
          ? { imageInterrogationUserPrompt: normalizedUserPrompt }
          : { imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT })
      }
    } as DeepPartial<Config>
  }
}
