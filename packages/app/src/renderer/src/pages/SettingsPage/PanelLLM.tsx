/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Alert, Box, Button, IconButton, Stack, TextField, Typography } from '@mui/material'
import { Add as AddIcon, Delete } from '@mui/icons-material'
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import InputPath from '@renderer/components/inputs/InputPath'
import InputText from '@renderer/components/inputs/InputText'
import InputTextArea from '@renderer/components/inputs/InputTextArea'
import InputSelect from '@renderer/components/inputs/InputSelect'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import SettingSection from './components/SettingSection'
import type { PanelProps } from './PanelProps'
import { isHunyuan3DCompatibleProfile } from '@shared/config/apiProfileSelectors'
import {
  getSuggestedModelCatalog,
  isOllamaUrl,
  isLocalBaseUrl,
  resolveProfileCallType,
  resolveProfileDeployment,
  resolveProfileModelUse,
  resolveProfileProvider,
  type ModelCatalogOption
} from '@shared/llm'
import type {
  Config,
  CustomSkill,
  LLMAPIProfile,
  LLMProfileCallType,
  LLMDeployment,
  LLMModelUse,
  LLMModelUseOption,
  LLMProvider
} from '@shared/config/config'
import {
  createEmptyDuplicateCheckVisualModel,
  type DuplicateCheckVisualModelConfig
} from '@shared/duplicateCheck/types'
import type { DeepPartial } from '@shared/utils/utilTypes'

export type SaveSettings = (value: DeepPartial<Config>) => void

const DEFAULT_PROVIDER_OPTION = 'default' as const
const DEFAULT_MODEL_USE_OPTION = 'default' as const
const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const HUNYUAN_AI3D_BASE_URL = 'https://api.ai3d.cloud.tencent.com'
const DEFAULT_HY3D_COS_PREFIX = 'magicpot/hunyuan3d'
const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'
const LOCAL_DUPLICATE_CHECK_MODEL_ID_PREFIX = 'agent-local:'
type ProfileCallTypeSelectValue = LLMProfileCallType | 'hunyuan3d'

export const createEmptyProfile = (): LLMAPIProfile => ({
  id: crypto.randomUUID(),
  model_name: '',
  base_url: '',
  api_key: '',
  provider: DEFAULT_PROVIDER_OPTION,
  model_use: DEFAULT_MODEL_USE_OPTION,
  is_ollama: false,
  is_vision_model: false,
  is_ocr_model: false
})

export const createEmptyCustomSkill = (): CustomSkill => ({
  id: crypto.randomUUID(),
  category: '',
  skillName: '',
  prompt: '',
  type: 'normal',
  apiKey: '',
  apiAddress: ''
})

const normalizeSkillText = (value: string | null | undefined): string => value?.trim() || ''

export const getCustomSkillValidationIssues = (skill: CustomSkill): string[] => {
  const issues: string[] = []

  if (!normalizeSkillText(skill.category)) {
    issues.push('Category is required.')
  }
  if (!normalizeSkillText(skill.skillName)) {
    issues.push('Skill Name is required.')
  }
  if (!normalizeSkillText(skill.prompt)) {
    issues.push('Prompt is required.')
  }
  if (skill.type === 'agent' && !normalizeSkillText(skill.apiAddress)) {
    issues.push('Agent skills require an API Address.')
  }

  return issues
}

const upsertProfile = (
  profiles: LLMAPIProfile[],
  profileId: string,
  nextProfile: LLMAPIProfile
): LLMAPIProfile[] => profiles.map((profile) => (profile.id === profileId ? nextProfile : profile))

const normalizeSkillCategory = (value: string | null | undefined): string => value?.trim() || ''

const listManagedCategories = (skills: CustomSkill[]): string[] =>
  [...new Set(skills.map((skill) => normalizeSkillCategory(skill.category)).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  )

const replaceSkillCategory = (
  skills: CustomSkill[],
  currentCategory: string,
  nextCategory: string
): CustomSkill[] =>
  skills.map((skill) =>
    normalizeSkillCategory(skill.category) === currentCategory
      ? { ...skill, category: nextCategory }
      : skill
  )

const getDefaultProviderForDeployment = (_deployment: LLMDeployment): LLMProvider => 'openai'

const getSuggestedBaseUrl = (provider: LLMProvider, deployment: LLMDeployment): string => {
  if (provider === 'ollama') {
    return 'http://localhost:11434'
  }

  if (deployment === 'local') {
    return 'http://127.0.0.1:8000/v1'
  }

  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'claude':
      return 'https://api.anthropic.com/v1'
    case 'openai':
    default:
      return OFFICIAL_OPENAI_BASE_URL
  }
}

const applyModelUseToProfile = (profile: LLMAPIProfile, modelUse: LLMModelUse): LLMAPIProfile => ({
  ...profile,
  model_use: modelUse,
  is_vision_model:
    modelUse === 'agent' ||
    modelUse === 'multimodal' ||
    modelUse === 'vision' ||
    modelUse === 'ocr',
  is_ocr_model: modelUse === 'ocr'
})

const normalizeLocalModelPath = (value: string | null | undefined): string => value?.trim() || ''

