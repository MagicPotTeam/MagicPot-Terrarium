import type { Config, LLMAPIProfile } from '@shared/config/config'
import { getBaseProfileId, HUNYUAN_3D_PROFILE_ID } from '@renderer/pages/ChatPage/chatPageShared'
import { isRunnableProfile } from '@shared/llm'

export const DEFAULT_REMOTE_LLM_SERVER_ORIGIN = 'http://localhost:3721'

const isConfiguredLocalProfile = (profile: LLMAPIProfile): boolean => isRunnableProfile(profile)

export const getRemoteLlmServerOrigin = (config?: Config): string =>
  config?.remote_llm_server_config?.server_origin || DEFAULT_REMOTE_LLM_SERVER_ORIGIN

export const getRemoteLlmServerAccessToken = (config?: Config): string =>
  config?.remote_llm_server_config?.access_token?.trim() || ''

export const buildRemoteLlmServerHeaders = (
  config?: Config,
  headers: Record<string, string> = {}
): Record<string, string> => {
  const token = getRemoteLlmServerAccessToken(config)
  if (!token) {
    return headers
  }

  if (headers.Authorization || headers.authorization) {
    return headers
  }

  return {
    ...headers,
    Authorization: `Bearer ${token}`
  }
}

const extractRemoteLlmServerErrorDetail = (bodyText?: string): string | undefined => {
  const normalized = bodyText?.trim()
  if (!normalized) {
    return undefined
  }

  try {
    const parsed = JSON.parse(normalized) as
      | { error?: unknown; message?: unknown; detail?: unknown }
      | null
      | undefined
    const detail = [parsed?.error, parsed?.message, parsed?.detail].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    )
    return detail?.trim() || normalized
  } catch {
    return normalized
  }
}

export const buildRemoteLlmServerErrorMessage = (
  requestKind: 'chat' | 'profiles',
  response: Pick<Response, 'status' | 'statusText'>,
  bodyText?: string
): string => {
  const requestLabel = requestKind === 'chat' ? 'chat request' : 'profile list request'
  const detail = extractRemoteLlmServerErrorDetail(bodyText)
  const statusLabel = [response.status, response.statusText].filter(Boolean).join(' ').trim()
  const detailSuffix = detail ? ` Server message: ${detail}` : ''

  if (response.status === 401) {
    return `Remote ${requestLabel} was rejected (401 Unauthorized). Check that the remote LLM proxy access token matches the server configuration.${detailSuffix}`
  }

  return `Remote ${requestLabel} failed (${statusLabel || response.status}). Check that the remote LLM service is running and the server address is correct.${detailSuffix}`
}

export const buildChatAvailableProfiles = (
  config: Config | undefined,
  remoteProfiles: LLMAPIProfile[]
): LLMAPIProfile[] => {
  if (config?.use_remote_llm) {
    return remoteProfiles
  }

  return config?.llm_config?.api_profiles?.filter(isConfiguredLocalProfile) || []
}

export const resolveAvailableChatProfileId = (
  availableProfiles: Array<Pick<LLMAPIProfile, 'id'>>,
  profileId: string | null | undefined
): string | null => {
  const baseProfileId = getBaseProfileId(profileId)
  if (!baseProfileId) {
    return availableProfiles[0]?.id || null
  }

  if (availableProfiles.length === 0) {
    return baseProfileId === HUNYUAN_3D_PROFILE_ID ? null : baseProfileId
  }

  if (profileId && availableProfiles.some((profile) => profile.id === profileId)) {
    return profileId
  }

  return availableProfiles.some((profile) => profile.id === baseProfileId) ? baseProfileId : null
}

export const getProfileDisplayName = (
  profiles: LLMAPIProfile[],
  profileId: string | null | undefined,
  fallback = 'Gemini'
): string => profiles.find((profile) => profile.id === profileId)?.model_name || fallback
