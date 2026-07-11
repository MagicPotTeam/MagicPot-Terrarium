import type { LLMDeployment, LLMProviderOption } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'

export type LLMReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export type ChatCapabilityProfile = {
  model_name?: string
  auth_mode?: string
  call_type?: string
  provider?: LLMProviderOption | string
  deployment?: LLMDeployment | string
  base_url?: string
  context_window_tokens?: number
  context_budget_tokens?: number
  contextWindowTokens?: number
  contextBudgetTokens?: number
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

const normalizePositiveFiniteTokenCount = (value?: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

const deriveContextBudgetTokens = (
  contextWindowTokens: number | undefined,
  explicitBudgetTokens?: number
): number | undefined => {
  if (explicitBudgetTokens) {
    return contextWindowTokens
      ? Math.min(explicitBudgetTokens, contextWindowTokens)
      : explicitBudgetTokens
  }

  if (!contextWindowTokens) {
    return undefined
  }

  return Math.max(
    64_000,
    Math.min(
      Math.floor(contextWindowTokens * CONTEXT_BUDGET_RATIO),
      Math.max(1, contextWindowTokens - RESERVED_OUTPUT_AND_BUFFER_TOKENS)
    )
  )
}

const resolveExplicitContextTokens = (
  profile?: ChatCapabilityProfile | null
): Pick<ChatProfileCapabilities, 'contextWindowTokens' | 'contextBudgetTokens'> => {
  const contextWindowTokens = normalizePositiveFiniteTokenCount(
    profile?.context_window_tokens ?? profile?.contextWindowTokens
  )
  const explicitContextBudgetTokens = normalizePositiveFiniteTokenCount(
    profile?.context_budget_tokens ?? profile?.contextBudgetTokens
  )
  const contextBudgetTokens = deriveContextBudgetTokens(
    contextWindowTokens,
    explicitContextBudgetTokens
  )

  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(contextBudgetTokens ? { contextBudgetTokens } : {})
  }
}

const isCodexReasoningProfile = (profile?: ChatCapabilityProfile | null): boolean => {
  if (!profile) {
    return false
  }

  if (profile.auth_mode === 'codex_oauth') {
    return true
  }

  return (
    String(profile.call_type || '')
      .trim()
      .toLowerCase() === 'codex'
  )
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
      return 'None'
    case 'minimal':
      return 'Minimal'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
      return 'X-High'
    case 'max':
      return 'Max'
    case 'ultra':
      return 'Ultra'
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

  if (!isCodexReasoningProfile(profile)) {
    const explicitContextTokens = resolveExplicitContextTokens(profile)

    return applyExtensions({
      reasoningEfforts: [],
      ...explicitContextTokens,
      supportsAutoContextCompression: Boolean(explicitContextTokens.contextBudgetTokens)
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
  const explicitContextTokens = resolveExplicitContextTokens(profile)
  const resolvedContextWindowTokens =
    explicitContextTokens.contextWindowTokens || contextWindowTokens
  const contextBudgetTokens = deriveContextBudgetTokens(
    resolvedContextWindowTokens,
    explicitContextTokens.contextBudgetTokens
  )

  return applyExtensions({
    reasoningEfforts: normalizedEfforts,
    ...(normalizedDefaultReasoningEffort
      ? { defaultReasoningEffort: normalizedDefaultReasoningEffort }
      : {}),
    ...(resolvedContextWindowTokens ? { contextWindowTokens: resolvedContextWindowTokens } : {}),
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
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
      ? (normalized as LLMReasoningEffort)
      : undefined

  if (!candidate) {
    return undefined
  }

  if (supportedEfforts) {
    return supportedEfforts.includes(candidate) ? candidate : undefined
  }

  return candidate
}
