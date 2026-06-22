import {
  Config,
  DEFAULT_CONFIG,
  type LLMAPIProfile,
  type LLMProxyAccessTokenEntry
} from '@shared/config/config'
import { DeepPartial } from '@shared/utils/utilTypes'
import iconv from 'iconv-lite'
import { Migrator } from './migrator'

type LegacyLLMApiConfig = {
  model_name?: unknown
  base_url?: unknown
  api_key?: unknown
}

type LegacyConfigWithLLM = {
  llm_api_config?: LegacyLLMApiConfig
  llm_config?: {
    api_profiles?: unknown
  } & Record<string, unknown>
  plugin_config?: {
    api_profiles?: unknown
    light_adjustment_prompt?: unknown
    usePromptTranslation?: unknown
    promptTranslationPrompt?: unknown
    promptTranslationProfileId?: unknown
    useImageInterrogation?: unknown
    imageInterrogationPrompt?: unknown
    imageInterrogationProfileId?: unknown
  } | null
  use_remote_llm?: unknown
  local_llm_server_config?: {
    enable_server?: unknown
    port?: unknown
    access_token?: unknown
    access_tokens?: unknown
  } | null
  remote_llm_server_config?: {
    server_origin?: unknown
    access_token?: unknown
  } | null
} & Record<string, unknown>

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return fallback
}

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const toStringValue = (value: unknown, fallback = ''): string => {
  return typeof value === 'string' ? value : fallback
}

const canonicalProxyLabelPattern = /^(?:用户|User)\s*\d+$/u
const readableProxyLabelPattern = /^[\p{Script=Han}A-Za-z0-9 _-]+$/u

const repairPotentialGbkMojibake = (value: string): string => {
  try {
    const repaired = iconv.decode(iconv.encode(value, 'gbk'), 'utf8').trim()
    return repaired || value
  } catch {
    return value
  }
}

const normalizeAccessTokenLabel = (value: unknown, index: number): string => {
  const fallback = `User ${index + 1}`
  const raw = toStringValue(value, fallback).trim() || fallback
  if (canonicalProxyLabelPattern.test(raw)) {
    return raw
  }

  const repaired = repairPotentialGbkMojibake(raw)
  if (canonicalProxyLabelPattern.test(repaired)) {
    return repaired
  }

  return readableProxyLabelPattern.test(raw) ? raw : fallback
}

const toAccessTokens = (value: unknown): LLMProxyAccessTokenEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map<LLMProxyAccessTokenEntry | null>((entry, index) => {
      if (!isRecord(entry)) {
        return null
      }

      const token = toStringValue(entry.token).trim()
      if (!token) {
        return null
      }

      const resourceScope = toStringValue(entry.resource_scope).trim()

      return {
        id: toStringValue(entry.id, `proxy-token-${index + 1}`) || `proxy-token-${index + 1}`,
        label: normalizeAccessTokenLabel(entry.label, index),
        token,
        ...(resourceScope ? { resource_scope: resourceScope } : {})
      }
    })
    .filter((entry): entry is LLMProxyAccessTokenEntry => entry !== null)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasLegacyLLMConfig = (config: unknown): config is LegacyConfigWithLLM => {
  if (!isRecord(config)) return false
  return (
    'llm_api_config' in config ||
    'use_remote_llm' in config ||
    'local_llm_server_config' in config ||
    'remote_llm_server_config' in config
  )
}

function buildLegacyProfile(legacy: LegacyLLMApiConfig): LLMAPIProfile[] {
  const modelName = toStringValue(legacy.model_name)
  const baseUrl = toStringValue(legacy.base_url)
  const apiKey = toStringValue(legacy.api_key)

  if (!modelName && !baseUrl && !apiKey) {
    return []
  }

  return [
    {
      id: crypto.randomUUID(),
      model_name: modelName,
      base_url: baseUrl,
      api_key: apiKey,
      is_ollama: false
    }
  ]
}

