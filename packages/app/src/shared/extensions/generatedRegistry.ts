import type {
  Config,
  LLMAPIProfile,
  LLMDeployment,
  LLMModelUse,
  LLMProfileCallType,
  LLMProvider
} from '@shared/config/config'
import type { ApiDefSheet } from '@shared/api/apiUtils/serviceDefSheet'
import type { FetchImpl } from '@shared/llm/clients'
import type {
  ChatCapabilityProfile,
  ChatProfileCapabilities,
  LLMCli,
  ModelCatalogOption
} from '@shared/llm'

export type ApiExtensionServices = {}

export const apiExtensionDef: ApiDefSheet<ApiExtensionServices> = {}

export type LlmProfileLikeV1 = Omit<Partial<LLMAPIProfile>, 'provider'> & {
  provider?: LLMProvider | (string & {})
}

export type SharedLlmProfileExtensionV1 = {
  id: string
  buildModelCatalog?: (options: {
    authMode?: string
    deployment: LLMDeployment
    modelUse: LLMModelUse
    provider: LLMProvider
    currentModelName?: string | null
    discoveredModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
    observedModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
  }) => ModelCatalogOption[] | undefined
  createCli?: (
    profile: LlmProfileLikeV1,
    options?: {
      fetchImpl?: FetchImpl
      imageAttachmentLoader?: (
        url: URL,
        signal?: AbortSignal
      ) => Promise<{ blob: Blob; finalUrl?: URL }>
      requireImageAttachmentLoader?: boolean
    }
  ) => LLMCli | undefined
  stripExternalAuthProfile?: (profile: LLMAPIProfile) => LLMAPIProfile | undefined
  stripProviderMetadataProfile?: (profile: LLMAPIProfile) => LLMAPIProfile | undefined
  disconnectExternalProfile?: (profile: LLMAPIProfile) => LLMAPIProfile | undefined
  isRunnableProfile?: (profile: LlmProfileLikeV1) => boolean | undefined
  isVisionCapableProfile?: (profile: LlmProfileLikeV1) => boolean | undefined
  isChatProfileDiscoveryCandidate?: (profile: LlmProfileLikeV1) => boolean | undefined
  expandChatModelProfiles?: (
    profile: LLMAPIProfile,
    discoveredModelNames: readonly string[]
  ) => LLMAPIProfile[] | undefined
  resolveChatProfileSelection?: (options: {
    availableProfiles: readonly Pick<LLMAPIProfile, 'id'>[]
    configuredProfiles: readonly (Pick<LLMAPIProfile, 'id'> & Partial<LLMAPIProfile>)[]
    profileId: string
  }) => string | null | undefined
  isQAppLlmProfileUsableInWorkflow?: (profile: LLMAPIProfile, config: Config) => boolean | undefined
  resolveQAppLlmProfileSlotValues?: (
    profile: LLMAPIProfile,
    config: Config
  ) => { modelName: string; baseUrl: string; apiKey: string; isOllama: boolean } | undefined
  resolveCapabilities?: (
    profile: ChatCapabilityProfile | null | undefined,
    baseCapabilities: ChatProfileCapabilities
  ) => Partial<ChatProfileCapabilities> | undefined
  resolveProfileCallType?: (
    profile: Pick<LLMAPIProfile, 'auth_mode' | 'call_type'>
  ) => LLMProfileCallType | undefined
  resolveProfileDeployment?: (profile: LlmProfileLikeV1) => LLMDeployment | undefined
  resolveProfileModelUse?: (profile: LlmProfileLikeV1) => LLMModelUse | undefined
  resolveProfileProvider?: (profile: LlmProfileLikeV1) => LLMProvider | undefined
  transformQAppApiProfiles?: (profiles: LLMAPIProfile[], config: Config) => LLMAPIProfile[]
}

export type SharedHostExtensionApiV1 = {
  llmProfiles: SharedLlmProfileExtensionV1[]
}

// The public checkout owns this registry. Private workspace materialization
// generates provider entries from overlay-owned sources at run time.
export const sharedHostExtensionApiV1: SharedHostExtensionApiV1 = {
  llmProfiles: []
}
