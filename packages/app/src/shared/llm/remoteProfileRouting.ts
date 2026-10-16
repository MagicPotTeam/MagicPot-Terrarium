import type { LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import type { LLMAPIProfile, LLMOpenAIApiMode } from '@shared/config/config'
import { resolveOpenAIClientApiMode } from './clients'
import { resolveOpencodeZenAlias, resolveOpencodeZenModelApi } from './opencodeZenModels'
import {
  isOpencodeZenUrl,
  resolveProfileCallType,
  resolveProfileModelUse,
  resolveProfileProvider
} from './utils'

type RemoteProfileRouting = Pick<
  LLMListProfilesResp['profiles'][number],
  'provider' | 'api_mode' | 'openai_api_modes' | 'call_type' | 'auth_mode'
>

const resolveOpenAIRouting = (
  resolveMode: (apiMode?: LLMOpenAIApiMode) => Exclude<LLMOpenAIApiMode, 'auto'>
): RemoteProfileRouting => {
  const api_mode = resolveMode()
  return {
    provider: 'openai',
    api_mode,
    openai_api_modes: {
      default: api_mode,
      auto: resolveMode('auto'),
      responses: resolveMode('responses'),
      'chat-completions': resolveMode('chat-completions'),
      images: resolveMode('images')
    }
  }
}

/**
 * Publish routing decisions, never the config used to make them. No clients or I/O.
 * Extensions that create clients without a routing discriminator remain responsible
 * for their discovery metadata; this only describes standard API dispatch.
 */
export const resolveRemoteProfileRouting = (
  profile: Partial<LLMAPIProfile>
): RemoteProfileRouting => {
  const resolvedCallType = resolveProfileCallType(profile)
  // An uninstalled extension can leave its discriminator in config. Do not turn
  // that residual route into a claim about standard API policy.
  const call_type =
    resolvedCallType === 'api' && profile.call_type && profile.call_type !== 'api'
      ? profile.call_type
      : resolvedCallType
  const auth_mode = profile.auth_mode
  const routing: RemoteProfileRouting = { call_type }
  if (auth_mode && auth_mode !== 'api_key') {
    return { ...routing, auth_mode }
  }
  if (call_type !== 'api') return routing

  // Zen dispatch precedes provider selection and ignores api_mode/model_use.
  // Use the same alias/protocol resolver as OpencodeZenAPICli, not model guessing.
  if (isOpencodeZenUrl(profile.base_url || '')) {
    switch (resolveOpencodeZenModelApi(resolveOpencodeZenAlias(profile.model_name || ''))) {
      case 'openai-responses':
        return { ...routing, ...resolveOpenAIRouting(() => 'responses') }
      case 'anthropic-messages':
        return { ...routing, provider: 'claude' }
      case 'google-generative-ai':
        return { ...routing, provider: 'gemini' }
      case 'openai-completions':
        return { ...routing, ...resolveOpenAIRouting(() => 'chat-completions') }
    }
  }

  const provider = resolveProfileProvider(profile)
  if (!provider) return routing
  if (provider !== 'openai') return { ...routing, provider }
  return {
    ...routing,
    ...resolveOpenAIRouting((apiMode) => {
      // Overrides can change inferred model use (notably Images -> auto).
      const effectiveProfile = apiMode ? { ...profile, api_mode: apiMode } : profile
      return resolveOpenAIClientApiMode(profile.base_url || '', profile.model_name || '', {
        apiMode: effectiveProfile.api_mode,
        modelUse: resolveProfileModelUse(effectiveProfile)
      })
    })
  }
}