export const migratorLegacyLLM: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    if (!hasLegacyLLMConfig(config)) {
      return config as DeepPartial<Config>
    }

    const nextConfig: LegacyConfigWithLLM = { ...config }
    const existingProfiles = Array.isArray(nextConfig.llm_config?.api_profiles)
      ? (nextConfig.llm_config?.api_profiles as LLMAPIProfile[])
      : null
    const legacyProfiles = isRecord(nextConfig.llm_api_config)
      ? buildLegacyProfile(nextConfig.llm_api_config)
      : []

    const mergedProfiles =
      existingProfiles && existingProfiles.length > 0 ? existingProfiles : legacyProfiles

    delete nextConfig.llm_api_config
    const defaultPluginConfig = DEFAULT_CONFIG.plugin_config!
    const hasExplicitPluginApiProfiles =
      isRecord(nextConfig.plugin_config) && 'api_profiles' in nextConfig.plugin_config
    const pluginApiProfiles = Array.isArray(nextConfig.plugin_config?.api_profiles)
      ? (nextConfig.plugin_config?.api_profiles as LLMAPIProfile[])
      : hasExplicitPluginApiProfiles
        ? defaultPluginConfig.api_profiles
        : mergedProfiles

    const migratedLocalAccessTokens = toAccessTokens(
      nextConfig.local_llm_server_config?.access_tokens
    )
    const migratedLegacyAccessToken = toStringValue(
      nextConfig.local_llm_server_config?.access_token
    ).trim()
    const localAccessTokens =
      migratedLocalAccessTokens.length > 0
        ? migratedLocalAccessTokens
        : migratedLegacyAccessToken
          ? [
              {
                id: 'default',
                label: 'Default',
                token: migratedLegacyAccessToken,
                resource_scope: 'default'
              }
            ]
          : DEFAULT_CONFIG.local_llm_server_config.access_tokens

    return {
      ...nextConfig,
      use_remote_llm: toBoolean(nextConfig.use_remote_llm, DEFAULT_CONFIG.use_remote_llm),
      local_llm_server_config: {
        enable_server: toBoolean(
          nextConfig.local_llm_server_config?.enable_server,
          DEFAULT_CONFIG.local_llm_server_config.enable_server
        ),
        port: toNumber(
          nextConfig.local_llm_server_config?.port,
          DEFAULT_CONFIG.local_llm_server_config.port
        ),
        access_token: migratedLegacyAccessToken,
        access_tokens: localAccessTokens
      },
      remote_llm_server_config: {
        server_origin: toStringValue(
          nextConfig.remote_llm_server_config?.server_origin,
          DEFAULT_CONFIG.remote_llm_server_config.server_origin
        ),
        access_token: toStringValue(
          nextConfig.remote_llm_server_config?.access_token,
          DEFAULT_CONFIG.remote_llm_server_config.access_token
        )
      },
      plugin_config: {
        ...(isRecord(nextConfig.plugin_config) ? nextConfig.plugin_config : {}),
        api_profiles: pluginApiProfiles,
        light_adjustment_prompt: toStringValue(
          nextConfig.plugin_config?.light_adjustment_prompt,
          defaultPluginConfig.light_adjustment_prompt
        ),
        usePromptTranslation: toBoolean(
          nextConfig.plugin_config?.usePromptTranslation,
          toBoolean(
            nextConfig.llm_config?.usePromptTranslation,
            defaultPluginConfig.usePromptTranslation ?? true
          )
        ),
        promptTranslationPrompt: toStringValue(
          nextConfig.plugin_config?.promptTranslationPrompt,
          toStringValue(
            nextConfig.llm_config?.promptTranslationPrompt,
            defaultPluginConfig.promptTranslationPrompt
          )
        ),
        promptTranslationProfileId: toStringValue(
          nextConfig.plugin_config?.promptTranslationProfileId,
          toStringValue(nextConfig.llm_config?.promptTranslationProfileId)
        ),
        useImageInterrogation: toBoolean(
          nextConfig.plugin_config?.useImageInterrogation,
          toBoolean(
            nextConfig.llm_config?.useImageInterrogation,
            defaultPluginConfig.useImageInterrogation ?? true
          )
        ),
        imageInterrogationPrompt: toStringValue(
          nextConfig.plugin_config?.imageInterrogationPrompt,
          toStringValue(
            nextConfig.llm_config?.imageInterrogationPrompt,
            defaultPluginConfig.imageInterrogationPrompt
          )
        ),
        imageInterrogationProfileId: toStringValue(
          nextConfig.plugin_config?.imageInterrogationProfileId,
          toStringValue(nextConfig.llm_config?.imageInterrogationProfileId)
        )
      },
      llm_config: {
        ...nextConfig.llm_config,
        api_profiles: mergedProfiles
      }
    } as DeepPartial<Config>
  }
}
