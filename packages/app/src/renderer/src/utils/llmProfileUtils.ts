import type { Config, LLMAPIProfile } from '@shared/config/config'
import { getBaseProfileId, HUNYUAN_3D_PROFILE_ID } from '@renderer/pages/ChatPage/chatPageShared'
import { isLocalBaseUrl, isRunnableProfile } from '@shared/llm'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
export function resolveCompositeLlmProfile<
  TListed extends { id: string; base_profile_id?: string; model_name?: string },
  TConfigured extends { id: string }
>(
  listedProfile: TListed,
  configuredProfiles: readonly TConfigured[]
): TListed & Partial<TConfigured> {
  const baseId = listedProfile.base_profile_id || listedProfile.id
  const baseProfile = configuredProfiles.find((profile) => profile.id === baseId)
  return {
    ...(baseProfile || {}),
    ...listedProfile,
    model_name: listedProfile.model_name
  } as TListed & Partial<TConfigured>
}

export const DEFAULT_REMOTE_LLM_SERVER_ORIGIN = 'http://localhost:3721'

const isConfiguredLocalProfile = (profile: LLMAPIProfile): boolean =>
  profile.call_type === 'local' ||
  profile.deployment === 'local' ||
  (isLocalBaseUrl(profile.base_url || '') && !profile.api_key?.trim())

export const upsertLlmProfile = (
  profiles: LLMAPIProfile[],
  profileId: string,
  nextProfile: LLMAPIProfile
): LLMAPIProfile[] => profiles.map((profile) => (profile.id === profileId ? nextProfile : profile))

export const stripExternalAuthProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.stripExternalAuthProfile?.(profile)
    if (resolved !== undefined) return resolved
  }

  const {
    auth_mode: _authMode,
    auth_account_email: _authAccountEmail,
    auth_connected_at: _authConnectedAt,
    ...nextProfile
  } = profile
  return nextProfile
}

export const disconnectExternalProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.disconnectExternalProfile?.(profile)
    if (resolved !== undefined) return resolved
  }

  return {
    ...stripProviderMetadataProfile(stripExternalAuthProfile(profile)),
    api_key: '',
    api_secret: undefined,
    backup_api_keys: undefined
  }
}

export const stripProviderMetadataProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.stripProviderMetadataProfile?.(profile)
    if (resolved !== undefined) return resolved
  }

  const { codex_fast_mode: _codexFastMode, ...nextProfile } = profile
  return nextProfile
}

const isCompositeModelProfileId = (profileId: string | null | undefined): boolean => {
  const segments = String(profileId || '').split('::')
  return segments.length === 3 && segments[1] === 'codex-model' && Boolean(segments[2]?.trim())
}

export const isChatProfileDiscoveryCandidate = (profile: LLMAPIProfile): boolean => {
  const isOrdinaryProfile =
    profile.auth_mode !== 'codex_oauth' &&
    profile.call_type !== 'codex' &&
    profile.call_type !== 'cliproxyapi'

  if (isOrdinaryProfile) {
    return rendererHostExtensionApiV1.chat?.discoverModelNames !== undefined
  }

  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.isChatProfileDiscoveryCandidate?.(profile)
    if (resolved !== undefined) return resolved
  }

  return Boolean(profile.base_url?.trim())
}
const withProfileDisplayName = (profile: LLMAPIProfile): LLMAPIProfile =>
  profile.call_type === 'cliproxyapi' && !profile.model_name.trim()
    ? { ...profile, model_name: 'CLIProxyAPI/Codex' }
    : profile

const expandDiscoveredModelProfile = (
  profile: LLMAPIProfile,
  discoveredModelNames: readonly string[] = []
): LLMAPIProfile[] => {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const resolved = extension.expandChatModelProfiles?.(profile, discoveredModelNames)
    if (resolved !== undefined) return resolved
  }

  if (discoveredModelNames.length === 0) return [profile]
  const isCodexDiscoveryProfile =
    profile.auth_mode === 'codex_oauth' ||
    profile.call_type === 'codex' ||
    profile.call_type === 'cliproxyapi'
  if (!isCodexDiscoveryProfile) return [profile]

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
      id: `${profile.id}::codex-model::${encodeURIComponent(modelName)}`,
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

const cleanRemoteProfileNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined
  }
  return value
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
  for (const key of [
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
    delete passthroughProfile[key]
  }

  return {
    ...passthroughProfile,
    id,
    model_name: modelName,
    base_url: cleanRemoteProfileString(profile.base_url ?? profile.baseUrl) || '',
    api_key: cleanRemoteProfileString(profile.api_key ?? profile.apiKey) || '',
    max_input_images: cleanRemoteProfileNumber(
      profile.max_input_images ?? profile.maxInputImages ?? profile.max_images ?? profile.maxImages
    ),
    maxInputImages: cleanRemoteProfileNumber(
      profile.max_input_images ?? profile.maxInputImages ?? profile.max_images ?? profile.maxImages
    ),
    max_images: cleanRemoteProfileNumber(
      profile.max_input_images ?? profile.maxInputImages ?? profile.max_images ?? profile.maxImages
    ),
    maxImages: cleanRemoteProfileNumber(
      profile.max_input_images ?? profile.maxInputImages ?? profile.max_images ?? profile.maxImages
    ),
    supports_session_continuation:
      typeof profile.supports_session_continuation === 'boolean'
        ? profile.supports_session_continuation
        : typeof profile.supportsSessionContinuation === 'boolean'
          ? profile.supportsSessionContinuation
          : undefined,
    supportsSessionContinuation:
      typeof profile.supportsSessionContinuation === 'boolean'
        ? profile.supportsSessionContinuation
        : typeof profile.supports_session_continuation === 'boolean'
          ? profile.supports_session_continuation
          : undefined
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
      | {
          error?: unknown
          message?: unknown
          detail?: unknown
        }
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
  cliProxyModelsByProfileId: Readonly<Record<string, readonly string[]>> = {}
): LLMAPIProfile[] => {
  if (config?.use_remote_llm) {
    return remoteProfiles
  }

  return (config?.llm_config?.api_profiles || [])
    .filter((profile) => {
      const isOrdinaryProfile =
        profile.auth_mode !== 'codex_oauth' &&
        profile.call_type !== 'codex' &&
        profile.call_type !== 'cliproxyapi'
      if (isOrdinaryProfile && rendererHostExtensionApiV1.chat?.discoverModelNames === undefined) {
        return true
      }
      return (
        isOrdinaryProfile ||
        isChatProfileDiscoveryCandidate(profile) ||
        isConfiguredLocalProfile(profile)
      )
    })
    .flatMap((profile) =>
      expandDiscoveredModelProfile(profile, cliProxyModelsByProfileId[profile.id])
    )
    .map(withProfileDisplayName)
}

export const resolveAvailableChatProfileId = (
  availableProfiles: Array<Pick<LLMAPIProfile, 'id'>>,
  profileId: string | null | undefined,
  configuredProfiles: Array<Pick<LLMAPIProfile, 'id' | 'call_type' | 'auth_mode'>> = []
): string | null => {
  const baseProfileId = getBaseProfileId(profileId)
  if (!baseProfileId) {
    return availableProfiles[0]?.id || null
  }

  if (availableProfiles.length === 0) {
    if (isCompositeModelProfileId(profileId)) {
      return profileId || null
    }

    return baseProfileId === HUNYUAN_3D_PROFILE_ID ? null : baseProfileId
  }

  if (profileId && availableProfiles.some((profile) => profile.id === profileId)) {
    return profileId
  }

  const virtual = isCompositeModelProfileId(profileId)
  if (virtual) {
    const configuredProfile = configuredProfiles.find(
      (profile) => profile.id === String(profileId || '').split('::')[0]
    )
    if (
      configuredProfile &&
      (configuredProfile.auth_mode === 'codex_oauth' ||
        configuredProfile.call_type === 'codex' ||
        configuredProfile.call_type === 'cliproxyapi')
    ) {
      return profileId || null
    }

    for (const extension of sharedHostExtensionApiV1.llmProfiles) {
      const configuredProfile = configuredProfiles.find(
        (profile) => profile.id === String(profileId || '').split('::')[0]
      )
      if (configuredProfile && configuredProfile.auth_mode !== 'codex_oauth') {
        continue
      }
      const resolved = extension.resolveChatProfileSelection?.({
        availableProfiles,
        configuredProfiles,
        profileId: profileId || ''
      })
      if (resolved !== undefined) return resolved
    }
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
