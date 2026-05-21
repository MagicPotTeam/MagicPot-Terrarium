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
import { OpenAIAPICli, GeminiAPICli, ClaudeAPICli, OllamaAPICli, type FetchImpl } from './clients'

type ProfileLike = {
  api_key?: string
  call_type?: LLMProfileCallType
  auth_mode?: string
  base_url?: string
  local_model_path?: string
  model_name?: string
  provider?: LLMProviderOption
  deployment?: LLMDeployment
  model_use?: LLMModelUseOption
  is_ollama?: boolean
  is_vision_model?: boolean
  is_ocr_model?: boolean
}

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

const normalizeProvider = (provider?: string): LLMProvider | undefined => {
  switch (provider) {
    case 'default':
      return undefined
    case 'openai':
    case 'gemini':
    case 'claude':
    case 'ollama':
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
      return modelUse
    default:
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

export const isGeminiUrl = (url: string): boolean => {
  const hostname = getBaseUrlHostname(url)
  return Boolean(
    hostname &&
    (hostnameMatchesDomain(hostname, 'generativelanguage.googleapis.com') ||
      hostnameMatchesDomain(hostname, 'googleapis.com'))
  )
}

export const isClaudeUrl = (url: string): boolean => {
  const hostname = getBaseUrlHostname(url)
  return Boolean(
    hostname &&
    (hostnameMatchesDomain(hostname, 'anthropic.com') ||
      hostnameMatchesDomain(hostname, 'claude.ai'))
  )
}

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

  const explicitProvider = normalizeProvider(profile.provider)
  if (explicitProvider) {
    return explicitProvider
  }

  if (profile.is_ollama || isOllamaUrl(profile.base_url || '')) {
    return 'ollama'
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

  if (resolveProfileProvider(profile) === 'ollama') {
    return true
  }

  if (
    resolveProfileProvider(profile) === 'openai' &&
    resolveProfileDeployment(profile) === 'local'
  ) {
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

  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const cli = extension.createCli?.(profile, options)
    if (cli) {
      return cli
    }
  }

  switch (resolveProfileProvider(profile)) {
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
    case 'openai':
    default:
      return new OpenAIAPICli(profile.api_key, profile.base_url, profile.model_name, {
        modelUse: resolveProfileModelUse(profile),
        fetchImpl: options?.fetchImpl
      })
  }
}