const hasOnnxLocalModelPath = (value: string | null | undefined): boolean =>
  /\.onnx$/i.test(normalizeLocalModelPath(value))

const stripLocalModelProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const { local_model_path: _localModelPath, ...nextProfile } = profile
  return nextProfile
}

const stripExternalAuthProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const {
    auth_mode: _authMode,
    auth_account_email: _authAccountEmail,
    auth_connected_at: _authConnectedAt,
    ...nextProfile
  } = profile

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

const applyHunyuan3DPresetToProfile = (profile: LLMAPIProfile): LLMAPIProfile => ({
  ...stripLocalModelProfile(stripExternalAuthProfile(profile)),
  call_type: undefined,
  model_name: isHunyuan3DCompatibleProfile(profile)
    ? profile.model_name?.trim() || 'Hunyuan3D Pro'
    : 'Hunyuan3D Pro',
  base_url: HUNYUAN_AI3D_BASE_URL,
  api_key: profile.api_key || '',
  backup_api_keys: undefined,
  provider: DEFAULT_PROVIDER_OPTION,
  deployment: undefined,
  model_use: DEFAULT_MODEL_USE_OPTION,
  is_ollama: false,
  is_vision_model: false,
  is_ocr_model: false,
  tencent_secret_id: profile.tencent_secret_id || '',
  tencent_secret_key: profile.tencent_secret_key || '',
  api_region: profile.api_region || DEFAULT_HY3D_API_REGION,
  cos_bucket: profile.cos_bucket || '',
  cos_region: profile.cos_region || DEFAULT_HY3D_API_REGION,
  cos_key_prefix: profile.cos_key_prefix || DEFAULT_HY3D_COS_PREFIX
})

const normalizeHy3dCosPrefix = (value?: string): string =>
  value?.trim().replace(/^\/+|\/+$/g, '') || DEFAULT_HY3D_COS_PREFIX

const applyCallTypeToProfile = (
  profile: LLMAPIProfile,
  callType: ProfileCallTypeSelectValue
): LLMAPIProfile => {
  switch (callType) {
    case 'local':
      return {
        ...stripHunyuan3DProfile(stripExternalAuthProfile(profile)),
        call_type: 'local',
        base_url: '',
        api_key: '',
        backup_api_keys: undefined,
        is_ollama: false,
        provider: DEFAULT_PROVIDER_OPTION,
        deployment: undefined,
        local_model_path: normalizeLocalModelPath(profile.local_model_path)
      }
    case 'hunyuan3d':
      return applyHunyuan3DPresetToProfile(profile)
    case 'api':
    default:
      return {
        ...stripHunyuan3DProfile(stripLocalModelProfile(stripExternalAuthProfile(profile))),
        call_type: undefined,
        local_model_path: undefined
      }
  }
}

const isSyncedLocalDuplicateCheckModel = (
  model: Pick<DuplicateCheckVisualModelConfig, 'id'>
): boolean => model.id.startsWith(LOCAL_DUPLICATE_CHECK_MODEL_ID_PREFIX)

const buildSyncedLocalDuplicateCheckModel = (
  profile: LLMAPIProfile,
  existingModel?: DuplicateCheckVisualModelConfig
): DuplicateCheckVisualModelConfig => {
  const baseModel = existingModel || createEmptyDuplicateCheckVisualModel()
  const localModelPath = normalizeLocalModelPath(profile.local_model_path)

  return {
    ...baseModel,
    id: `${LOCAL_DUPLICATE_CHECK_MODEL_ID_PREFIX}${profile.id}`,
    name: profile.model_name.trim() || existingModel?.name || 'Local Vision Model',
    modelPath: localModelPath,
    enabled: hasOnnxLocalModelPath(localModelPath) ? (existingModel?.enabled ?? true) : false
  }
}

const syncDuplicateCheckVisualModelsFromProfiles = (
  existingModels: DuplicateCheckVisualModelConfig[],
  profiles: LLMAPIProfile[]
): DuplicateCheckVisualModelConfig[] => {
  const existingSyncedModels = new Map(
    existingModels
      .filter(isSyncedLocalDuplicateCheckModel)
      .map((model) => [model.id, model] as const)
  )
  const preservedManualModels = existingModels.filter(
    (model) => !isSyncedLocalDuplicateCheckModel(model)
  )
  const syncedLocalModels = profiles
    .filter((profile) => resolveProfileCallType(profile) === 'local')
    .filter((profile) => hasOnnxLocalModelPath(profile.local_model_path))
    .map((profile) =>
      buildSyncedLocalDuplicateCheckModel(
        profile,
        existingSyncedModels.get(`${LOCAL_DUPLICATE_CHECK_MODEL_ID_PREFIX}${profile.id}`)
      )
    )

  return [...preservedManualModels, ...syncedLocalModels]
}

