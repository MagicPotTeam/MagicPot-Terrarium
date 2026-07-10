import type { Config, LLMAPIProfile } from '@shared/config/config'
import { getBaseProfileId, HUNYUAN_3D_PROFILE_ID } from '@renderer/pages/ChatPage/chatPageShared'
import { isRunnableProfile } from '@shared/llm'

export const DEFAULT_REMOTE_LLM_SERVER_ORIGIN = 'http://localhost:3721'

const isConfiguredLocalProfile = (profile: LLMAPIProfile): boolean => isRunnableProfile(profile)

const buildDiscoveredModelProfileId = (profileId: string, modelName: string): string =>
  `${profileId.trim()}::codex-model::${encodeURIComponent(modelName.trim())}`

const expandDiscoveredModelProfile = (
  profile: LLMAPIProfile,
  discoveredModelNames: readonly string[] = []
): LLMAPIProfile[] => {
  if (discoveredModelNames.length === 0) {
    return [profile]
  }

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
      id: buildDiscoveredModelProfileId(profile.id, modelName),
      model_name: modelName
    }))
}

export const getRemoteLlmServerOrigin = (config?: Config): string =>
  config?.remote_llm_server_config?.server_origin || DEFAULT_REMOTE_LLM_SERVER_ORIGIN

export const getRemoteLlmServerAccessToken = (config?: Config): string =>
  config?.remote_llm_server_config?.access_token?.trim() || ''

const REMOTE_LLM_AUTH_HEADER_NAMES = [
  'authorization',
  'x-magicpot-proxy-token',
  'x-magicpot-bot-secret',
  'x-bot-secret'
]

const hasRemoteLlmAuthHeader = (headers: Record<string, string>): boolean =>
  Object.entries(headers).some(
    ([name, value]) =>
      REMOTE_LLM_AUTH_HEADER_NAMES.includes(name.toLowerCase()) && value.trim().length > 0
  )

export const buildRemoteLlmServerHeaders = (
  config?: Config,
  headers: Record<string, string> = {}
): Record<string, string> => {
  const token = getRemoteLlmServerAccessToken(config)
  if (!token) {
    return headers
  }

  if (hasRemoteLlmAuthHeader(headers)) {
    return headers
  }

  return {
    ...headers,
    Authorization: `Bearer ${token}`,
    'X-MagicPot-Proxy-Token': token,
    'X-MagicPot-Bot-Secret': token,
    'X-Bot-Secret': token
  }
}

const isRemoteProfileRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cleanRemoteProfileString = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }

  const normalized = String(value).trim()
  return normalized || undefined
}

const collectRemoteProfileCandidatesFromMap = (value: Record<string, unknown>): unknown[] =>
  Object.entries(value).map(([id, profile]) =>
    isRemoteProfileRecord(profile)
      ? { id, ...profile }
      : { id, model_name: cleanRemoteProfileString(profile) || id }
  )

const collectRemoteProfileCandidates = (data: unknown): unknown[] => {
  if (Array.isArray(data)) {
    return data
  }
  if (!isRemoteProfileRecord(data)) {
    return []
  }

  for (const key of ['profiles', 'availableProfiles', 'models', 'data']) {
    const value = data[key]
    if (Array.isArray(value)) {
      return value
    }
    if (isRemoteProfileRecord(value)) {
      return collectRemoteProfileCandidatesFromMap(value)
    }
  }

  return []
}

const normalizeRemoteProfile = (profile: unknown): LLMAPIProfile | null => {
  if (typeof profile === 'string' || typeof profile === 'number') {
    const id = cleanRemoteProfileString(profile)
    return id
      ? {
          id,
          model_name: id,
          base_url: '',
          api_key: ''
        }
      : null
  }
  if (!isRemoteProfileRecord(profile)) {
    return null
  }

  const id = cleanRemoteProfileString(
    profile.id ?? profile.profileId ?? profile.profile_id ?? profile.model ?? profile.name
  )
  if (!id) {
    return null
  }

  const modelName =
    cleanRemoteProfileString(
      profile.model_name ??
        profile.modelName ??
        profile.displayName ??
        profile.label ??
        profile.name ??
        profile.model
    ) || id

  const passthroughProfile = { ...profile }
  for (const aliasKey of [
    'profileId',
    'profile_id',
    'modelName',
    'displayName',
    'label',
    'name',
    'model',
    'baseUrl',
    'apiKey'
  ]) {
    delete passthroughProfile[aliasKey]
  }

  return {
    ...passthroughProfile,
    id,
    model_name: modelName,
    base_url: cleanRemoteProfileString(profile.base_url ?? profile.baseUrl) || '',
    api_key: cleanRemoteProfileString(profile.api_key ?? profile.apiKey) || ''
  } as LLMAPIProfile
}

export const normalizeRemoteLlmProfiles = (data: unknown): LLMAPIProfile[] => {
  const seen = new Set<string>()
  const profiles: LLMAPIProfile[] = []

  for (const candidate of collectRemoteProfileCandidates(data)) {
    const profile = normalizeRemoteProfile(candidate)
    if (!profile || seen.has(profile.id)) {
      continue
    }
    seen.add(profile.id)
    profiles.push(profile)
  }

  return profiles
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
  remoteProfiles: LLMAPIProfile[],
  discoveredModelsByProfileId: Readonly<Record<string, readonly string[]>> = {}
): LLMAPIProfile[] => {
  if (config?.use_remote_llm) {
    return remoteProfiles
  }

  return (config?.llm_config?.api_profiles?.filter(isConfiguredLocalProfile) || []).flatMap(
    (profile) => expandDiscoveredModelProfile(profile, discoveredModelsByProfileId[profile.id])
  )
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

  const baseProfile = availableProfiles.find((profile) => profile.id === baseProfileId)
  if (baseProfile) {
    return baseProfile.id
  }

  return (
    availableProfiles.find((profile) => getBaseProfileId(profile.id) === baseProfileId)?.id || null
  )
}

export const getProfileDisplayName = (
  profiles: LLMAPIProfile[],
  profileId: string | null | undefined,
  fallback = 'Gemini'
): string => profiles.find((profile) => profile.id === profileId)?.model_name || fallback
