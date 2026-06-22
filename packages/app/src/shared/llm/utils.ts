/**
 * Shared LLM utility functions used by both main process and renderer process.
 *
 * These functions were previously duplicated in:
 *   - packages/app/src/renderer/.../api/LLM.ts (isGeminiUrl, isClaudeUrl, cliFromProfile)
 *   - packages/app/src/main/api/svcLLMProxyImpl.ts (isGeminiUrl, isClaudeUrl, cliFromProfile)
 */

import type {
  LLMDeployment,
  LLMModelUse,
  LLMModelUseOption,
  LLMProfileCallType,
  LLMProvider,
  LLMProviderOption
} from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import { LLMCli } from './types'
import {
  OpenAIAPICli,
  GeminiAPICli,
  ClaudeAPICli,
  OpencodeZenAPICli,
  OllamaAPICli,
  type FetchImpl
} from './clients'
import { KlingVideoAPICli, VolcengineSeedanceAPICli } from './videoClients'

type ProfileLike = {
  api_key?: string
  api_secret?: string
  call_type?: LLMProfileCallType
  auth_mode?: string
  base_url?: string
  codex_fast_mode?: boolean
  local_model_path?: string
  model_name?: string
  provider?: LLMProviderOption
  deployment?: LLMDeployment
  model_use?: LLMModelUseOption
  is_ollama?: boolean
  is_vision_model?: boolean
  is_ocr_model?: boolean
}

const isCodexProfile = (profile: Pick<ProfileLike, 'auth_mode' | 'call_type'>): boolean =>
  profile.auth_mode === 'codex_oauth' || profile.call_type === 'codex'

export const isCodexFastModeEnabled = (
  profile: Pick<ProfileLike, 'auth_mode' | 'call_type' | 'codex_fast_mode'>
): boolean => isCodexProfile(profile) && profile.codex_fast_mode !== false

const normalizeCallType = (callType?: string): LLMProfileCallType | undefined => {
  switch (callType) {
    case 'api':
    case 'local':
      return callType
    default:
      return undefined
  }
}

export const resolveProfileCallType = (profile: ProfileLike): LLMProfileCallType => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.resolveProfileCallType?.(profile)
    if (resolved) {
      return resolved
    }
  }

  const explicitCallType = normalizeCallType(profile.call_type)
  if (explicitCallType) {
    return explicitCallType
  }

  return 'api'
}

const looksLikeGlmOcrModel = (modelName?: string): boolean =>
  String(modelName || '')
    .trim()
    .toLowerCase()
    .includes('glm-ocr')

const looksLikeKlingVideoModel = (modelName?: string): boolean =>
  String(modelName || '')
    .trim()
    .toLowerCase()
    .startsWith('kling-')

const looksLikeVolcengineVideoModel = (modelName?: string): boolean =>
  String(modelName || '')
    .trim()
    .toLowerCase()
    .startsWith('doubao-seedance-')

const normalizeProvider = (provider?: string): LLMProvider | undefined => {
  switch (provider) {
    case 'default':
      return undefined
    case 'openai':
    case 'gemini':
    case 'claude':
    case 'ollama':
    case 'kling':
    case 'volcengine':
      return provider
    default:
      return undefined
  }
}

const normalizeDeployment = (deployment?: string): LLMDeployment | undefined => {
  switch (deployment) {
    case 'cloud':
    case 'local':
      return deployment
    default:
      return undefined
  }
}

const normalizeModelUse = (modelUse?: string): LLMModelUse | undefined => {
  switch (modelUse) {
    case 'default':
      return 'chat'
    case 'chat':
    case 'agent':
    case 'multimodal':
    case 'vision':
    case 'ocr':
    case 'image':
    case 'video':
      return modelUse
    default:
      return undefined
  }
}

const parseHttpUrl = (url: string): URL | undefined => {
  const normalized = url.trim()
  if (!normalized) {
    return undefined
  }

  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

const getBaseUrlHostname = (value: string): string | null => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null

  const parseHostname = (candidate: string): string | null => {
    try {
      return new URL(candidate).hostname.toLowerCase()
    } catch {
      return null
    }
  }

  return (
    parseHostname(normalized) ||
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? null : parseHostname(`https://${normalized}`))
  )
}

const hostnameMatchesDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`)

const urlHostnameMatchesDomain = (url: string, domains: readonly string[]): boolean => {
  const parsed = parseHttpUrl(url)
  if (!parsed) {
    return false
  }

  const hostname = parsed.hostname.toLowerCase()
  return domains.some((domain) => hostnameMatchesDomain(hostname, domain))
}

export const isGeminiUrl = (url: string): boolean => {
  const hostname = getBaseUrlHostname(url)
  return Boolean(
    hostname &&
    (hostnameMatchesDomain(hostname, 'generativelanguage.googleapis.com') ||
      hostnameMatchesDomain(hostname, 'googleapis.com'))
  )
}

export const isClaudeUrl = (url: string): boolean => {
  const parsed = parseHttpUrl(url)
  if (parsed) {
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    if (
      (hostname === 'api.kimi.com' && pathname.includes('/coding')) ||
      (hostname === 'open.bigmodel.cn' && pathname.includes('/api/anthropic'))
    ) {
      return true
    }
  }

  const hostname = getBaseUrlHostname(url)
  return Boolean(
    hostname &&
    (hostnameMatchesDomain(hostname, 'anthropic.com') ||
      hostnameMatchesDomain(hostname, 'claude.ai'))
  )
}

export const isKlingUrl = (url: string): boolean =>
  urlHostnameMatchesDomain(url, ['klingai.com', 'klingapi.com'])

export const isVolcengineUrl = (url: string): boolean => {
  const parsed = parseHttpUrl(url)
  if (parsed) {
    return parsed.pathname.toLowerCase().includes('/contents/generations/tasks')
  }

  return url.trim().toLowerCase().includes('/contents/generations/tasks')
}

const isVolcengineVideoBaseUrl = (url: string): boolean =>
  urlHostnameMatchesDomain(url, [
    'ark.cn-beijing.volces.com',
    'volcengineapi.com',
    'byteplusapi.com'
  ])

export const isOllamaUrl = (url: string): boolean => {
  const normalized = url.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (/\/api\/(?:chat|generate)\/?$/.test(normalized)) {
    return true
  }

  try {
    const parsed = new URL(normalized)
    const hostname = parsed.hostname.toLowerCase()
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')

    if (port === '11434') {
      return true
    }

    return hostname.includes('ollama')
  } catch {
    return normalized.includes('11434') || normalized.includes('ollama')
  }
}

export const isOpencodeZenUrl = (url: string): boolean => {
  const normalized = url.trim()
  if (!normalized) {
    return false
  }

  const parsed =
    parseHttpUrl(normalized) ||
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
      ? undefined
      : parseHttpUrl(`https://${normalized}`))
  if (!parsed) {
    return false
  }

  return (
    parsed.hostname.toLowerCase() === 'opencode.ai' &&
    /^\/zen(?:\/v\d+)?(?:\/|$)/i.test(parsed.pathname)
  )
}

export const isLocalBaseUrl = (url: string): boolean => {
  const normalized = url.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  try {
    const parsed = new URL(normalized)
    const hostname = parsed.hostname.toLowerCase()

    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]'
    )
  } catch {
    return (
      normalized.includes('localhost') ||
      normalized.includes('127.0.0.1') ||
      normalized.includes('0.0.0.0')
    )
  }
}

export const resolveProfileProvider = (profile: ProfileLike): LLMProvider | undefined => {
  if (resolveProfileCallType(profile) === 'local') {
    return undefined
  }

  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.resolveProfileProvider?.(profile)
    if (resolved) {
      return resolved
    }
  }

  const explicitModelUse = normalizeModelUse(profile.model_use)
  const hasExplicitModelUse =
    typeof profile.model_use === 'string' && profile.model_use.trim().length > 0
  const isExplicitNonVideoProfile = hasExplicitModelUse && explicitModelUse !== 'video'
  const isVideoProfile = explicitModelUse === 'video'

  const explicitProvider = normalizeProvider(profile.provider)
  if (explicitProvider) {
    if (
      !isExplicitNonVideoProfile ||
      (explicitProvider !== 'kling' && explicitProvider !== 'volcengine')
    ) {
      return explicitProvider
    }
  }

  if (profile.is_ollama || isOllamaUrl(profile.base_url || '')) {
    return 'ollama'
  }

  if (
    !isExplicitNonVideoProfile &&
    (isVideoProfile || looksLikeKlingVideoModel(profile.model_name)) &&
    isKlingUrl(profile.base_url || '')
  ) {
    return 'kling'
  }

  if (
    !isExplicitNonVideoProfile &&
    (isVolcengineUrl(profile.base_url || '') ||
      (isVideoProfile &&
        (looksLikeVolcengineVideoModel(profile.model_name) ||
          isVolcengineVideoBaseUrl(profile.base_url || ''))))
  ) {
    return 'volcengine'
  }

  if (isGeminiUrl(profile.base_url || '')) {
    return 'gemini'
  }

  if (isClaudeUrl(profile.base_url || '')) {
    return 'claude'
  }

  if (profile.base_url?.trim()) {
    return 'openai'
  }

  return undefined
}

