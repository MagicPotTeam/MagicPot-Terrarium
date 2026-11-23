import React from 'react'
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import {
  getQAppApiProfiles,
  isHunyuan3DCompatibleProfile
} from '@shared/config/apiProfileSelectors'
import { resolveProfileModelUse } from '@shared/llm'
import { resolveCodexThreadImageCapability } from '@shared/extensions/codexImageProfile'

import CodexImageProfileSelector from './CodexImageProfileSelector'
import type {
  CodexSharedAuthStatus,
  CodexUsageWindow,
  GetCodexUsageResp
} from '@shared/api/svcCodexAuth'
import type {
  AgentApiProfileCallTypeOption,
  AgentApiProfileCardRenderOptions,
  AgentApiProfileUi,
  RendererHostExtensionApiV1
} from '@renderer/extensions/generatedRegistry'
import { api } from '@renderer/utils/windowUtils'
import enCodex from '@shared/locales/en-US/codex.json'
import zhCodex from '@shared/locales/zh-CN/codex.json'
import {
  resolveProjectIdFromStorageScope,
  resolveProjectResourceDir
} from '@renderer/utils/projectResourcePaths'

const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const CODEX_BACKEND_PLACEHOLDER = 'https://chatgpt.com/backend-api/codex'
const HUNYUAN_AI3D_BASE_URL = 'https://api.ai3d.cloud.tencent.com'
const TRIPO_INTERNATIONAL_BASE_URL = 'https://api.tripo3d.ai/v2/openapi'
const DEFAULT_HY3D_COS_PREFIX = 'magicpot/hunyuan3d'
const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'

type CodexTranslationKey = keyof typeof enCodex
type CodexTranslationValues = Record<string, string | number>

const getCodexText = (
  isChineseUi: boolean,
  key: CodexTranslationKey,
  values?: CodexTranslationValues
): string => {
  const template = (isChineseUi ? zhCodex : enCodex)[key] ?? enCodex[key]
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}

const stripCodexOAuthProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const {
    auth_mode: _authMode,
    auth_account_email: _authAccountEmail,
    auth_connected_at: _authConnectedAt,
    ...nextProfile
  } = profile

  return nextProfile
}

const stripCodexFastModeProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const { codex_fast_mode: _codexFastMode, ...nextProfile } = profile
  return nextProfile
}

const stripCodexProfile = (profile: LLMAPIProfile): LLMAPIProfile =>
  stripCodexFastModeProfile(stripCodexOAuthProfile(profile))

const stripCodexOAuthConnectionProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const {
    call_type: _callType,
    api_secret: _apiSecret,
    backup_api_keys: _backupApiKeys,
    ...cleanedProfile
  } = stripCodexProfile(profile)

  return {
    ...cleanedProfile,
    api_key: '',
    base_url: OFFICIAL_OPENAI_BASE_URL,
    provider: 'default',
    deployment: undefined,
    is_ollama: false
  }
}

const stripLocalModelProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const { local_model_path: _localModelPath, ...nextProfile } = profile
  return nextProfile
}

const stripVideoSecretProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const { api_secret: _apiSecret, ...nextProfile } = profile
  return nextProfile
}

const stripHunyuan3DProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const {
    tencent_secret_id: _tencentSecretId,
    tencent_secret_key: _tencentSecretKey,
    api_region: _apiRegion,
    cos_bucket: _cosBucket,
    cos_region: _cosRegion,
    cos_key_prefix: _cosKeyPrefix,
    ...nextProfile
  } = profile

  return nextProfile
}

const isCodexOAuthProfile = (profile: LLMAPIProfile): boolean => profile.auth_mode === 'codex_oauth'
const isCodexProfile = (profile: Pick<LLMAPIProfile, 'auth_mode' | 'call_type'>): boolean =>
  profile.auth_mode === 'codex_oauth' || profile.call_type === 'codex'
const isCLIProxyAPIProfile = (profile: Pick<LLMAPIProfile, 'call_type'>): boolean =>
  profile.call_type === 'cliproxyapi'

const applyCLIProxyAPICallTypeToProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const isCurrentCLIProxyProfile = isCLIProxyAPIProfile(profile)
  return {
    ...stripCodexProfile(
      stripVideoSecretProfile(stripHunyuan3DProfile(stripLocalModelProfile(profile)))
    ),
    call_type: 'cliproxyapi',
    model_name: '',
    base_url: isCurrentCLIProxyProfile ? profile.base_url : '',
    api_key: isCurrentCLIProxyProfile ? profile.api_key : '',
    backup_api_keys: undefined,
    provider: 'default',
    deployment: undefined,
    model_use: 'agent',
    is_ollama: false,
    is_vision_model: true,
    is_ocr_model: false
  }
}

const applyCodexCallTypeToProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const sourceProfile = isCodexOAuthProfile(profile) ? profile : stripCodexOAuthProfile(profile)
  const codexProfile = stripVideoSecretProfile(
    stripHunyuan3DProfile(stripLocalModelProfile(sourceProfile))
  )
  return {
    ...codexProfile,
    call_type: 'codex',
    model_name: codexProfile.model_name.trim(),
    base_url: OFFICIAL_OPENAI_BASE_URL,
    api_key: '',
    backup_api_keys: undefined,
    provider: 'default',
    deployment: undefined,
    model_use: resolveProfileModelUse(profile) === 'video' ? 'agent' : profile.model_use,
    codex_fast_mode: profile.codex_fast_mode !== false,
    is_ollama: false,
    is_vision_model: true,
    is_ocr_model: false
  }
}

const applyNonCodexCallTypeToCodexProfile = (
  profile: LLMAPIProfile,
  callType: string
): LLMAPIProfile | undefined => {
  if (!isCodexProfile(profile)) {
    return undefined
  }

  const cleanedProfile = stripCodexProfile(profile)

  switch (callType) {
    case 'api':
      return stripVideoSecretProfile(
        stripHunyuan3DProfile(stripLocalModelProfile(stripCodexOAuthConnectionProfile(profile)))
      )
    case 'local':
      return {
        ...stripVideoSecretProfile(stripHunyuan3DProfile(stripLocalModelProfile(cleanedProfile))),
        call_type: 'local',
        model_name: '',
        base_url: '',
        api_key: '',
        backup_api_keys: undefined,
        provider: 'default',
        deployment: undefined,
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false,
        local_model_path: cleanedProfile.local_model_path?.trim() || ''
      }
    case 'tripo':
      return {
        ...stripVideoSecretProfile(stripHunyuan3DProfile(stripLocalModelProfile(cleanedProfile))),
        call_type: 'api',
        model_name: 'Tripo3D',
        base_url: TRIPO_INTERNATIONAL_BASE_URL,
        api_key: '',
        backup_api_keys: undefined,
        provider: 'default',
        deployment: undefined,
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false
      }
    case 'hunyuan3d':
      return {
        ...stripVideoSecretProfile(stripLocalModelProfile(cleanedProfile)),
        call_type: undefined,
        model_name: 'Hunyuan3D Pro',
        base_url: HUNYUAN_AI3D_BASE_URL,
        api_key: '',
        backup_api_keys: undefined,
        provider: 'default',
        deployment: undefined,
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: DEFAULT_HY3D_API_REGION,
        cos_bucket: '',
        cos_region: DEFAULT_HY3D_API_REGION,
        cos_key_prefix: DEFAULT_HY3D_COS_PREFIX
      }
    default:
      return undefined
  }
}

const insertCodexCallTypeOption = (
  options: AgentApiProfileCallTypeOption[]
): AgentApiProfileCallTypeOption[] => {
  const hasCodex = options.some((option) => option.value === 'codex')
  const hasCLIProxyAPI = options.some((option) => option.value === 'cliproxyapi')
  if (hasCodex && hasCLIProxyAPI) {
    return options
  }

  const additions = [
    ...(hasCLIProxyAPI ? [] : [{ label: 'CLIProxyAPI/Codex', value: 'cliproxyapi' }]),
    ...(hasCodex ? [] : [{ label: 'Codex', value: 'codex' }])
  ]
  const apiIndex = options.findIndex((option) => option.value === 'api')
  if (apiIndex < 0) {
    return [...additions, ...options]
  }

  return [...options.slice(0, apiIndex + 1), ...additions, ...options.slice(apiIndex + 1)]
}

