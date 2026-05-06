import { Config, DEFAULT_CONFIG, type ChatConfig } from '@shared/config/config'
import { DeepPartial, deepMerge } from '@shared/utils/utilTypes'
import { Migrator } from './migrator'

type LegacyConfigWithChat = {
  chat_config?: unknown
} & Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

const toStringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const normalizeChatConfig = (value: unknown): Partial<ChatConfig> | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const normalized: Partial<ChatConfig> = {}
  if ('enable' in value) {
    normalized.enable = toBoolean(value.enable, DEFAULT_CONFIG.chat_config.enable)
  }
  if ('profile_id' in value) {
    normalized.profile_id = toStringValue(value.profile_id, DEFAULT_CONFIG.chat_config.profile_id)
  }
  if ('system_prompt' in value) {
    normalized.system_prompt = toStringValue(
      value.system_prompt,
      DEFAULT_CONFIG.chat_config.system_prompt
    )
  }
  if ('webhook_secret' in value) {
    normalized.webhook_secret = toStringValue(
      value.webhook_secret,
      DEFAULT_CONFIG.chat_config.webhook_secret
    )
  }
  if ('max_history_messages' in value) {
    normalized.max_history_messages = toNumber(
      value.max_history_messages,
      DEFAULT_CONFIG.chat_config.max_history_messages
    )
  }
  return normalized
}

export const migratorChatConfig: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    if (!isRecord(config)) {
      return config as DeepPartial<Config>
    }

    const nextConfig: LegacyConfigWithChat = { ...config }
    const chatConfig = normalizeChatConfig(nextConfig.chat_config)

    if (!chatConfig) {
      return config as DeepPartial<Config>
    }

    return {
      ...nextConfig,
      chat_config: deepMerge(DEFAULT_CONFIG.chat_config as never, chatConfig as never) as ChatConfig
    } as DeepPartial<Config>
  }
}