export const resolveProfileDeployment = (profile: ProfileLike): LLMDeployment => {
  if (resolveProfileCallType(profile) === 'local') {
    return 'local'
  }

  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.resolveProfileDeployment?.(profile)
    if (resolved) {
      return resolved
    }
  }

  const explicitDeployment = normalizeDeployment(profile.deployment)
  if (explicitDeployment) {
    return explicitDeployment
  }

  if (
    profile.is_ollama ||
    isOllamaUrl(profile.base_url || '') ||
    isLocalBaseUrl(profile.base_url || '')
  ) {
    return 'local'
  }

  return 'cloud'
}

export const resolveProfileModelUse = (profile: ProfileLike): LLMModelUse => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.resolveProfileModelUse?.(profile)
    if (resolved) {
      return resolved
    }
  }

  const explicitModelUse = normalizeModelUse(profile.model_use)
  if (explicitModelUse) {
    return explicitModelUse
  }

  const provider = resolveProfileProvider(profile)
  if (provider === 'kling' || provider === 'volcengine') {
    return 'video'
  }

  if (profile.is_ocr_model || looksLikeGlmOcrModel(profile.model_name)) {
    return 'ocr'
  }

  if (profile.is_vision_model) {
    return 'vision'
  }

  return 'chat'
}

export const isOllamaProfile = (profile: ProfileLike): boolean =>
  resolveProfileProvider(profile) === 'ollama'

export const isRunnableProfile = (profile: ProfileLike): boolean => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.isRunnableProfile?.(profile)
    if (typeof resolved === 'boolean') {
      return resolved
    }
  }

  if (resolveProfileCallType(profile) === 'local') {
    return false
  }

  if (!profile.model_name?.trim()) {
    return false
  }

  if (!profile.base_url?.trim()) {
    return false
  }

  const provider = resolveProfileProvider(profile)
  if (provider === 'ollama') {
    return true
  }

  if (provider === 'kling') {
    return Boolean(profile.api_key?.trim() && profile.api_secret?.trim())
  }

  if (provider === 'volcengine') {
    return Boolean(profile.api_key?.trim())
  }

  if (provider === 'openai' && resolveProfileDeployment(profile) === 'local') {
    return true
  }

  return Boolean(profile.api_key?.trim())
}

/**
 * Create an LLM client from an API profile config object.
 * The profile must have at minimum: api_key, base_url, model_name.
 */
export const cliFromProfile = (
  profile: {
    api_key: string
    api_secret?: string
    auth_mode?: string
    base_url: string
    codex_fast_mode?: boolean
    model_name: string
    provider?: LLMProviderOption
    deployment?: LLMDeployment
    is_ollama?: boolean
  },
  options?: { fetchImpl?: FetchImpl }
): LLMCli | undefined => {
  if (!isRunnableProfile(profile)) {
    return undefined
  }

  const profileWithDefaults = isCodexProfile(profile)
    ? {
        ...profile,
        codex_fast_mode: isCodexFastModeEnabled(profile)
      }
    : profile

  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const cli = extension.createCli?.(profileWithDefaults, options)
    if (cli) {
      return cli
    }
  }

  if (isOpencodeZenUrl(profileWithDefaults.base_url || '')) {
    return new OpencodeZenAPICli(
      profileWithDefaults.api_key,
      profileWithDefaults.base_url,
      profileWithDefaults.model_name,
      options
    )
  }

  switch (resolveProfileProvider(profileWithDefaults)) {
    case 'ollama':
      return new OllamaAPICli(
        profile.api_key,
        profile.base_url,
        profile.model_name,
        options?.fetchImpl
      )
    case 'gemini':
      return new GeminiAPICli(
        profile.api_key,
        profile.base_url,
        profile.model_name,
        options?.fetchImpl
      )
    case 'claude':
      return new ClaudeAPICli(
        profile.api_key,
        profile.base_url,
        profile.model_name,
        options?.fetchImpl
      )
    case 'kling':
      return new KlingVideoAPICli(
        profile.api_key,
        profile.api_secret || '',
        profile.base_url,
        profile.model_name,
        options?.fetchImpl
      )
    case 'volcengine':
      return new VolcengineSeedanceAPICli(
        profile.api_key,
        profile.base_url,
        profile.model_name,
        options?.fetchImpl
      )
    case 'openai':
      return new OpenAIAPICli(profile.api_key, profile.base_url, profile.model_name, {
        modelUse: resolveProfileModelUse(profile),
        fetchImpl: options?.fetchImpl
      })
    default:
      return undefined
  }
}