const useApiProfiles = (
  profiles: LLMAPIProfile[],
  duplicateCheckVisualModels: DuplicateCheckVisualModelConfig[],
  saveSettings: SaveSettings
) => {
  const saveProfiles = (nextProfiles: LLMAPIProfile[]) => {
    const nextVisualModels = syncDuplicateCheckVisualModelsFromProfiles(
      duplicateCheckVisualModels,
      nextProfiles
    )
    const shouldSyncDuplicateCheckVisualModels =
      nextVisualModels.length !== duplicateCheckVisualModels.length ||
      nextVisualModels.some(
        (model, index) =>
          JSON.stringify(model) !== JSON.stringify(duplicateCheckVisualModels[index])
      ) ||
      nextProfiles.some((profile) => resolveProfileCallType(profile) === 'local') ||
      duplicateCheckVisualModels.some(isSyncedLocalDuplicateCheckModel)

    saveSettings({
      llm_config: {
        api_profiles: nextProfiles
      },
      ...(shouldSyncDuplicateCheckVisualModels
        ? {
            plugin_config: {
              duplicateCheck: {
                visualModels: nextVisualModels
              }
            }
          }
        : {})
    })
  }

  const handleSetApiProfile = (profileId: string, nextProfile: LLMAPIProfile) => {
    saveProfiles(upsertProfile(profiles, profileId, nextProfile))
  }

  const handleDeleteApiProfile = (profileId: string) => {
    saveProfiles(profiles.filter((profile) => profile.id !== profileId))
  }

  const handleAddApiProfile = () => {
    saveProfiles([...profiles, createEmptyProfile()])
  }

  const handleCloneApiProfile = (profile: LLMAPIProfile) => {
    saveProfiles([
      ...profiles,
      {
        ...stripExternalAuthProfile(profile),
        id: crypto.randomUUID(),
        api_key: ''
      }
    ])
  }

  return {
    handleSetApiProfile,
    handleDeleteApiProfile,
    handleAddApiProfile,
    handleCloneApiProfile
  }
}

type BackupKeysEditorProps = {
  profile: LLMAPIProfile
  onChange: (nextProfile: LLMAPIProfile) => void
  t: ReturnType<typeof useTranslation>['t']
}

const BackupKeysEditor: React.FC<BackupKeysEditorProps> = ({ profile, onChange, t }) => (
  <>
    {(profile.backup_api_keys || []).map((backupKey, index) => (
      <Box
        key={`${profile.id}-backup-${index}`}
        sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}
      >
        <InputText
          label={`${t('llm.backup_key')} ${index + 1}`}
          value={backupKey}
          onChange={(value) => {
            const nextBackupKeys = [...(profile.backup_api_keys || [])]
            nextBackupKeys[index] = value
            onChange({ ...profile, backup_api_keys: nextBackupKeys })
          }}
          placeholder={t('llm.api_key_placeholder')}
        />
        <IconButton
          size="small"
          color="error"
          onClick={() => {
            const nextBackupKeys = (profile.backup_api_keys || []).filter((_, i) => i !== index)
            onChange({
              ...profile,
              backup_api_keys: nextBackupKeys.length > 0 ? nextBackupKeys : undefined
            })
          }}
          sx={{ mb: 0.5 }}
        >
          <Delete fontSize="small" />
        </IconButton>
      </Box>
    ))}
  </>
)

type ApiProfileCardProps = {
  onClone: (profile: LLMAPIProfile) => void
  onDelete: (profileId: string) => void
  onUpdate: (profileId: string, nextProfile: LLMAPIProfile) => void
  profile: LLMAPIProfile
  isChineseUi: boolean
  t: ReturnType<typeof useTranslation>['t']
}

