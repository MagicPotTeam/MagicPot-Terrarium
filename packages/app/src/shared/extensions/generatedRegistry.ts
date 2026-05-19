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

export type LlmProfileLikeV1 = Partial<LLMAPIProfile>

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
  createCli?: (profile: LlmProfileLikeV1, options?: { fetchImpl?: FetchImpl }) => LLMCli | undefined
  isRunnableProfile?: (profile: LlmProfileLikeV1) => boolean | undefined
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

export const sharedHostExtensionApiV1: SharedHostExtensionApiV1 = {
  llmProfiles: []
}
