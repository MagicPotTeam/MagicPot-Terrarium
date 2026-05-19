import type { LLMDeployment, LLMProviderOption } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'

export type LLMReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ChatCapabilityProfile = {
  model_name?: string
  auth_mode?: string
  provider?: LLMProviderOption | string
  deployment?: LLMDeployment | string
  base_url?: string
}

export type ChatProfileCapabilities = {
  reasoningEfforts: LLMReasoningEffort[]
  defaultReasoningEffort?: LLMReasoningEffort
  contextWindowTokens?: number
  contextBudgetTokens?: number
  supportsAutoContextCompression: boolean
}

const GPT_5_4_LONG_CONTEXT_TOKENS = 1_050_000
const GPT_5_5_CONTEXT_TOKENS = 258_000
const STANDARD_REASONING_CONTEXT_TOKENS = 400_000
const RESERVED_OUTPUT_AND_BUFFER_TOKENS = 148_000
const CONTEXT_BUDGET_RATIO = 0.65

const GPT_5_5_REASONING_EFFORTS: LLMReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']
const GPT_5_4_REASONING_EFFORTS: LLMReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']
const GPT_5_PRO_REASONING_EFFORTS: LLMReasoningEffort[] = ['high']
const GPT_5_4_PRO_REASONING_EFFORTS: LLMReasoningEffort[] = ['medium', 'high', 'xhigh']
const GPT_5_1_REASONING_EFFORTS: LLMReasoningEffort[] = ['none', 'low', 'medium', 'high']
const GPT_5_REASONING_EFFORTS: LLMReasoningEffort[] = ['minimal', 'low', 'medium', 'high']

const normalizeModelName = (value?: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()

const isOpenAICompatibleProfile = (profile?: ChatCapabilityProfile | null): boolean => {
  if (!profile) {
    return false
  }

  const provider = String(profile.provider || '')
    .trim()
    .toLowerCase()
  if (provider === 'openai') {
    return true
  }

  const modelName = normalizeModelName(profile.model_name)
  return modelName.startsWith('gpt-5')
}

const dedupeReasoningEfforts = (efforts: readonly LLMReasoningEffort[]): LLMReasoningEffort[] => {
  const seen = new Set<LLMReasoningEffort>()
  return efforts.filter((effort) => {
    if (seen.has(effort)) {
      return false
    }
    seen.add(effort)
    return true
  })
}

export const getReasoningEffortLabel = (effort: LLMReasoningEffort): string => {
  switch (effort) {
    case 'none':
      return '\u4e0d\u63a8\u7406'
    case 'minimal':
      return '\u6781\u4f4e'
    case 'low':
      return '\u4f4e'
    case 'medium':
      return '\u4e2d'
    case 'high':
      return '\u9ad8'
    case 'xhigh':
      return '\u8d85\u9ad8'
    default:
      return effort
  }
}

export const resolveChatProfileCapabilities = (
  profile?: ChatCapabilityProfile | null
): ChatProfileCapabilities => {
  const applyExtensions = (baseCapabilities: ChatProfileCapabilities): ChatProfileCapabilities => {
    let nextCapabilities = baseCapabilities
    for (const extension of sharedHostExtensionApiV1.llmProfiles) {
      const resolved = extension.resolveCapabilities?.(profile, nextCapabilities)
      if (resolved) {
        nextCapabilities = {
          ...nextCapabilities,
          ...resolved
        }
      }
    }
    return nextCapabilities
  }

  if (!isOpenAICompatibleProfile(profile)) {
    return applyExtensions({
      reasoningEfforts: [],
      supportsAutoContextCompression: false
    })
  }

  const modelName = normalizeModelName(profile?.model_name)
  let reasoningEfforts: LLMReasoningEffort[] = []
  let defaultReasoningEffort: LLMReasoningEffort | undefined
  let contextWindowTokens: number | undefined

  if (modelName.startsWith('gpt-5.5')) {
    reasoningEfforts = GPT_5_5_REASONING_EFFORTS
    defaultReasoningEffort = 'medium'
    contextWindowTokens = GPT_5_5_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.4-pro')) {
    reasoningEfforts = GPT_5_4_PRO_REASONING_EFFORTS
    defaultReasoningEffort = 'high'
    contextWindowTokens = GPT_5_4_LONG_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.2-pro')) {
    reasoningEfforts = GPT_5_4_PRO_REASONING_EFFORTS
    defaultReasoningEffort = 'high'
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5-pro')) {
    reasoningEfforts = GPT_5_PRO_REASONING_EFFORTS
    defaultReasoningEffort = 'high'
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.4')) {
    reasoningEfforts = GPT_5_4_REASONING_EFFORTS
    defaultReasoningEffort = 'none'
    contextWindowTokens =
      modelName.includes('-mini') || modelName.includes('-nano')
        ? STANDARD_REASONING_CONTEXT_TOKENS
        : GPT_5_4_LONG_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.2')) {
    reasoningEfforts = GPT_5_4_REASONING_EFFORTS
    defaultReasoningEffort = 'none'
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.1')) {
    reasoningEfforts = GPT_5_1_REASONING_EFFORTS
    defaultReasoningEffort = 'none'
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5')) {
    reasoningEfforts = GPT_5_REASONING_EFFORTS
    defaultReasoningEffort = 'medium'
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  }

  const normalizedEfforts = dedupeReasoningEfforts(reasoningEfforts)
  const normalizedDefaultReasoningEffort =
    normalizeReasoningEffort(defaultReasoningEffort, normalizedEfforts) ||
    normalizedEfforts[normalizedEfforts.length - 1]
  const contextBudgetTokens = contextWindowTokens
    ? Math.max(
        64_000,
        Math.min(
          Math.floor(contextWindowTokens * CONTEXT_BUDGET_RATIO),
          contextWindowTokens - RESERVED_OUTPUT_AND_BUFFER_TOKENS
        )
      )
    : undefined

  return applyExtensions({
    reasoningEfforts: normalizedEfforts,
    ...(normalizedDefaultReasoningEffort
      ? { defaultReasoningEffort: normalizedDefaultReasoningEffort }
      : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(contextBudgetTokens ? { contextBudgetTokens } : {}),
    supportsAutoContextCompression: Boolean(contextBudgetTokens)
  })
}

export const normalizeReasoningEffort = (
  effort: string | null | undefined,
  supportedEfforts?: readonly LLMReasoningEffort[]
): LLMReasoningEffort | undefined => {
  const normalized = String(effort || '')
    .trim()
    .toLowerCase()
  const candidate =
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
      ? (normalized as LLMReasoningEffort)
      : undefined

  if (!candidate) {
    return undefined
  }

  if (!supportedEfforts?.length) {
    return candidate
  }

  return supportedEfforts.includes(candidate) ? candidate : undefined
}
