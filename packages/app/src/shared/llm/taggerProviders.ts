import type {
  LLMAPIProfile,
  TaggerProviderId,
  TaggerProviderOption,
  TaggerRuntimeCacheScope,
  TaggerRuntimeCacheScopeOption
} from '@shared/config/config'
import type { LLMChatSkillRuntime } from '@shared/api/svcLLMProxy'
import { resolveProfileModelUse } from './utils'

export type TaggerProviderFamily = 'tagger' | 'ocr' | 'vlm' | 'caption'

export type TaggerProviderDescriptor = {
  id: TaggerProviderId
  name: string
  family: TaggerProviderFamily
  description: string
  preferredOutputMode: 'structured' | 'sidecar'
  defaultCacheScope: TaggerRuntimeCacheScope
  endpointPath: string
  supportsStructuredOutput: boolean
  supportsSidecarOutput: boolean
}

export type TaggerRuntimeDescriptor = {
  providerId: TaggerProviderId
  providerName: string
  family: TaggerProviderFamily
  profileId?: string
  modelName?: string
  endpoint: string
  cacheScope: TaggerRuntimeCacheScope
  cacheKey: string
  skillId?: string
  outputMode: 'structured' | 'sidecar'
}

const TAGGER_PROVIDER_REGISTRY: Record<TaggerProviderId, TaggerProviderDescriptor> = {
  wdtagger: {
    id: 'wdtagger',
    name: 'WDTagger',
    family: 'tagger',
    description: 'Local WD14-style tagger provider for concise tag sidecars and dataset labels.',
    preferredOutputMode: 'sidecar',
    defaultCacheScope: 'profile',
    endpointPath: '/tagger/v2/infer',
    supportsStructuredOutput: true,
    supportsSidecarOutput: true
  },
  cl_tagger: {
    id: 'cl_tagger',
    name: 'CL_tagger',
    family: 'tagger',
    description:
      'Local CL EVA02 tagger provider with broad tag coverage and structured canvas exports.',
    preferredOutputMode: 'structured',
    defaultCacheScope: 'profile',
    endpointPath: '/tagger/v2/infer',
    supportsStructuredOutput: true,
    supportsSidecarOutput: true
  },
  paddle_ocr: {
    id: 'paddle_ocr',
    name: 'Paddle OCR',
    family: 'ocr',
    description:
      'qinglong-captions OCR provider for extracting document text while preserving MagicPot response compatibility.',
    preferredOutputMode: 'structured',
    defaultCacheScope: 'profile',
    endpointPath: '/tagger/v2/infer',
    supportsStructuredOutput: true,
    supportsSidecarOutput: false
  }
}

const runtimeCache = new Map<string, TaggerRuntimeDescriptor>()

const normalizeText = (value: unknown): string => String(value ?? '').trim()

const normalizeTaggerProviderId = (
  value?: TaggerProviderOption | string
): TaggerProviderId | null => {
  switch (value) {
    case 'wdtagger':
    case 'cl_tagger':
    case 'paddle_ocr':
      return value
    default:
      return null
  }
}

const normalizeTaggerCacheScope = (
  value?: TaggerRuntimeCacheScopeOption | string
): TaggerRuntimeCacheScope => {
  switch (value) {
    case 'provider':
    case 'endpoint':
    case 'profile':
      return value
    default:
      return 'profile'
  }
}

const inferTaggerProviderIdFromModelName = (modelName?: string): TaggerProviderId | null => {
  const normalized = normalizeText(modelName).toLowerCase()
  if (!normalized) return null

  if (
    normalized.includes('cl_tagger') ||
    normalized.includes('cl tagger') ||
    normalized.includes('cella110n/cl_tagger')
  ) {
    return 'cl_tagger'
  }

  if (
    normalized.includes('wdtagger') ||
    normalized.includes('wd14') ||
    normalized.includes('moat-tagger') ||
    normalized.includes('smilingwolf')
  ) {
    return 'wdtagger'
  }

  if (
    normalized.includes('paddleocr') ||
    normalized.includes('paddle_ocr') ||
    normalized.includes('paddle ocr')
  ) {
    return 'paddle_ocr'
  }

  return null
}

export const listTaggerProviders = (): TaggerProviderDescriptor[] =>
  Object.values(TAGGER_PROVIDER_REGISTRY)

export const getTaggerProviderDescriptor = (
  providerId?: TaggerProviderOption | string | null
): TaggerProviderDescriptor | null => {
  const normalized = normalizeTaggerProviderId(providerId || undefined)
  return normalized ? TAGGER_PROVIDER_REGISTRY[normalized] : null
}

export const resolveTaggerProviderId = (
  profile: Pick<LLMAPIProfile, 'model_name' | 'tagger_provider'>
): TaggerProviderId | null => {
  const explicit = normalizeTaggerProviderId(profile.tagger_provider)
  if (explicit) return explicit

  return inferTaggerProviderIdFromModelName(profile.model_name)
}

