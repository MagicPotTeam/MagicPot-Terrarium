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

export type AgentApiProfileCallTypeOption = {
  label: string
  value: string
}

export type AgentApiProfileCallTypeOptions = {
  baseOptions: AgentApiProfileCallTypeOption[]
  isChineseUi: boolean
  profile: LLMAPIProfile
}

export type AgentApiProfileApplyCallTypeOptions = {
  callType: string
  profile: LLMAPIProfile
}

export type AgentApiProfileUi = {
  apiKeyLabel?: string
  apiKeyPlaceholder?: string
  baseUrlPlaceholder?: string
  modelNameLabel?: string
  modelNamePlaceholder?: string
  showApiKeyInput?: boolean
  showBackupKeys?: boolean
  showBaseUrlInput?: boolean
  showKlingSecretInput?: boolean
}

export type AgentApiProfileUiOptions = {
  baseUi: AgentApiProfileUi
  isChineseUi: boolean
  profile: LLMAPIProfile
}

export type AgentApiProfileCardRenderOptions = {
  callTypeOptions: AgentApiProfileCallTypeOption[]
  isChineseUi: boolean
  onChangeCallType: (callType: string) => void
  onClone: (profile: LLMAPIProfile) => void
  onDelete: (profileId: string) => void
  onReplaceProfiles: (nextProfiles: LLMAPIProfile[]) => void
  onUpdate: (profileId: string, nextProfile: LLMAPIProfile) => void
  profile: LLMAPIProfile
  profiles: LLMAPIProfile[]
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
    applyAgentApiProfileCallType?: (
      options: AgentApiProfileApplyCallTypeOptions
    ) => LLMAPIProfile | undefined
    buildAgentApiProfileCallTypeOptions?: (
      options: AgentApiProfileCallTypeOptions
    ) => AgentApiProfileCallTypeOption[] | undefined
    resolveAgentApiProfileUi?: (options: AgentApiProfileUiOptions) => AgentApiProfileUi | undefined
    renderAgentApiProfileCardExtra?: (options: AgentApiProfileCardRenderOptions) => React.ReactNode
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
