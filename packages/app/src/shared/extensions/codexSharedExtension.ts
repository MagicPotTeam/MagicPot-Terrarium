import { codexAuthSvcDef } from '@shared/api/svcCodexAuth'
import { codexModelsSvcDef } from '@shared/api/svcCodexModels'
import type { SharedLlmProfileExtensionV1 } from '@shared/extensions/generatedRegistry'
import {
  buildCodexModelCatalog,
  buildCodexModelProfileId,
  type CodexModelProfileSelection,
  parseCodexModelProfileId
} from './codexModelCatalog'

const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const CODEX_GPT_5_6_CONTEXT_TOKENS = 258_000
const CODEX_GPT_5_5_CONTEXT_TOKENS = 258_000
const CODEX_GPT_5_4_CONTEXT_TOKENS = 256_000
const CODEX_GPT_5_4_CONTEXT_BUDGET_TOKENS = 204_800
const CODEX_RESERVED_OUTPUT_AND_BUFFER_TOKENS = 148_000
const CODEX_STANDARD_CONTEXT_TOKENS = 400_000
const CODEX_STANDARD_CONTEXT_BUDGET_TOKENS = 252_000
const CODEX_ATTACHMENT_TRANSPORT = 'request-data-url' as const

export const codexApiExtensionDef = {
  svcCodexAuth: codexAuthSvcDef,
  svcCodexModels: codexModelsSvcDef
}

export type CodexApiExtensionServices = {
  svcCodexAuth: import('@shared/api/svcCodexAuth').CodexAuthSvc
  svcCodexModels: import('@shared/api/svcCodexModels').CodexModelsSvc
}

const isCodexOAuthProfile = (profile: { auth_mode?: string }): boolean =>
  profile.auth_mode === 'codex_oauth'

const isCodexProfile = (profile: { auth_mode?: string; call_type?: string }): boolean =>
  isCodexOAuthProfile(profile) ||
  profile.call_type === 'codex' ||
  profile.call_type === 'cliproxyapi'

// Context sizing remains separate from user-selectable reasoning request controls.
const buildCodexContextCapabilities = (
  modelNameValue: string
):
  | Partial<Parameters<NonNullable<SharedLlmProfileExtensionV1['resolveCapabilities']>>[1]>
  | undefined => {
  const normalizedModelName = modelNameValue.trim().toLowerCase()
  if (normalizedModelName.startsWith('gpt-5.6')) {
    return {
      contextWindowTokens: CODEX_GPT_5_6_CONTEXT_TOKENS,
      contextBudgetTokens: CODEX_GPT_5_6_CONTEXT_TOKENS - CODEX_RESERVED_OUTPUT_AND_BUFFER_TOKENS,
      supportsAutoContextCompression: true
    }
  }

  if (normalizedModelName.startsWith('gpt-5.5')) {
    return {
      contextWindowTokens: CODEX_GPT_5_5_CONTEXT_TOKENS,
      contextBudgetTokens: CODEX_GPT_5_5_CONTEXT_TOKENS - CODEX_RESERVED_OUTPUT_AND_BUFFER_TOKENS,
      supportsAutoContextCompression: true
    }
  }

  if (
    normalizedModelName.startsWith('gpt-5.4') &&
    !normalizedModelName.includes('-pro') &&
    !normalizedModelName.includes('-mini') &&
    !normalizedModelName.includes('-nano')
  ) {
    return {
      contextWindowTokens: CODEX_GPT_5_4_CONTEXT_TOKENS,
      contextBudgetTokens: CODEX_GPT_5_4_CONTEXT_BUDGET_TOKENS,
      supportsAutoContextCompression: true
    }
  }

  if (normalizedModelName.startsWith('gpt-5.3-codex')) {
    return {
      contextWindowTokens: CODEX_STANDARD_CONTEXT_TOKENS,
      contextBudgetTokens: CODEX_STANDARD_CONTEXT_BUDGET_TOKENS,
      supportsAutoContextCompression: true
    }
  }

  return undefined
}

