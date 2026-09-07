import type { LLMDeployment, LLMProviderOption } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'

export type LLMReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ProviderAttachmentTransport =
  'file-id' | 'multipart' | 'accessible-url' | 'request-data-url'

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
  attachment_transports?: readonly (ProviderAttachmentTransport | string)[]
  attachmentTransports?: readonly (ProviderAttachmentTransport | string)[]
  preferred_attachment_transport?: ProviderAttachmentTransport | string
  preferredAttachmentTransport?: ProviderAttachmentTransport | string
  supports_session_continuation?: boolean
  supportsSessionContinuation?: boolean
}

export type ChatProfileCapabilities = {
  reasoningEfforts: LLMReasoningEffort[]
  defaultReasoningEffort?: LLMReasoningEffort
  contextWindowTokens?: number
  contextBudgetTokens?: number
  supportsAutoContextCompression: boolean
  supportsSessionContinuation: boolean
  attachmentTransports: ProviderAttachmentTransport[]
  preferredAttachmentTransport?: ProviderAttachmentTransport
}

const GPT_5_4_LONG_CONTEXT_TOKENS = 1_050_000
const GPT_5_5_CONTEXT_TOKENS = 258_000
const STANDARD_REASONING_CONTEXT_TOKENS = 400_000
const RESERVED_OUTPUT_AND_BUFFER_TOKENS = 148_000
const CONTEXT_BUDGET_RATIO = 0.65

// These are Responses request controls, not a model support whitelist. Channels
// decide which levels they accept; model IDs (including custom aliases) are opaque.
export const getCodexReasoningCapabilities = (): Pick<
  ChatProfileCapabilities,
  'reasoningEfforts' | 'defaultReasoningEffort'
> => ({
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  // Unselected means channel default, so non-reasoning models receive no extra parameter.
  defaultReasoningEffort: undefined
})

const normalizeAttachmentTransport = (
  value?: ProviderAttachmentTransport | string | null
): ProviderAttachmentTransport | undefined => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized === 'file-id' ||
    normalized === 'multipart' ||
    normalized === 'accessible-url' ||
    normalized === 'request-data-url'
    ? normalized
    : undefined
}

const resolveAttachmentCapabilities = (
  profile?: ChatCapabilityProfile | null
): Pick<ChatProfileCapabilities, 'attachmentTransports' | 'preferredAttachmentTransport'> => {
  const declaredTransports = profile?.attachment_transports ?? profile?.attachmentTransports ?? []
  const attachmentTransports = Array.from(
    new Set(declaredTransports.map(normalizeAttachmentTransport).filter(Boolean))
  ) as ProviderAttachmentTransport[]
  const preferredAttachmentTransport = normalizeAttachmentTransport(
    profile?.preferred_attachment_transport ?? profile?.preferredAttachmentTransport
  )

  return {
    attachmentTransports,
    ...(preferredAttachmentTransport && attachmentTransports.includes(preferredAttachmentTransport)
      ? { preferredAttachmentTransport }
      : {})
  }
}

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

const resolveSessionContinuationCapability = (profile?: ChatCapabilityProfile | null): boolean =>
  profile?.supports_session_continuation === true || profile?.supportsSessionContinuation === true

const isCodexReasoningProfile = (profile?: ChatCapabilityProfile | null): boolean => {
  if (!profile) {
    return false
  }

  if (profile.auth_mode === 'codex_oauth') {
    return true
  }

  const callType = String(profile.call_type || '')
    .trim()
    .toLowerCase()
  return callType === 'codex' || callType === 'cliproxyapi'
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
  switch (normalizeReasoningEffort(effort)) {
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
    const attachmentCapabilities = resolveAttachmentCapabilities(profile)

    return applyExtensions({
      reasoningEfforts: [],
      ...explicitContextTokens,
      supportsAutoContextCompression: Boolean(explicitContextTokens.contextBudgetTokens),
      supportsSessionContinuation: resolveSessionContinuationCapability(profile),
      ...attachmentCapabilities
    })
  }

  const modelName = normalizeModelName(profile?.model_name)
  const { reasoningEfforts, defaultReasoningEffort } = getCodexReasoningCapabilities()
  let contextWindowTokens: number | undefined

  if (modelName.startsWith('gpt-5.5')) {
    contextWindowTokens = GPT_5_5_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.4-pro')) {
    contextWindowTokens = GPT_5_4_LONG_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.2-pro')) {
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5-pro')) {
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.4')) {
    contextWindowTokens =
      modelName.includes('-mini') || modelName.includes('-nano')
        ? STANDARD_REASONING_CONTEXT_TOKENS
        : GPT_5_4_LONG_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.2')) {
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5.1')) {
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  } else if (modelName.startsWith('gpt-5')) {
    contextWindowTokens = STANDARD_REASONING_CONTEXT_TOKENS
  }

  const normalizedEfforts = dedupeReasoningEfforts(reasoningEfforts)
  const normalizedDefaultReasoningEffort = normalizeReasoningEffort(
    defaultReasoningEffort,
    normalizedEfforts
  )
  const explicitContextTokens = resolveExplicitContextTokens(profile)
  const attachmentCapabilities = resolveAttachmentCapabilities(profile)
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
    supportsAutoContextCompression: Boolean(contextBudgetTokens),
    supportsSessionContinuation: resolveSessionContinuationCapability(profile),
    ...attachmentCapabilities
  })
}

export const normalizeReasoningEffort = (
  effort: string | null | undefined,
  supportedEfforts?: readonly LLMReasoningEffort[]
): LLMReasoningEffort | undefined => {
  const legacyValue = String(effort || '')
    .trim()
    .toLowerCase()
  // Migrate old preferences/requests to the canonical value; Ultra is not an option.
  const normalized = legacyValue === 'ultra' ? 'max' : legacyValue
  const candidate =
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max'
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