const resolveCodexProfileUi = (
  profile: LLMAPIProfile,
  baseUi: AgentApiProfileUi
): AgentApiProfileUi | undefined => {
  if (isCLIProxyAPIProfile(profile)) {
    return {
      ...baseUi,
      apiKeyLabel: 'CLIProxyAPI API Key',
      apiKeyPlaceholder: '',
      baseUrlPlaceholder: '',
      modelNamePlaceholder: '',
      showModelNameInput: false,
      showApiKeyInput: true,
      showBackupKeys: false,
      showBaseUrlInput: true,
      showKlingSecretInput: false
    }
  }

  if (!isCodexProfile(profile)) {
    return undefined
  }

  return {
    ...baseUi,
    apiKeyPlaceholder: '',
    baseUrlPlaceholder: CODEX_BACKEND_PLACEHOLDER,
    modelNamePlaceholder: '',
    showModelNameInput: false,
    showApiKeyInput: false,
    showBackupKeys: false,
    showBaseUrlInput: false,
    showKlingSecretInput: false
  }
}

const formatCodexLoginError = (error: unknown, isChineseUi: boolean): string => {
  const fallback = getCodexText(isChineseUi, 'login_failed')

  if (!(error instanceof Error) || !error.message) {
    return fallback
  }

  const message = error.message
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('missing organization_id')) {
    return getCodexText(isChineseUi, 'missing_organization')
  }

  if (normalizedMessage.includes('unknown_error')) {
    return getCodexText(isChineseUi, 'unknown_error')
  }

  return message
}

const formatCodexUsageError = (error: unknown, isChineseUi: boolean): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  return getCodexText(isChineseUi, 'usage_status_failed')
}

const formatCodexPlanLabel = (planType: string | undefined, isChineseUi: boolean): string => {
  const normalized = String(planType || '')
    .trim()
    .toLowerCase()

  if (!normalized) {
    return getCodexText(isChineseUi, 'unknown')
  }

  const labels: Record<string, { zh: string; en: string }> = {
    business: { zh: 'Business', en: 'Business' },
    edu: { zh: 'Edu', en: 'Edu' },
    education: { zh: 'Education', en: 'Education' },
    enterprise: { zh: 'Enterprise', en: 'Enterprise' },
    free: { zh: 'Free', en: 'Free' },
    free_workspace: { zh: 'Free Workspace', en: 'Free Workspace' },
    go: { zh: 'Go', en: 'Go' },
    guest: { zh: 'Guest', en: 'Guest' },
    k12: { zh: 'K12', en: 'K12' },
    plus: { zh: 'Plus', en: 'Plus' },
    pro: { zh: 'Pro', en: 'Pro' },
    quorum: { zh: 'Quorum', en: 'Quorum' },
    team: { zh: 'Team', en: 'Team' }
  }

  const matched = labels[normalized]
  if (matched) {
    return isChineseUi ? matched.zh : matched.en
  }

  return normalized
}

const formatDurationShort = (totalSeconds: number, isChineseUi: boolean): string => {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds <= 0) {
    return getCodexText(isChineseUi, 'resets_soon')
  }

  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)

  const parts: string[] = []
  if (days > 0) parts.push(getCodexText(isChineseUi, 'days', { value: days }))
  if (hours > 0) parts.push(getCodexText(isChineseUi, 'hours', { value: hours }))
  if (minutes > 0 && parts.length < 2)
    parts.push(getCodexText(isChineseUi, 'minutes', { value: minutes }))

  return parts.join(' ') || getCodexText(isChineseUi, 'less_than_minute')
}

const formatCodexWindowLabel = (windowSeconds: number, isChineseUi: boolean): string => {
  if (windowSeconds >= 604_800 - 60 && windowSeconds <= 604_800 + 60) {
    return getCodexText(isChineseUi, 'weekly_quota')
  }

  if (windowSeconds >= 18_000 - 60 && windowSeconds <= 18_000 + 60) {
    return getCodexText(isChineseUi, 'five_hour_quota')
  }

  if (windowSeconds >= 3_600 && windowSeconds % 3_600 === 0) {
    const hours = Math.round(windowSeconds / 3_600)
    return getCodexText(isChineseUi, 'hours_quota', { value: hours })
  }

  const minutes = Math.max(1, Math.round(windowSeconds / 60))
  return getCodexText(isChineseUi, 'minutes_quota', { value: minutes })
}

