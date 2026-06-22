import type React from 'react'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type { ChatCapabilityProfile } from '@shared/llm'
import {
  rendererHostExtensionApiV1,
  type QuickAppApiProfileLists,
  type QuickAppApiProfilesSectionActionOptions
} from './generatedRegistry'

export type AssistantImageAutoSaveDirOptions = {
  config: Pick<Config, 'download_dir'>
  storageScope?: string
}

export const resolveRendererChatReasoningPreferenceKey = (
  profileId: string | null | undefined,
  profile: ChatCapabilityProfile | null | undefined,
  fallback: () => string | null
): string | null => {
  const extensionValue = rendererHostExtensionApiV1.chat?.resolveReasoningPreferenceKey?.(
    profileId,
    profile
  )
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return fallback()
}

export const resolveRendererAssistantImageAutoSaveDir = (
  options: AssistantImageAutoSaveDirOptions,
  fallback: () => string | undefined
): string | undefined => {
  const extensionValue =
    rendererHostExtensionApiV1.chat?.resolveAssistantImageAutoSaveDir?.(options)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return fallback()
}

export const buildRendererQuickAppLegacyHunyuanProfile = (
  settingsValue: Config,
  fallback: () => LLMAPIProfile | null
): LLMAPIProfile | null => {
  const extensionValue =
    rendererHostExtensionApiV1.settings?.buildQuickAppLegacyHunyuanProfile?.(settingsValue)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return fallback()
}

export const buildRendererClearedQuickAppLegacyHunyuanConfig = (
  fallback: () => NonNullable<Config['aigc3d_config']>
): NonNullable<Config['aigc3d_config']> =>
  rendererHostExtensionApiV1.settings?.buildClearedQuickAppLegacyHunyuanConfig?.() ?? fallback()

export const resolveRendererQuickAppApiProfileLists = (
  options: {
    effectivePluginProfiles: LLMAPIProfile[]
    settingsValue: Config
  },
  fallback: () => QuickAppApiProfileLists
): QuickAppApiProfileLists => {
  const extensionValue =
    rendererHostExtensionApiV1.settings?.resolveQuickAppApiProfileLists?.(options)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return fallback()
}

export const prepareRendererClonedQuickAppProfile = (
  sourceProfile: LLMAPIProfile,
  clonedProfile: LLMAPIProfile,
  fallback: () => LLMAPIProfile
): LLMAPIProfile =>
  rendererHostExtensionApiV1.settings?.prepareClonedQuickAppProfile?.(
    sourceProfile,
    clonedProfile
  ) ?? fallback()

export const getRendererQuickAppApiProfilesSectionAction = (
  options: QuickAppApiProfilesSectionActionOptions,
  fallback: () => React.ReactNode = () => null
): React.ReactNode =>
  rendererHostExtensionApiV1.settings?.getQuickAppApiProfilesSectionAction?.(options) ?? fallback()

export const isRendererQuickAppLegacyHunyuanProfile = (
  profile: LLMAPIProfile,
  fallback: () => boolean
): boolean => {
  const extensionValue =
    rendererHostExtensionApiV1.settings?.isQuickAppLegacyHunyuanProfile?.(profile)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return fallback()
}
