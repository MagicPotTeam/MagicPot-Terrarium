import type React from 'react'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import {
  getQAppApiProfiles,
  isHunyuan3DCompatibleProfile
} from '@shared/config/apiProfileSelectors'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'

const HUNYUAN_AI3D_BASE_URL = 'https://api.ai3d.cloud.tencent.com'
const DEFAULT_HY3D_COS_PREFIX = 'magicpot/hunyuan3d'
const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'
const LEGACY_HUNYUAN_PROFILE_ID = 'legacy-hunyuan3d-profile'

export const buildQuickAppLegacyHunyuanProfile = (settingsValue: Config): LLMAPIProfile | null => {
  const extensionValue =
    rendererHostExtensionApiV1.settings?.buildQuickAppLegacyHunyuanProfile?.(settingsValue)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  const legacy = settingsValue.aigc3d_config
  const legacyKeyPrefix = legacy?.cos_key_prefix?.trim() || ''
  const hasCustomKeyPrefix = Boolean(legacyKeyPrefix && legacyKeyPrefix !== DEFAULT_HY3D_COS_PREFIX)

  if (
    !legacy ||
    !(
      legacy.tencent_secret_id?.trim() ||
      legacy.tencent_secret_key?.trim() ||
      legacy.api_region?.trim() ||
      legacy.cos_bucket?.trim() ||
      legacy.cos_region?.trim() ||
      hasCustomKeyPrefix
    )
  ) {
    return null
  }

  return {
    id: LEGACY_HUNYUAN_PROFILE_ID,
    model_name: 'Hunyuan3D Pro',
    base_url: HUNYUAN_AI3D_BASE_URL,
    api_key: '',
    provider: 'default',
    model_use: 'default',
    is_ollama: false,
    is_vision_model: false,
    is_ocr_model: false,
    tencent_secret_id: legacy.tencent_secret_id || '',
    tencent_secret_key: legacy.tencent_secret_key || '',
    api_region: legacy.api_region || DEFAULT_HY3D_API_REGION,
    cos_bucket: legacy.cos_bucket || '',
    cos_region: legacy.cos_region || DEFAULT_HY3D_API_REGION,
    cos_key_prefix: legacyKeyPrefix || DEFAULT_HY3D_COS_PREFIX
  }
}

export const buildClearedQuickAppLegacyHunyuanConfig = (): NonNullable<Config['aigc3d_config']> =>
  rendererHostExtensionApiV1.settings?.buildClearedQuickAppLegacyHunyuanConfig?.() ?? {
    tencent_secret_id: '',
    tencent_secret_key: '',
    api_region: '',
    cos_bucket: '',
    cos_region: '',
    cos_key_prefix: ''
  }

export const resolveQuickAppApiProfileLists = (options: {
  effectivePluginProfiles: LLMAPIProfile[]
  settingsValue: Config
}): {
  pluginProfileCards: LLMAPIProfile[]
  qAppProfiles: LLMAPIProfile[]
} => {
  const extensionValue =
    rendererHostExtensionApiV1.settings?.resolveQuickAppApiProfileLists?.(options)
  if (extensionValue) {
    return extensionValue
  }

  const { effectivePluginProfiles, settingsValue } = options

  return {
    pluginProfileCards: effectivePluginProfiles,
    qAppProfiles:
      effectivePluginProfiles.length > 0
        ? effectivePluginProfiles
        : getQAppApiProfiles(settingsValue)
  }
}

export const prepareClonedQuickAppProfile = (
  sourceProfile: LLMAPIProfile,
  clonedProfile: LLMAPIProfile
): LLMAPIProfile =>
  rendererHostExtensionApiV1.settings?.prepareClonedQuickAppProfile?.(
    sourceProfile,
    clonedProfile
  ) ?? clonedProfile

export const getQuickAppApiProfilesSectionAction = (options: {
  effectivePluginProfiles: LLMAPIProfile[]
  isChineseUi: boolean
  savePluginProfiles: (nextProfiles: LLMAPIProfile[]) => void
}): React.ReactNode =>
  rendererHostExtensionApiV1.settings?.getQuickAppApiProfilesSectionAction?.(options) ?? null

export const isQuickAppLegacyHunyuanProfile = (profile: LLMAPIProfile): boolean =>
  rendererHostExtensionApiV1.settings?.isQuickAppLegacyHunyuanProfile?.(profile) ??
  isHunyuan3DCompatibleProfile(profile)