export const resolveTaggerProviderDescriptor = (
  profile: Pick<LLMAPIProfile, 'model_name' | 'tagger_provider'>
): TaggerProviderDescriptor | null => {
  const providerId = resolveTaggerProviderId(profile)
  return providerId ? TAGGER_PROVIDER_REGISTRY[providerId] : null
}

export const resolveTaggerEndpoint = (
  profile: Pick<LLMAPIProfile, 'base_url' | 'tagger_endpoint'>
): string | null => {
  const endpoint = normalizeText(profile.tagger_endpoint || profile.base_url)
  return endpoint ? endpoint.replace(/\/$/, '') : null
}

export const resolveTaggerCacheScope = (
  profile: Pick<LLMAPIProfile, 'tagger_runtime_cache_scope'>
): TaggerRuntimeCacheScope => normalizeTaggerCacheScope(profile.tagger_runtime_cache_scope)

export const buildTaggerRuntimeCacheKey = (options: {
  profileId?: string
  providerId: TaggerProviderId
  endpoint: string
  modelName?: string
  cacheScope: TaggerRuntimeCacheScope
  skillId?: string
  outputMode: 'structured' | 'sidecar'
}): string => {
  const endpointKey = options.endpoint.trim().toLowerCase()
  const modelKey = normalizeText(options.modelName).toLowerCase()
  const skillKey = normalizeText(options.skillId).toLowerCase()

  switch (options.cacheScope) {
    case 'provider':
      return [options.providerId, endpointKey, options.outputMode].join('|')
    case 'endpoint':
      return [endpointKey, modelKey, options.outputMode].join('|')
    case 'profile':
    default:
      return [
        options.profileId || 'default',
        options.providerId,
        endpointKey,
        skillKey,
        options.outputMode
      ].join('|')
  }
}

export const resolveTaggerRuntimeDescriptor = (
  profile: Pick<
    LLMAPIProfile,
    | 'id'
    | 'model_name'
    | 'base_url'
    | 'tagger_provider'
    | 'tagger_endpoint'
    | 'tagger_runtime_cache_scope'
  >,
  skillRuntime?: LLMChatSkillRuntime
): TaggerRuntimeDescriptor | null => {
  const providerId = resolveTaggerProviderId(profile)
  if (!providerId) return null

  const descriptor = TAGGER_PROVIDER_REGISTRY[providerId]
  const endpoint = resolveTaggerEndpoint(profile)
  if (!endpoint) return null

  const outputMode =
    skillRuntime?.execution?.outputMode === 'structured' && descriptor.supportsStructuredOutput
      ? 'structured'
      : skillRuntime?.execution?.outputMode === 'sidecar' && descriptor.supportsSidecarOutput
        ? 'sidecar'
        : descriptor.preferredOutputMode

  const cacheScope = resolveTaggerCacheScope(profile)
  const cacheKey = buildTaggerRuntimeCacheKey({
    profileId: profile.id,
    providerId,
    endpoint,
    modelName: profile.model_name,
    cacheScope,
    skillId: skillRuntime?.skillId,
    outputMode
  })

  const cached = runtimeCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const runtime: TaggerRuntimeDescriptor = {
    providerId,
    providerName: descriptor.name,
    family: descriptor.family,
    profileId: profile.id,
    modelName: profile.model_name,
    endpoint,
    cacheScope,
    cacheKey,
    skillId: skillRuntime?.skillId,
    outputMode
  }

  runtimeCache.set(cacheKey, runtime)
  return runtime
}

export const clearTaggerRuntimeCache = (cacheKey?: string): void => {
  if (!cacheKey) {
    runtimeCache.clear()
    return
  }

  runtimeCache.delete(cacheKey)
}

export const isTaggerSkillRuntime = (skillRuntime?: LLMChatSkillRuntime): boolean =>
  skillRuntime?.skillId === 'builtin-tagging'

export const isTaggerProviderEnabledProfile = (
  profile: Pick<LLMAPIProfile, 'model_name' | 'tagger_provider'>
): boolean => Boolean(resolveTaggerProviderId(profile))

export const getTaggerProviderDisplayLabel = (
  profile: Pick<LLMAPIProfile, 'model_name' | 'tagger_provider'>
): string | null => {
  const descriptor = resolveTaggerProviderDescriptor(profile)
  return descriptor ? descriptor.name : null
}

export const resolveTaggerProviderFamily = (
  profile: Pick<LLMAPIProfile, 'model_name' | 'tagger_provider' | 'model_use'>
): TaggerProviderFamily | null => {
  const providerId = resolveTaggerProviderId(
    profile as Pick<LLMAPIProfile, 'model_name' | 'tagger_provider'>
  )
  if (providerId) {
    return TAGGER_PROVIDER_REGISTRY[providerId].family
  }

  const modelUse = resolveProfileModelUse(profile)
  if (modelUse === 'ocr') return 'ocr'
  if (modelUse === 'agent' || modelUse === 'vision' || modelUse === 'multimodal') {
    return 'vlm'
  }
  return null
}
