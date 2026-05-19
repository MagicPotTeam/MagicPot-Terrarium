import type React from 'react'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type { ChatCapabilityProfile } from '@shared/llm'

export type QuickAppApiProfileLists = {
  pluginProfileCards: LLMAPIProfile[]
  qAppProfiles: LLMAPIProfile[]
}

export type QuickAppApiProfilesSectionActionOptions = {
  effectivePluginProfiles: LLMAPIProfile[]
  isChineseUi: boolean
  savePluginProfiles: (nextProfiles: LLMAPIProfile[]) => void
}

export type RendererHostExtensionApiV1 = {
  chat?: {
    resolveAssistantImageAutoSaveDir?: (options: {
      config: Pick<Config, 'download_dir'>
      storageScope?: string
    }) => string | undefined
    resolveReasoningPreferenceKey?: (
      profileId: string | null | undefined,
      profile?: ChatCapabilityProfile | null
    ) => string | null | undefined
  }
  settings?: {
    buildQuickAppLegacyHunyuanProfile?: (settingsValue: Config) => LLMAPIProfile | null
    buildClearedQuickAppLegacyHunyuanConfig?: () => NonNullable<Config['aigc3d_config']>
    getQuickAppApiProfilesSectionAction?: (
      options: QuickAppApiProfilesSectionActionOptions
    ) => React.ReactNode
    isQuickAppLegacyHunyuanProfile?: (profile: LLMAPIProfile) => boolean
    prepareClonedQuickAppProfile?: (
      sourceProfile: LLMAPIProfile,
      clonedProfile: LLMAPIProfile
    ) => LLMAPIProfile
    resolveQuickAppApiProfileLists?: (options: {
      effectivePluginProfiles: LLMAPIProfile[]
      settingsValue: Config
    }) => QuickAppApiProfileLists
  }
}

export const rendererHostExtensionApiV1: RendererHostExtensionApiV1 = {}