const formatCodexResetAt = (
  resetAt: string | undefined,
  resetAfterSeconds: number,
  isChineseUi: boolean
): string => {
  const relative = formatDurationShort(resetAfterSeconds, isChineseUi)
  if (!resetAt) {
    return relative
  }

  const parsed = new Date(resetAt)
  if (Number.isNaN(parsed.getTime())) {
    return relative
  }

  return `${parsed.toLocaleString()} (${relative})`
}

type CodexTranslation = (key: CodexTranslationKey, values?: CodexTranslationValues) => string

type CodexQuotaWindowCardProps = {
  translate: CodexTranslation
  isChineseUi: boolean
  isLight: boolean
  quotaWindow: CodexUsageWindow
}

// This extension exports a registry object as its public API; keep the UI card local.
// eslint-disable-next-line react-refresh/only-export-components
const CodexQuotaWindowCard: React.FC<CodexQuotaWindowCardProps> = ({
  translate,
  isChineseUi,
  isLight,
  quotaWindow
}) => {
  const remainingPercent = Math.max(0, Math.min(100, quotaWindow.remainingPercent))

  return (
    <Box
      sx={{
        p: 1,
        borderRadius: 1.25,
        bgcolor: isLight ? 'rgba(15,23,42,0.04)' : 'rgba(255,255,255,0.06)'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          gap: 1.5,
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' }
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600}>
            {formatCodexWindowLabel(quotaWindow.limitWindowSeconds, isChineseUi)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {translate('reset_time')}:&nbsp;
            {formatCodexResetAt(quotaWindow.resetAt, quotaWindow.resetAfterSeconds, isChineseUi)}
          </Typography>
        </Box>
        <Box
          sx={{
            width: { xs: '100%', sm: 220 },
            minWidth: 0,
            display: 'flex',
            gap: 1.25
          }}
        >
          <LinearProgress
            variant="determinate"
            value={remainingPercent}
            sx={{
              flex: 1,
              height: 7,
              borderRadius: 999,
              alignSelf: 'center',
              bgcolor: isLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.12)',
              '& .MuiLinearProgress-bar': {
                borderRadius: 999,
                bgcolor: isLight ? '#111827' : '#f8fafc'
              }
            }}
          />
          <Typography variant="body2" fontWeight={600} sx={{ minWidth: 90, textAlign: 'right' }}>
            {translate('remaining')} {remainingPercent}%
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

type CodexAgentProfileExtraProps = AgentApiProfileCardRenderOptions

// This extension exports a registry object as its public API; keep the UI card local.
// eslint-disable-next-line react-refresh/only-export-components
const CodexAgentProfileExtra: React.FC<CodexAgentProfileExtraProps> = ({
  isChineseUi,
  onReplaceProfiles,
  onUpdate,
  profile,
  profiles
}) => {
  const translate: CodexTranslation = (key, values) => getCodexText(isChineseUi, key, values)
  const [codexLoginError, setCodexLoginError] = React.useState<string | null>(null)
  const [isCodexLoginPending, setIsCodexLoginPending] = React.useState(false)
  const [codexSharedAuthStatus, setCodexSharedAuthStatus] =
    React.useState<CodexSharedAuthStatus | null>(null)
  const [codexSharedAuthError, setCodexSharedAuthError] = React.useState<string | null>(null)
  const [isCodexSharedAuthPending, setIsCodexSharedAuthPending] = React.useState(false)
  const [isCodexSharedLogoutPending, setIsCodexSharedLogoutPending] = React.useState(false)
  const [codexUsage, setCodexUsage] = React.useState<GetCodexUsageResp | null>(null)
  const [codexUsageError, setCodexUsageError] = React.useState<string | null>(null)
  const [isCodexUsagePending, setIsCodexUsagePending] = React.useState(false)

  const usesCodexOAuth = profile.auth_mode === 'codex_oauth'
  const sharedCodexLoginAvailable = codexSharedAuthStatus?.available === true
  const showSharedCodexLogout = codexSharedAuthStatus?.mode === 'chatgpt'
  const showCodexQuota = usesCodexOAuth && sharedCodexLoginAvailable

  // Async authentication must merge into the latest committed card and save
  // callbacks, not the render that started login. Never revive a removed card.
  const currentCard = React.useRef({ profile, profiles, onUpdate, onReplaceProfiles })
  React.useLayoutEffect(() => {
    currentCard.current = { profile, profiles, onUpdate, onReplaceProfiles }
  }, [profile, profiles, onUpdate, onReplaceProfiles])
  const cardLifetime = React.useRef<object | undefined>(undefined)
  React.useLayoutEffect(() => {
    const lifetime = {}
    cardLifetime.current = lifetime
    return () => {
      cardLifetime.current = undefined
    }
  }, [profile.id, profile.call_type])
  const currentAuthCard = (id: string, lifetime: object | undefined) => {
    if (!lifetime || cardLifetime.current !== lifetime) return undefined
    const latest = currentCard.current
    const matches = latest.profiles.filter((candidate) => candidate.id === id)
    if (
      latest.profile.id !== id ||
      matches.length !== 1 ||
      !isCodexProfile(latest.profile) ||
      !isCodexProfile(matches[0])
    )
      return undefined
    return { ...latest, profile: matches[0] }
  }

  const loadCodexSharedAuthStatus = React.useCallback(async () => {
    setCodexSharedAuthError(null)
    setIsCodexSharedAuthPending(true)

    try {
      const status = await api().svcCodexAuth.status({})
      setCodexSharedAuthStatus(status)
    } catch (error) {
      setCodexSharedAuthStatus(null)
      setCodexSharedAuthError(formatCodexUsageError(error, isChineseUi))
    } finally {
      setIsCodexSharedAuthPending(false)
    }
  }, [isChineseUi])

  React.useEffect(() => {
    void loadCodexSharedAuthStatus()
  }, [loadCodexSharedAuthStatus])

  const loadCodexUsage = React.useCallback(async () => {
    if (!showCodexQuota) {
      setCodexUsage(null)
      setCodexUsageError(null)
      setIsCodexUsagePending(false)
      return
    }

    setCodexUsageError(null)
    setIsCodexUsagePending(true)

    try {
      const usage = await api().svcCodexAuth.getUsage({})
      setCodexUsage(usage)
    } catch (error) {
      setCodexUsage(null)
      setCodexUsageError(formatCodexUsageError(error, isChineseUi))
    } finally {
      setIsCodexUsagePending(false)
    }
  }, [isChineseUi, showCodexQuota])

  React.useEffect(() => {
    void loadCodexUsage()
  }, [loadCodexUsage])

  const handleCodexLogin = async (mode: 'local' | 'browser') => {
    const id = profile.id,
      lifetime = cardLifetime.current
    if (!currentAuthCard(id, lifetime)) return
    setCodexLoginError(null)
    setIsCodexLoginPending(true)

    try {
      const result = await api().svcCodexAuth.login({
        mode,
        forceReauth: mode === 'browser' ? true : undefined
      })

      const latest = currentAuthCard(id, lifetime)
      if (!latest) return
      latest.onUpdate(
        id,
        applyCodexCallTypeToProfile({
          ...latest.profile,
          auth_mode: 'codex_oauth',
          auth_account_email: result.email,
          auth_connected_at: result.connectedAt
        })
      )
      await Promise.allSettled([loadCodexSharedAuthStatus(), loadCodexUsage()])
    } catch (error) {
      if (currentAuthCard(id, lifetime))
        setCodexLoginError(formatCodexLoginError(error, isChineseUi))
    } finally {
      if (cardLifetime.current === lifetime) setIsCodexLoginPending(false)
    }
  }

  const handleDisconnectCodexProfile = () => {
    setCodexLoginError(null)
    onUpdate(profile.id, stripCodexOAuthConnectionProfile(profile))
  }

  const handleSignOutSharedCodexLogin = async () => {
    const id = profile.id,
      lifetime = cardLifetime.current
    if (!currentAuthCard(id, lifetime)) return
    setCodexLoginError(null)
    setIsCodexSharedLogoutPending(true)

    try {
      await api().svcCodexAuth.logout({ scope: 'shared' })
      const latest = currentAuthCard(id, lifetime)
      if (!latest) return
      latest.onReplaceProfiles(
        latest.profiles.map((candidateProfile) =>
          isCodexProfile(candidateProfile)
            ? stripCodexOAuthConnectionProfile(candidateProfile)
            : candidateProfile
        )
      )
      setCodexUsage(null)
      await loadCodexSharedAuthStatus()
    } catch (error) {
      if (currentAuthCard(id, lifetime))
        setCodexLoginError(formatCodexUsageError(error, isChineseUi))
    } finally {
      if (cardLifetime.current === lifetime) setIsCodexSharedLogoutPending(false)
    }
  }

  return (
    <Stack spacing={1}>
      <Alert severity={usesCodexOAuth ? 'success' : 'info'}>
        <Typography variant="body2">
          {usesCodexOAuth
            ? profile.auth_account_email
              ? translate('codex_signed_in_with_email', {
                  email: profile.auth_account_email
                })
              : translate('codex_signed_in')
            : translate('codex_sign_in_info')}
        </Typography>
      </Alert>

      {isCodexSharedAuthPending && (
        <Typography variant="caption" color="text.secondary">
          {translate('checking_local_login')}
        </Typography>
      )}
      {codexSharedAuthError && (
        <Alert severity="warning">
          <Typography variant="body2">{codexSharedAuthError}</Typography>
        </Alert>
      )}
      {!codexSharedAuthError && codexSharedAuthStatus && (
        <Alert
          severity={
            codexSharedAuthStatus.available
              ? 'success'
              : codexSharedAuthStatus.mode === 'api_key'
                ? 'warning'
                : usesCodexOAuth
                  ? 'warning'
                  : 'info'
          }
        >
          <Typography variant="body2">
            {codexSharedAuthStatus.available
              ? codexSharedAuthStatus.email
                ? translate('local_login_detected_with_email', {
                    email: codexSharedAuthStatus.email
                  })
                : translate('local_login_detected')
              : codexSharedAuthStatus.mode === 'api_key'
                ? translate('api_key_mode_unavailable')
                : codexSharedAuthStatus.reason === 'missing_auth_file'
                  ? translate('missing_local_login')
                  : translate('unusable_local_login')}
          </Typography>
        </Alert>
      )}
      {usesCodexOAuth && !sharedCodexLoginAvailable && !isCodexSharedAuthPending && (
        <Alert severity="warning">
          <Typography variant="body2">{translate('codex_bound_unavailable')}</Typography>
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        {sharedCodexLoginAvailable && (
          <Button
            variant={usesCodexOAuth ? 'outlined' : 'contained'}
            onClick={() => void handleCodexLogin('browser')}
            disabled={isCodexLoginPending || isCodexSharedLogoutPending}
          >
            {isCodexLoginPending
              ? translate('browser_signing_in')
              : translate('switch_account_browser')}
          </Button>
        )}
        <Button
          variant={sharedCodexLoginAvailable ? 'text' : usesCodexOAuth ? 'outlined' : 'contained'}
          onClick={() =>
            void (sharedCodexLoginAvailable
              ? handleCodexLogin('local')
              : handleCodexLogin('browser'))
          }
          disabled={isCodexLoginPending || isCodexSharedLogoutPending}
        >
          {isCodexLoginPending
            ? sharedCodexLoginAvailable
              ? translate('syncing')
              : translate('browser_signing_in')
            : sharedCodexLoginAvailable
              ? translate('sync_local_login')
              : translate('switch_account_browser')}
        </Button>
        {usesCodexOAuth && (
          <Button
            variant="text"
            color="inherit"
            onClick={handleDisconnectCodexProfile}
            disabled={isCodexLoginPending || isCodexSharedLogoutPending}
          >
            {translate('disconnect_configuration')}
          </Button>
        )}
        {showSharedCodexLogout && (
          <Button
            variant="text"
            color="inherit"
            onClick={() => void handleSignOutSharedCodexLogin()}
            disabled={isCodexLoginPending || isCodexSharedLogoutPending}
          >
            {isCodexSharedLogoutPending
              ? translate('signing_out_local_login')
              : translate('sign_out_local_login')}
          </Button>
        )}
      </Box>
      {codexLoginError && (
        <Alert severity="error">
          <Typography variant="body2">{codexLoginError}</Typography>
        </Alert>
      )}

      {showCodexQuota && (
        <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'background.paper' }}>
          <Stack spacing={0.75}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 1,
                flexWrap: 'wrap'
              }}
            >
              <Typography variant="body2" fontWeight={600}>
                {translate('codex_quota')}
              </Typography>
              <Button
                size="small"
                variant="text"
                color="inherit"
                onClick={() => void loadCodexUsage()}
                disabled={isCodexUsagePending}
              >
                {isCodexUsagePending ? translate('refreshing') : translate('refresh_quota')}
              </Button>
            </Box>

            {codexUsage?.planType && (
              <Typography variant="body2">
                {translate('plan')}: {formatCodexPlanLabel(codexUsage.planType, isChineseUi)}
              </Typography>
            )}
            {codexUsage?.rateLimit?.primaryWindow && (
              <CodexQuotaWindowCard
                translate={translate}
                isLight={false}
                isChineseUi={isChineseUi}
                quotaWindow={codexUsage.rateLimit.primaryWindow}
              />
            )}
            {codexUsage?.rateLimit?.secondaryWindow && (
              <CodexQuotaWindowCard
                translate={translate}
                isLight={false}
                isChineseUi={isChineseUi}
                quotaWindow={codexUsage.rateLimit.secondaryWindow}
              />
            )}
            {codexUsage?.credits && (
              <Typography variant="body2">
                {translate('credits')}:{' '}
                {codexUsage.credits.unlimited
                  ? translate('unlimited')
                  : typeof codexUsage.credits.balance === 'number'
                    ? codexUsage.credits.balance
                    : translate('unknown')}
              </Typography>
            )}
            {codexUsageError && (
              <Alert severity="warning">
                <Typography variant="body2">{codexUsageError}</Typography>
              </Alert>
            )}
          </Stack>
        </Box>
      )}
    </Stack>
  )
}

const findMatchingAgentCodexProfile = (
  profile: LLMAPIProfile,
  agentCodexProfiles: LLMAPIProfile[]
): LLMAPIProfile | undefined =>
  agentCodexProfiles.find((agentProfile) => agentProfile.id === profile.id) ||
  agentCodexProfiles.find((agentProfile) => agentProfile.model_name === profile.model_name) ||
  (agentCodexProfiles.length === 1 ? agentCodexProfiles[0] : undefined)

const syncQAppApiProfilesWithAgentCodex = (
  pluginProfiles: LLMAPIProfile[],
  agentProfiles: LLMAPIProfile[]
): LLMAPIProfile[] => {
  const agentCodexProfiles = agentProfiles.filter(isCodexOAuthProfile)
  if (agentCodexProfiles.length === 0) {
    return pluginProfiles
  }

  return pluginProfiles.map((profile) => {
    if (isCodexOAuthProfile(profile) || profile.api_key?.trim()) {
      return profile
    }

    const agentCodexProfile = findMatchingAgentCodexProfile(profile, agentCodexProfiles)
    if (!agentCodexProfile) {
      return profile
    }

    return {
      ...profile,
      model_name: agentCodexProfile.model_name || profile.model_name,
      base_url: agentCodexProfile.base_url || OFFICIAL_OPENAI_BASE_URL,
      api_key: '',
      auth_mode: 'codex_oauth',
      auth_account_email: agentCodexProfile.auth_account_email,
      auth_connected_at: agentCodexProfile.auth_connected_at,
      codex_fast_mode: agentCodexProfile.codex_fast_mode !== false
    }
  })
}

export const syncQAppApiProfilesWithAgentCodexForTests = syncQAppApiProfilesWithAgentCodex

export const codexRendererExtension: RendererHostExtensionApiV1 = {
  chat: {
    hasThreadImageTool(config, profileId) {
      return !!resolveCodexThreadImageCapability(config, profileId)
    },
    resolveAssistantImageAutoSaveDir(options) {
      const projectId = resolveProjectIdFromStorageScope(options.storageScope)
      if (!projectId) {
        return undefined
      }

      return resolveProjectResourceDir({
        config: options.config,
        projectId,
        segments: ['AutoSave', 'Agent']
      })
    },
    async discoverModelNames(profile) {
      if (!isCLIProxyAPIProfile(profile) && !isCodexOAuthProfile(profile)) {
        return undefined
      }
      const catalog = await api().svcCodexModels.list(
        isCLIProxyAPIProfile(profile)
          ? { cliProxyProfileId: profile.id }
          : { currentModelName: profile.model_name }
      )
      return catalog.models.map((model) => model.value)
    },
    resolveReasoningPreferenceKey(_profileId, profile) {
      return profile?.auth_mode === 'codex_oauth' ? 'codex' : undefined
    }
  },
  settings: {
    applyAgentApiProfileCallType(options) {
      if (options.callType === 'cliproxyapi') {
        return applyCLIProxyAPICallTypeToProfile(options.profile)
      }

      if (options.callType === 'codex') {
        return applyCodexCallTypeToProfile(options.profile)
      }

      return applyNonCodexCallTypeToCodexProfile(options.profile, options.callType)
    },
    buildAgentApiProfileCallTypeOptions(options) {
      return insertCodexCallTypeOption(options.baseOptions)
    },
    resolveAgentApiProfileUi(options) {
      return resolveCodexProfileUi(options.profile, options.baseUi)
    },
    renderAgentApiProfileCardExtra(options) {
      return (
        <Stack spacing={2}>
          <CodexImageProfileSelector {...options} />
          {isCodexProfile(options.profile) && <CodexAgentProfileExtra {...options} />}
        </Stack>
      )
    },
    buildQuickAppLegacyHunyuanProfile(settingsValue: Config): LLMAPIProfile | null {
      const legacy = settingsValue.aigc3d_config
      const legacyKeyPrefix = legacy?.cos_key_prefix?.trim() || ''
      const hasCustomKeyPrefix = Boolean(
        legacyKeyPrefix && legacyKeyPrefix !== DEFAULT_HY3D_COS_PREFIX
      )

      if (
        !legacy ||
        !(
          legacy.tencent_secret_id?.trim() ||
          legacy.tencent_secret_key?.trim() ||
          legacy.api_region?.trim() ||
          legacy.cos_bucket?.trim() ||
          legacy.cos_region?.trim() ||
          hasCustomKeyPrefix
        )
      ) {
        return null
      }

      return {
        id: 'legacy-hunyuan3d-profile',
        model_name: 'Hunyuan3D Pro',
        base_url: HUNYUAN_AI3D_BASE_URL,
        api_key: '',
        call_type: 'api',
        provider: 'default',
        model_use: 'default',
        tencent_secret_id: legacy.tencent_secret_id || '',
        tencent_secret_key: legacy.tencent_secret_key || '',
        api_region: legacy.api_region || '',
        cos_bucket: legacy.cos_bucket || '',
        cos_region: legacy.cos_region || '',
        cos_key_prefix: legacy.cos_key_prefix || DEFAULT_HY3D_COS_PREFIX,
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false
      }
    },
    buildClearedQuickAppLegacyHunyuanConfig() {
      return {
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_bucket: '',
        cos_region: '',
        cos_key_prefix: DEFAULT_HY3D_COS_PREFIX
      }
    },
    getQuickAppApiProfilesSectionAction(options) {
      if (!options.effectivePluginProfiles.some(isCodexProfile)) {
        return null
      }

      return (
        <Button
          color="inherit"
          onClick={() =>
            options.savePluginProfiles(
              options.effectivePluginProfiles.map((profile) =>
                isCodexProfile(profile) ? stripCodexOAuthConnectionProfile(profile) : profile
              )
            )
          }
          size="small"
          variant="text"
        >
          {getCodexText(options.isChineseUi, 'disconnect_codex_login')}
        </Button>
      )
    },
    isQuickAppLegacyHunyuanProfile: isHunyuan3DCompatibleProfile,
    prepareClonedQuickAppProfile(_sourceProfile, clonedProfile) {
      return stripCodexFastModeProfile(clonedProfile)
    },
    resolveQuickAppApiProfileLists(options) {
      return {
        pluginProfileCards: syncQAppApiProfilesWithAgentCodex(
          options.effectivePluginProfiles,
          options.settingsValue.llm_config?.api_profiles ?? []
        ),
        qAppProfiles: getQAppApiProfiles(options.settingsValue)
      }
    }
  }
}