const ApiProfileCard: React.FC<ApiProfileCardProps> = ({
  onClone,
  onDelete,
  onUpdate,
  profile,
  isChineseUi,
  t
}) => {
  const theme = useTheme()
  const { notifyInfo, notifySuccess, notifyWarning, closeMessage } = useMessage()
  const isLight = theme.palette.mode === 'light'
  const copy = (chinese: string, english: string) => (isChineseUi ? chinese : english)
  const quickAppText = React.useCallback(
    (key: string, defaultValue: string, values: Record<string, string | number> = {}) =>
      t(`quickapp_api.${key}`, { defaultValue, ...values }),
    [t]
  )
  const resolvedProfileCallType = resolveProfileCallType(profile)
  const isHunyuan3DCallType =
    resolvedProfileCallType !== 'local' && isHunyuan3DCompatibleProfile(profile)
  const profileCallType: ProfileCallTypeSelectValue = isHunyuan3DCallType
    ? 'hunyuan3d'
    : resolvedProfileCallType
  const effectiveDeployment = resolveProfileDeployment(profile)
  const effectiveProvider =
    resolveProfileProvider(profile) || getDefaultProviderForDeployment(effectiveDeployment)
  const effectiveModelUse = resolveProfileModelUse(profile)
  const usesVisualCapabilities =
    effectiveModelUse === 'agent' ||
    effectiveModelUse === 'multimodal' ||
    effectiveModelUse === 'vision' ||
    effectiveModelUse === 'ocr'
  const modelUseSelectValue =
    profile.model_use === DEFAULT_MODEL_USE_OPTION ? DEFAULT_MODEL_USE_OPTION : effectiveModelUse
  const isLocalCallType = profileCallType === 'local'
  const showApiKeyInput = !isLocalCallType && effectiveProvider !== 'ollama'
  const showBackupKeys =
    !isLocalCallType &&
    !isHunyuan3DCallType &&
    effectiveDeployment === 'cloud' &&
    effectiveProvider !== 'ollama'
  const showBaseUrlInput = !isLocalCallType
  const baseUrlPlaceholder = isHunyuan3DCallType
    ? HUNYUAN_AI3D_BASE_URL
    : getSuggestedBaseUrl(effectiveProvider, effectiveDeployment)
  const apiKeyPlaceholder = isHunyuan3DCallType
    ? quickAppText('hunyuan_api_key_placeholder', 'Optional Hunyuan3D API Key')
    : effectiveProvider === 'ollama'
      ? copy('Ollama 本地服务无需密钥', 'No API key needed for Ollama')
      : effectiveDeployment === 'local'
        ? copy('本地服务如无鉴权可留空', 'Optional for local servers without auth')
        : isChineseUi
          ? '请输入 API 密钥'
          : t('llm.api_key_placeholder')
  const modelNamePlaceholder = isLocalCallType
    ? copy('例如：本地 CLIP 模型', 'e.g. Local CLIP Model')
    : effectiveProvider === 'ollama'
      ? usesVisualCapabilities
        ? 'qwen2.5vl:7b'
        : 'llama3.2'
      : usesVisualCapabilities
        ? copy('例如：qwen2.5-vl-7b-instruct', 'e.g. qwen2.5-vl-7b-instruct')
        : effectiveModelUse === 'image'
          ? copy('例如：gpt-5.4', 'e.g. gpt-5.4')
          : t('llm.model_name_placeholder')

  const modelUseOptions = [
    { label: copy('默认', 'Default'), value: DEFAULT_MODEL_USE_OPTION },
    { label: copy('对话', 'Chat'), value: 'chat' },
    { label: copy('通用智能体', 'General Agent'), value: 'agent' },
    { label: copy('多模态', 'Multimodal'), value: 'multimodal' },
    { label: copy('视觉', 'Vision'), value: 'vision' },
    { label: 'OCR', value: 'ocr' },
    { label: copy('图像生成', 'Image Generation'), value: 'image' }
  ]
  const callTypeOptions = [
    { label: copy('API模型', 'API Model'), value: 'api' },
    { label: 'Hunyuan3D', value: 'hunyuan3d' },
    { label: copy('本地模型', 'Local Model'), value: 'local' }
  ]
  const localModelPath = normalizeLocalModelPath(profile.local_model_path)
  const localModelPathErrorText =
    localModelPath.length > 0 && !hasOnnxLocalModelPath(localModelPath)
      ? copy(
          '当前仅支持 .onnx 格式的本地模型。',
          'Only .onnx local models are supported right now.'
        )
      : undefined
  const configuredHy3dSecretId = profile.tencent_secret_id?.trim() || ''
  const configuredHy3dSecretKey = profile.tencent_secret_key?.trim() || ''
  const configuredHy3dBucket = profile.cos_bucket?.trim() || ''
  const configuredHy3dRegion = profile.cos_region?.trim() || ''
  const effectiveHy3dKeyPrefix = normalizeHy3dCosPrefix(profile.cos_key_prefix)
  const canClearHy3dCosPrefix = Boolean(
    configuredHy3dSecretId &&
    configuredHy3dSecretKey &&
    configuredHy3dBucket &&
    configuredHy3dRegion
  )
  const [isClearingHy3dCosPrefix, setIsClearingHy3dCosPrefix] = React.useState(false)

  const updateProfile = (nextProfile: LLMAPIProfile) => {
    const nextCallType = resolveProfileCallType(nextProfile)
    if (nextCallType === 'local') {
      onUpdate(profile.id, {
        ...stripHunyuan3DProfile(stripExternalAuthProfile(nextProfile)),
        call_type: 'local',
        base_url: '',
        api_key: '',
        backup_api_keys: undefined,
        provider: DEFAULT_PROVIDER_OPTION,
        deployment: undefined,
        is_ollama: false,
        local_model_path: normalizeLocalModelPath(nextProfile.local_model_path)
      })
      return
    }

    const preserveLegacyOllamaOverride =
      profile.provider === 'ollama' || nextProfile.provider === 'ollama'
    const nextBaseUrl = nextProfile.base_url || ''
    const inferredLocal = isOllamaUrl(nextBaseUrl) || isLocalBaseUrl(nextBaseUrl)
    const normalizedNextProfile: LLMAPIProfile = {
      ...stripLocalModelProfile(nextProfile),
      call_type: undefined
    }
    const normalizedProfile = stripExternalAuthProfile(normalizedNextProfile)

    onUpdate(profile.id, {
      ...normalizedProfile,
      call_type: normalizedNextProfile.call_type,
      provider: DEFAULT_PROVIDER_OPTION,
      deployment: undefined,
      is_ollama:
        inferredLocal &&
        (isOllamaUrl(nextBaseUrl) ||
          Boolean(normalizedProfile.is_ollama) ||
          preserveLegacyOllamaOverride)
    })
  }

  const applyModelUseOptionToProfile = (
    nextProfile: LLMAPIProfile,
    modelUse: LLMModelUseOption
  ): LLMAPIProfile =>
    modelUse === DEFAULT_MODEL_USE_OPTION
      ? {
          ...nextProfile,
          model_use: DEFAULT_MODEL_USE_OPTION,
          is_vision_model: false,
          is_ocr_model: false
        }
      : applyModelUseToProfile(nextProfile, modelUse)

  const commitModelName = React.useCallback(
    (nextModelName: string) => {
      if (nextModelName === profile.model_name) {
        return
      }

      updateProfile({
        ...profile,
        model_name: nextModelName
      })
    },
    [profile, updateProfile]
  )

  const handleClearHy3dCosPrefix = React.useCallback(async () => {
    const dialogResult = await api().svcDialog.showMessageBox({
      type: 'warning',
      title: quickAppText('clear_cos_dialog_title', 'Clear Hunyuan3D COS Cache'),
      message: quickAppText(
        'clear_cos_dialog_message',
        'This will delete all objects under the current Hunyuan3D prefix and cannot be undone.'
      ),
      detail: [
        `Bucket: ${configuredHy3dBucket}`,
        `Region: ${configuredHy3dRegion}`,
        `Prefix: ${effectiveHy3dKeyPrefix}`
      ].join('\n'),
      buttons: [
        quickAppText('clear_cos_cancel', 'Cancel'),
        quickAppText('clear_cos_confirm', 'Clear')
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (dialogResult.response !== 1) {
      return
    }

    const messageKey = notifyInfo(
      quickAppText('clear_cos_progress', 'Clearing Hunyuan3D COS cache...'),
      null
    )
    setIsClearingHy3dCosPrefix(true)

    try {
      const result = await api().svcLLMProxy.clearHy3DCosPrefix({ profileId: profile.id })

      if (result.matchedCount === 0) {
        notifySuccess(
          quickAppText('clear_cos_empty', 'No objects were found under the current prefix.')
        )
      } else if (result.errorCount > 0) {
        notifyWarning(
          quickAppText(
            'clear_cos_partial',
            'Deleted {{deletedCount}} objects, but {{errorCount}} objects failed to delete.',
            { deletedCount: result.deletedCount, errorCount: result.errorCount }
          )
        )
      } else {
        notifySuccess(
          quickAppText('clear_cos_success', 'Cleared {{deletedCount}} objects.', {
            deletedCount: result.deletedCount
          })
        )
      }
    } catch (error) {
      notifyWarning(
        error instanceof Error
          ? error.message
          : quickAppText('clear_cos_failed', 'Failed to clear the Hunyuan3D COS cache.')
      )
    } finally {
      setIsClearingHy3dCosPrefix(false)
      closeMessage(messageKey)
    }
  }, [
    closeMessage,
    configuredHy3dBucket,
    configuredHy3dRegion,
    effectiveHy3dKeyPrefix,
    notifyInfo,
    notifySuccess,
    notifyWarning,
    profile.id,
    quickAppText
  ])

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: 2,
        bgcolor: isLight ? '#eef0f7' : '#1d1d1d'
      }}
    >
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {profile.model_name || copy('Agent线程配置', t('llm.profile_title'))}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Button size="small" variant="text" onClick={() => onClone(profile)}>
              {copy('复制', 'Clone')}
            </Button>
            <IconButton size="small" onClick={() => onDelete(profile.id)}>
              <Delete fontSize="small" />
            </IconButton>
          </Box>
        </Box>

        <InputSelect
          label={copy('调用类型', 'Call Type')}
          value={profileCallType}
          onChange={(value) =>
            updateProfile(applyCallTypeToProfile(profile, value as ProfileCallTypeSelectValue))
          }
          items={callTypeOptions}
        />

        <InputSelect
          label={copy('应用场景', 'Capability')}
          value={modelUseSelectValue}
          onChange={(value) =>
            updateProfile(applyModelUseOptionToProfile(profile, value as LLMModelUseOption))
          }
          items={modelUseOptions}
        />

        <InputText
          label={copy('模型名称', t('llm.model_name'))}
          value={profile.model_name}
          onChange={commitModelName}
          placeholder={modelNamePlaceholder}
          shrinkLabel
        />

        {isLocalCallType && (
          <InputPath
            label={copy('模型地址', 'Model Path')}
            value={localModelPath}
            onChange={(value) => updateProfile({ ...profile, local_model_path: value })}
            pathType="file"
            placeholder="D:\\models\\vision\\model.onnx"
            errorText={localModelPathErrorText}
          />
        )}

        {isLocalCallType && (
          <Alert severity={hasOnnxLocalModelPath(localModelPath) ? 'success' : 'info'}>
            <Typography variant="body2">
              {hasOnnxLocalModelPath(localModelPath)
                ? copy(
                    '该本地模型会自动同步到当前检查功能的视觉模型列表，可用于 CLIP / CNN 视觉检查。',
                    'This local model will be synced into the current check feature visual-model list for CLIP / CNN style visual checks.'
                  )
                : copy(
                    '当前本地模型仅接入检查功能，支持调用 CLIP 模型和 CNN 视觉模型，且必须使用 ONNX 格式。',
                    'Local models currently plug into the check feature only. CLIP models and CNN vision models are supported, and they must use ONNX format.'
                  )}
            </Typography>
          </Alert>
        )}

        {showBaseUrlInput && (
          <InputText
            label={copy('API 地址', t('llm.base_url'))}
            value={profile.base_url}
            onChange={(value) => updateProfile({ ...profile, base_url: value })}
            placeholder={baseUrlPlaceholder}
            shrinkLabel
          />
        )}

        {showApiKeyInput && (
          <InputText
            label={
              isHunyuan3DCallType
                ? quickAppText('hunyuan_api_key_optional', 'Hunyuan3D API Key (Optional)')
                : effectiveDeployment === 'local'
                  ? copy('API 密钥（可选）', 'API Key (Optional)')
                  : copy('API 密钥', t('llm.api_key'))
            }
            value={profile.api_key}
            onChange={(value) =>
              updateProfile({
                ...stripExternalAuthProfile(profile),
                api_key: value
              })
            }
            placeholder={apiKeyPlaceholder}
            shrinkLabel
          />
        )}

        {isHunyuan3DCallType && (
          <>
            <Alert severity="info">
              <Typography variant="body2">
                {quickAppText(
                  'hunyuan_profile_credentials_info',
                  'Tencent SecretId/SecretKey are used for Hunyuan3D jobs and COS uploads. The Hunyuan3D API Key is optional and only used by supported API flows.'
                )}
              </Typography>
            </Alert>
            <InputText
              label={quickAppText('tencent_secret_id', 'Tencent SecretId')}
              value={profile.tencent_secret_id || ''}
              onChange={(value) => updateProfile({ ...profile, tencent_secret_id: value })}
              placeholder="AKID..."
              shrinkLabel
              updateMode="change"
            />
            <InputText
              label={quickAppText('tencent_secret_key', 'Tencent SecretKey')}
              value={profile.tencent_secret_key || ''}
              onChange={(value) => updateProfile({ ...profile, tencent_secret_key: value })}
              placeholder={quickAppText(
                'tencent_secret_key_placeholder',
                'Please enter the SecretKey'
              )}
              shrinkLabel
              updateMode="change"
            />
            <InputText
              label={quickAppText('api_region', 'Tencent API Region')}
              value={profile.api_region || ''}
              onChange={(value) => updateProfile({ ...profile, api_region: value })}
              placeholder={DEFAULT_HY3D_API_REGION}
              shrinkLabel
              updateMode="change"
            />
            <Typography color="text.secondary" variant="caption">
              {quickAppText(
                'api_region_hint',
                `When left empty, MagicPot uses ${DEFAULT_HY3D_API_REGION}.`
              )}
            </Typography>
            <InputText
              label={quickAppText('cos_bucket', 'COS Bucket')}
              value={profile.cos_bucket || ''}
              onChange={(value) => updateProfile({ ...profile, cos_bucket: value })}
              placeholder="examplebucket-1250000000"
              shrinkLabel
              updateMode="change"
            />
            <InputText
              label={quickAppText('cos_region', 'COS Region')}
              value={profile.cos_region || ''}
              onChange={(value) => updateProfile({ ...profile, cos_region: value })}
              placeholder={DEFAULT_HY3D_API_REGION}
              shrinkLabel
              updateMode="change"
            />
            <InputText
              label={quickAppText('cos_key_prefix', 'COS Key Prefix')}
              value={profile.cos_key_prefix || DEFAULT_HY3D_COS_PREFIX}
              onChange={(value) => updateProfile({ ...profile, cos_key_prefix: value })}
              placeholder={DEFAULT_HY3D_COS_PREFIX}
              shrinkLabel
              updateMode="change"
            />
            <Alert severity="warning">
              <Typography variant="body2">
                {quickAppText(
                  'clear_cos_hint',
                  'The clear button removes objects only under the current prefix, not the entire bucket.'
                )}
              </Typography>
            </Alert>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                color="warning"
                disabled={!canClearHy3dCosPrefix || isClearingHy3dCosPrefix}
                onClick={() => void handleClearHy3dCosPrefix()}
                startIcon={<DeleteSweepOutlinedIcon />}
                variant="outlined"
              >
                {isClearingHy3dCosPrefix
                  ? quickAppText('clear_cos_loading', 'Clearing...')
                  : quickAppText('clear_cos_button', 'Clear Current Prefix')}
              </Button>
              <Typography color="text.secondary" variant="body2">
                {`Prefix: ${effectiveHy3dKeyPrefix}`}
              </Typography>
            </Box>
            {!canClearHy3dCosPrefix && (
              <Typography color="text.secondary" variant="caption">
                {quickAppText(
                  'clear_cos_requirements',
                  'SecretId, SecretKey, COS bucket, and COS region are required before clearing.'
                )}
              </Typography>
            )}
          </>
        )}

        {showBackupKeys && (
          <>
            <BackupKeysEditor profile={profile} onChange={updateProfile} t={t} />
            <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
              <Button
                size="small"
                variant="text"
                startIcon={<AddIcon />}
                onClick={() =>
                  updateProfile({
                    ...profile,
                    backup_api_keys: [...(profile.backup_api_keys || []), '']
                  })
                }
              >
                {copy('添加备用密钥', t('llm.add_backup_key'))}
              </Button>
            </Box>
          </>
        )}
        {effectiveModelUse === 'ocr' && (
          <Alert severity="info">
            <Typography variant="body2">
              {copy(
                'OCR 模型建议返回文本、表格文件或结构化 JSON，后续可以直接接到聊天附件和画布。',
                'OCR profiles work best when they return text, table files, or structured JSON that can later flow into chat attachments and canvas.'
              )}
            </Typography>
          </Alert>
        )}
      </Stack>
    </Box>
  )
}