const isOfficialOpenAIBaseUrl = (url?: string): boolean => {
  const normalized = String(url || OFFICIAL_OPENAI_BASE_URL).trim()
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'https:' && parsed.hostname === 'api.openai.com'
  } catch {
    return false
  }
}

export const codexLlmProfileExtension: SharedLlmProfileExtensionV1 = {
  id: 'codex',
  buildModelCatalog(options) {
    if (options.authMode !== 'codex_oauth') {
      return undefined
    }

    return buildCodexModelCatalog({
      currentModelName: options.currentModelName,
      discoveredModelNames: options.discoveredModelNames,
      observedModelNames: options.observedModelNames
    })
  },
  isRunnableProfile(profile) {
    if (profile.call_type === 'cliproxyapi') {
      return Boolean(profile.base_url?.trim() && profile.api_key?.trim())
    }

    if (!isCodexOAuthProfile(profile)) {
      return undefined
    }

    return isOfficialOpenAIBaseUrl(profile.base_url || OFFICIAL_OPENAI_BASE_URL)
  },
  isVisionCapableProfile(profile) {
    return isCodexProfile(profile) ? true : undefined
  },
  isChatProfileDiscoveryCandidate(profile) {
    return isCodexProfile(profile) ? Boolean(profile.base_url?.trim()) : undefined
  },
  resolveChatProfileSelection({ configuredProfiles, profileId }) {
    const virtual = parseCodexModelProfileId(profileId)
    if (!virtual || !configuredProfiles.some((profile) => profile.id === virtual.profileId)) {
      return undefined
    }
    return profileId
  },
  expandChatModelProfiles(profile, discoveredModelNames) {
    if (!isCodexProfile(profile)) return undefined
    if (discoveredModelNames.length === 0) return [profile]
    const seen = new Set<string>()
    return discoveredModelNames
      .map((modelName) => modelName.trim())
      .filter((modelName) => {
        const key = modelName.toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((modelName) => ({
        ...profile,
        id: buildCodexModelProfileId(profile.id, modelName),
        model_name: modelName
      }))
  },
  resolveCapabilities(profile, baseCapabilities) {
    if (!profile || !isCodexProfile(profile)) {
      return undefined
    }

    const modelCapabilities = buildCodexContextCapabilities(String(profile.model_name || ''))
    return {
      ...baseCapabilities,
      ...modelCapabilities,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: undefined,
      attachmentTransports: Array.from(
        new Set([...baseCapabilities.attachmentTransports, CODEX_ATTACHMENT_TRANSPORT])
      )
    }
  },
  isQAppLlmProfileUsableInWorkflow(profile, config) {
    return isCodexProfile(profile) ? config.local_llm_server_config?.enable_server !== false : undefined
  },
  resolveQAppLlmProfileSlotValues(profile, config) {
    if (!isCodexProfile(profile)) return undefined
    const port = config.local_llm_server_config?.port || 3721
    const tokenEntry = config.local_llm_server_config?.access_tokens?.find((entry) => entry.token?.trim())
    return {
      modelName: profile.id,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: tokenEntry?.token?.trim() || config.local_llm_server_config?.access_token?.trim() || '',
      isOllama: false
    }
  },
  resolveProfileCallType(profile) {
    if (profile.call_type === 'cliproxyapi') {
      return 'cliproxyapi'
    }
    return isCodexProfile(profile) ? 'codex' : undefined
  },
  resolveProfileDeployment(profile) {
    return isCodexProfile(profile) ? 'cloud' : undefined
  },
  resolveProfileProvider(profile) {
    return isCodexProfile(profile) ? 'openai' : undefined
  }
}

export { buildCodexModelProfileId, parseCodexModelProfileId }
export type { CodexModelProfileSelection }