type ApiProfilesSectionProps = {
  action?: React.ReactNode
  onAdd: () => void
  onClone: (profile: LLMAPIProfile) => void
  onDelete: (profileId: string) => void
  onUpdate: (profileId: string, nextProfile: LLMAPIProfile) => void
  profiles: LLMAPIProfile[]
  isChineseUi: boolean
  t: ReturnType<typeof useTranslation>['t']
  title?: string
}

export const ApiProfilesSection: React.FC<ApiProfilesSectionProps> = ({
  action,
  onAdd,
  onClone,
  onDelete,
  onUpdate,
  profiles,
  isChineseUi,
  t,
  title
}) => {
  return (
    <SettingSection
      action={action}
      title={title || (isChineseUi ? 'Agent线程配置' : t('llm.profile_title'))}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 3
        }}
      >
        {profiles.map((profile) => (
          <ApiProfileCard
            key={profile.id}
            onClone={onClone}
            onDelete={onDelete}
            onUpdate={onUpdate}
            profile={profile}
            isChineseUi={isChineseUi}
            t={t}
          />
        ))}
      </Box>

      <Button
        variant="text"
        size="large"
        color="inherit"
        disableElevation
        onClick={onAdd}
        fullWidth
        sx={{ mt: 2 }}
      >
        {isChineseUi ? '添加配置' : t('llm.add_api_profile')}
      </Button>
    </SettingSection>
  )
}

type CustomSkillCardProps = {
  onDelete: (skillId: string) => void
  onUpdate: (skillId: string, nextSkill: CustomSkill) => void
  validationIssues: string[]
  skill: CustomSkill
  isChineseUi: boolean
}

const CustomSkillCard: React.FC<CustomSkillCardProps> = ({
  onDelete,
  onUpdate,
  skill,
  isChineseUi,
  validationIssues
}) => {
  const updateSkill = (nextSkill: CustomSkill) => onUpdate(skill.id, nextSkill)
  const copy = (chinese: string, english: string) => (isChineseUi ? chinese : english)

  return (
    <Box
      data-testid={`custom-skill-card-${skill.id}`}
      sx={{
        p: 2,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}
    >
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {skill.skillName || copy('未命名技能', 'Custom Skill')}
          </Typography>
          <IconButton size="small" onClick={() => onDelete(skill.id)}>
            <Delete fontSize="small" />
          </IconButton>
        </Box>

        <InputText
          label={copy('分类', 'Category')}
          value={skill.category}
          onChange={(value) => updateSkill({ ...skill, category: value })}
          placeholder={copy('美术 / 运营 / 设计', 'Art / Ops / Design')}
        />
        <InputText
          label={copy('技能名称', 'Skill Name')}
          value={skill.skillName}
          onChange={(value) => updateSkill({ ...skill, skillName: value })}
          placeholder={copy('故事板智能体', 'Storyboard Agent')}
        />
        <InputSelect
          label={copy('技能类型', 'Skill Type')}
          value={skill.type}
          onChange={(value) => updateSkill({ ...skill, type: value as CustomSkill['type'] })}
          items={[
            { label: copy('普通技能', 'Normal Skill'), value: 'normal' },
            { label: copy('智能体技能', 'Agent Skill'), value: 'agent' }
          ]}
        />
        <InputTextArea
          label={copy('提示词', 'Prompt')}
          value={skill.prompt}
          onChange={(value) => updateSkill({ ...skill, prompt: value })}
          placeholder={copy(
            '选中该技能时会作为系统提示词附加到当前对话。',
            'Bound as the system prompt when this skill is selected.'
          )}
          rows={5}
        />

        {skill.type === 'agent' && (
          <>
            <InputText
              label={copy('API 地址', 'API Address')}
              value={skill.apiAddress || ''}
              onChange={(value) => updateSkill({ ...skill, apiAddress: value })}
              placeholder={copy('https://example.com/api/chat', 'https://example.com/api/chat')}
            />
            <InputText
              label={copy('API 密钥', 'API Key')}
              value={skill.apiKey || ''}
              onChange={(value) => updateSkill({ ...skill, apiKey: value })}
              placeholder={copy('可选的 Bearer Token', 'Optional bearer token')}
            />
          </>
        )}

        {validationIssues.length > 0 && (
          <Alert severity="warning">
            <Typography variant="body2">
              {copy('技能未填写完整：', 'Incomplete skill: ')}
              {validationIssues.join(' ')}
            </Typography>
          </Alert>
        )}
      </Stack>
    </Box>
  )
}

type CustomSkillsSectionProps = {
  onAdd: () => void
  onDelete: (skillId: string) => void
  onReplaceSkills: (nextSkills: CustomSkill[]) => void
  onUpdate: (skillId: string, nextSkill: CustomSkill) => void
  skills: CustomSkill[]
  isChineseUi: boolean
}

const CustomSkillCategoriesSection: React.FC<{
  onReplaceSkills: (nextSkills: CustomSkill[]) => void
  skills: CustomSkill[]
  isChineseUi: boolean
}> = ({ onReplaceSkills, skills, isChineseUi }) => {
  const categories = listManagedCategories(skills)
  const copy = (chinese: string, english: string) => (isChineseUi ? chinese : english)

  if (categories.length === 0) {
    return null
  }

  return (
    <Box
      data-testid="custom-skill-categories-section"
      sx={{
        p: 2,
        mb: 3,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}
    >
      <Stack spacing={2}>
        <Typography variant="subtitle2" fontWeight={600}>
          {copy('分类', 'Categories')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {copy(
            '修改一次分类名或清空分类后，这个分类下的所有技能都会同步更新。也可以继续在任意技能卡片里直接创建新分类。',
            'Rename or clear a category once and the change applies to every skill in that group. New categories can still be created directly from any skill card.'
          )}
        </Typography>

        {categories.map((category) => {
          const skillCount = skills.filter(
            (skill) => normalizeSkillCategory(skill.category) === category
          ).length

          return (
            <Box key={category} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Box sx={{ flex: 1 }}>
                <InputText
                  label={copy('分类', 'Category')}
                  value={category}
                  onChange={(value) =>
                    onReplaceSkills(replaceSkillCategory(skills, category, value))
                  }
                  placeholder={copy('美术 / 运营 / 设计', 'Art / Ops / Design')}
                />
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56 }}>
                {copy(`${skillCount} 个技能`, `${skillCount} skills`)}
              </Typography>
              <IconButton
                size="small"
                onClick={() => onReplaceSkills(replaceSkillCategory(skills, category, ''))}
              >
                <Delete fontSize="small" />
              </IconButton>
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}

export const CustomSkillsSection: React.FC<CustomSkillsSectionProps> = ({
  onAdd,
  onDelete,
  onReplaceSkills,
  onUpdate,
  skills,
  isChineseUi
}) => {
  const invalidSkills = skills
    .map((skill) => ({
      skill,
      issues: getCustomSkillValidationIssues(skill)
    }))
    .filter(({ issues }) => issues.length > 0)

  return (
    <SettingSection title={isChineseUi ? '自定义技能' : 'Custom Skills'}>
      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography variant="body2">
          {isChineseUi
            ? '普通技能会把提示词附加到当前 Agent 对话；智能体技能会开启新的对话，并且只把请求发送到它配置的 API 地址。'
            : 'Normal skills bind a prompt to the current Agent conversation. Agent skills create a fresh conversation and route requests only to their configured API endpoint.'}
        </Typography>
      </Alert>

      {invalidSkills.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography variant="body2">
            {isChineseUi
              ? `有 ${invalidSkills.length} 个技能未填写完整，请先补全再使用。`
              : `${invalidSkills.length} skill${invalidSkills.length > 1 ? 's are' : ' is'} incomplete and should be filled in before use.`}
          </Typography>
        </Alert>
      )}

      <CustomSkillCategoriesSection
        isChineseUi={isChineseUi}
        onReplaceSkills={onReplaceSkills}
        skills={skills}
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 3
        }}
      >
        {skills.map((skill) => (
          <CustomSkillCard
            key={skill.id}
            isChineseUi={isChineseUi}
            onDelete={onDelete}
            onUpdate={onUpdate}
            skill={skill}
            validationIssues={getCustomSkillValidationIssues(skill)}
          />
        ))}
      </Box>

      <Button
        variant="text"
        size="large"
        color="inherit"
        disableElevation
        onClick={onAdd}
        fullWidth
        sx={{ mt: 2 }}
      >
        {isChineseUi ? '添加自定义技能' : 'Add Custom Skill'}
      </Button>
    </SettingSection>
  )
}

const PanelLLM: React.FC<PanelProps> = ({ settingsValue, saveSettings }) => {
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const {
    handleSetApiProfile,
    handleDeleteApiProfile,
    handleAddApiProfile,
    handleCloneApiProfile
  } = useApiProfiles(
    settingsValue.llm_config.api_profiles,
    settingsValue.plugin_config?.duplicateCheck?.visualModels ?? [],
    saveSettings
  )

  return (
    <Box sx={{ p: 3 }}>
      {!settingsValue.use_remote_llm && (
        <ApiProfilesSection
          onAdd={handleAddApiProfile}
          onClone={handleCloneApiProfile}
          onDelete={handleDeleteApiProfile}
          onUpdate={handleSetApiProfile}
          isChineseUi={isChineseUi}
          profiles={settingsValue.llm_config.api_profiles}
          t={t}
        />
      )}
    </Box>
  )
}

export default PanelLLM
