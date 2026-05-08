import React from 'react'
import { Box, Stack, Alert, Typography, Collapse, Divider, Button } from '@mui/material'
import SettingSection from './components/SettingSection'
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import InputTextArea from '@renderer/components/inputs/InputTextArea'
import InputText from '@renderer/components/inputs/InputText'
import InputSelect from '@renderer/components/inputs/InputSelect'
import InputNumber from '@renderer/components/inputs/InputNumber'
import InputPath from '@renderer/components/inputs/InputPath'
import { PanelProps } from './PanelProps'
import { useTranslation } from 'react-i18next'
import { LLMAPIProfile } from '@shared/config/config'
import { getQAppApiProfiles, isVisionCapableApiProfile } from '@shared/config/apiProfileSelectors'
import { ApiProfilesSection, createEmptyProfile } from './PanelLLM'
import { getQAppPromptSettings } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppPromptSettings'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import {
  createEmptyDuplicateCheckVisualModel,
  DEFAULT_DUPLICATE_CHECK_SETTINGS,
  DUPLICATE_CHECK_THRESHOLD_PRESETS,
  type DuplicateCheckSettings,
  type DuplicateCheckVisualModelConfig
} from '@shared/duplicateCheck/types'

type SaveSettings = PanelProps['saveSettings']

const upsertProfile = (
  profiles: LLMAPIProfile[],
  profileId: string,
  nextProfile: LLMAPIProfile
): LLMAPIProfile[] => profiles.map((profile) => (profile.id === profileId ? nextProfile : profile))

const stripExternalAuthProfile = (profile: LLMAPIProfile): LLMAPIProfile => {
  const {
    auth_mode: _authMode,
    auth_account_email: _authAccountEmail,
    auth_connected_at: _authConnectedAt,
    ...nextProfile
  } = profile

  return nextProfile
}

type HunyuanSectionProps = {
  saveSettings: SaveSettings
  settingsValue: PanelProps['settingsValue']
}

const DEFAULT_HY3D_COS_PREFIX = 'magicpot/hunyuan3d'
const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'

const quickAppSectionSurfaceSx = {
  borderRadius: 3,
  bgcolor: (theme) => (theme.palette.mode === 'light' ? '#eef0f7' : '#1d1d1d'),
  overflow: 'hidden'
}

const quickAppSectionPaneSx = {
  px: { xs: 2, sm: 2.5 },
  py: 2.5
}

const quickAppSectionDividerSx = {
  borderColor: (theme) =>
    theme.palette.mode === 'light' ? 'rgba(17, 24, 39, 0.08)' : 'rgba(255, 255, 255, 0.06)'
}

type DuplicateCheckSectionProps = {
  saveSettings: SaveSettings
  settingsValue: PanelProps['settingsValue']
}

const normalizeDuplicateCheckSettings = (
  value?: Partial<DuplicateCheckSettings>
): DuplicateCheckSettings => ({
  ...DEFAULT_DUPLICATE_CHECK_SETTINGS,
  ...value,
  defaultMethods:
    value?.defaultMethods && value.defaultMethods.length > 0
      ? value.defaultMethods
      : DEFAULT_DUPLICATE_CHECK_SETTINGS.defaultMethods,
  imageExtensions:
    value?.imageExtensions && value.imageExtensions.length > 0
      ? value.imageExtensions
      : DEFAULT_DUPLICATE_CHECK_SETTINGS.imageExtensions,
  visualModels: value?.visualModels ?? DEFAULT_DUPLICATE_CHECK_SETTINGS.visualModels
})

const DuplicateCheckSection: React.FC<DuplicateCheckSectionProps> = ({
  saveSettings,
  settingsValue
}) => {
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const qt = React.useCallback(
    (key: string, fallback: string) => {
      const value = t(key)
      return isChineseUi && value === key ? fallback : value
    },
    [isChineseUi, t]
  )

  const duplicateSettings = React.useMemo(
    () => normalizeDuplicateCheckSettings(settingsValue.plugin_config?.duplicateCheck),
    [settingsValue.plugin_config?.duplicateCheck]
  )

  const saveDuplicateCheckSettings = React.useCallback(
    (next: Partial<DuplicateCheckSettings>) => {
      saveSettings({
        plugin_config: {
          duplicateCheck: next
        }
      })
    },
    [saveSettings]
  )

  const toggleDefaultMethod = React.useCallback(
    (method: DuplicateCheckSettings['defaultMethods'][number], enabled: boolean) => {
      const nextMethods = enabled
        ? Array.from(new Set([...duplicateSettings.defaultMethods, method]))
        : duplicateSettings.defaultMethods.filter((value) => value !== method)

      saveDuplicateCheckSettings({
        defaultMethods: nextMethods.length > 0 ? nextMethods : ['hash']
      })
    },
    [duplicateSettings.defaultMethods, saveDuplicateCheckSettings]
  )

  const updateVisualModel = React.useCallback(
    (modelId: string, nextPartial: Partial<DuplicateCheckVisualModelConfig>) => {
      saveDuplicateCheckSettings({
        visualModels: duplicateSettings.visualModels.map((model) =>
          model.id === modelId ? { ...model, ...nextPartial } : model
        )
      })
    },
    [duplicateSettings.visualModels, saveDuplicateCheckSettings]
  )

  const updateVisualModelVectorValue = React.useCallback(
    (modelId: string, key: 'mean' | 'std', index: number, nextValue: number) => {
      const target = duplicateSettings.visualModels.find((model) => model.id === modelId)
      if (!target) {
        return
      }

      const nextVector = [...(target[key] || [0.5, 0.5, 0.5])]
      nextVector[index] = nextValue
      updateVisualModel(modelId, { [key]: nextVector })
    },
    [duplicateSettings.visualModels, updateVisualModel]
  )

  const presetSummary = DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset]

  return (
    <SettingSection title={qt('quickapp_api.duplicate_check_title', '检查')}>
      <Box sx={quickAppSectionSurfaceSx}>
        <Stack divider={<Divider sx={quickAppSectionDividerSx} />} spacing={0}>
          <Box sx={quickAppSectionPaneSx}>
            <Alert severity="info">
              <Typography variant="body2">
                {qt(
                  'quickapp_api.duplicate_check_info',
                  '检查应用会与图像、视频、3D 并列显示。这里可以配置默认检查策略、缓存、GPU/CUDA 与 ONNX 视觉模型。'
                )}
              </Typography>
            </Alert>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_enabled', '启用重复图检查')}
                value={duplicateSettings.enabled}
                onChange={(value) => saveDuplicateCheckSettings({ enabled: value })}
              />
              <InputSelect
                label={qt('quickapp_api.duplicate_check_default_preset', '默认阈值预设')}
                value={duplicateSettings.defaultPreset}
                onChange={(value) =>
                  saveDuplicateCheckSettings({
                    defaultPreset: value as DuplicateCheckSettings['defaultPreset']
                  })
                }
                items={[
                  {
                    label: qt('quickapp_api.duplicate_check_preset_strict', '严格'),
                    value: 'strict'
                  },
                  {
                    label: qt('quickapp_api.duplicate_check_preset_balanced', '平衡'),
                    value: 'balanced'
                  },
                  {
                    label: qt('quickapp_api.duplicate_check_preset_loose', '宽松'),
                    value: 'loose'
                  }
                ]}
              />
              <Typography color="text.secondary" variant="caption">
                {qt(
                  'quickapp_api.duplicate_check_preset_summary',
                  `当前预设：哈希 ${presetSummary.hashDistance} / 疑似哈希 ${presetSummary.uncertainHashDistance} / 视觉 ${presetSummary.visualSimilarity.toFixed(2)} / 鲁棒性 ${presetSummary.robustnessSimilarity.toFixed(2)}`
                )}
              </Typography>
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_method_hash', '默认启用哈希检查')}
                value={duplicateSettings.defaultMethods.includes('hash')}
                onChange={(value) => toggleDefaultMethod('hash', value)}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_method_visual', '默认启用视觉模型检查')}
                value={duplicateSettings.defaultMethods.includes('visual')}
                onChange={(value) => toggleDefaultMethod('visual', value)}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_method_robust', '默认启用鲁棒性复核')}
                value={duplicateSettings.defaultMethods.includes('robust')}
                onChange={(value) => toggleDefaultMethod('robust', value)}
              />
            </Stack>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_use_cache', '启用缓存')}
                value={duplicateSettings.enableCache}
                onChange={(value) => saveDuplicateCheckSettings({ enableCache: value })}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_recursive', '默认递归扫描子目录')}
                value={duplicateSettings.recursiveScan}
                onChange={(value) => saveDuplicateCheckSettings({ recursiveScan: value })}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_image_only', '默认只扫描图片文件')}
                value={duplicateSettings.imageOnlyScan}
                onChange={(value) => saveDuplicateCheckSettings({ imageOnlyScan: value })}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_exclude_self', '默认排除自身')}
                value={duplicateSettings.excludeSelf}
                onChange={(value) => saveDuplicateCheckSettings({ excludeSelf: value })}
              />
              <InputPath
                label={qt('quickapp_api.duplicate_check_cache_dir', '缓存目录')}
                value={duplicateSettings.cacheDir || ''}
                onChange={(value) => saveDuplicateCheckSettings({ cacheDir: value })}
                pathType="directory"
                placeholder={qt(
                  'quickapp_api.duplicate_check_cache_dir_placeholder',
                  '留空则使用应用默认缓存目录'
                )}
              />
              <InputText
                label={qt('quickapp_api.duplicate_check_extensions', '图片扩展名')}
                value={duplicateSettings.imageExtensions.join(', ')}
                onChange={(value) =>
                  saveDuplicateCheckSettings({
                    imageExtensions: value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean)
                  })
                }
                placeholder=".png, .jpg, .jpeg, .webp"
              />
            </Stack>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_gpu', '启用 GPU / CUDA 加速')}
                value={duplicateSettings.gpuAcceleration}
                onChange={(value) => saveDuplicateCheckSettings({ gpuAcceleration: value })}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_fallback_cpu', 'GPU 不可用时自动回退 CPU')}
                value={duplicateSettings.fallbackToCpu}
                onChange={(value) => saveDuplicateCheckSettings({ fallbackToCpu: value })}
              />
              <InputSwitch
                label={qt('quickapp_api.duplicate_check_reuse_python', '复用 ComfyUI Python 环境')}
                value={duplicateSettings.reuseComfyPython}
                onChange={(value) => saveDuplicateCheckSettings({ reuseComfyPython: value })}
              />
              <Collapse in={!duplicateSettings.reuseComfyPython}>
                <Box sx={{ pt: 1 }}>
                  <InputPath
                    label={qt('quickapp_api.duplicate_check_python_override', 'Python 命令路径')}
                    value={duplicateSettings.pythonCommandOverride || ''}
                    onChange={(value) =>
                      saveDuplicateCheckSettings({ pythonCommandOverride: value })
                    }
                    pathType="file"
                    placeholder={qt(
                      'quickapp_api.duplicate_check_python_placeholder',
                      '选择包含 onnxruntime 的 Python 可执行文件'
                    )}
                  />
                </Box>
              </Collapse>
              <InputNumber
                label={qt('quickapp_api.duplicate_check_max_concurrency', '并发数')}
                value={duplicateSettings.maxConcurrency}
                min={1}
                max={32}
                step={1}
                onChange={(value) => saveDuplicateCheckSettings({ maxConcurrency: value })}
              />
              <InputNumber
                label={qt('quickapp_api.duplicate_check_batch_size', '视觉模型批大小')}
                value={duplicateSettings.batchSize}
                min={1}
                max={128}
                step={1}
                onChange={(value) => saveDuplicateCheckSettings({ batchSize: value })}
              />
            </Stack>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2.5}>
              <Box
                sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}
              >
                <Typography variant="subtitle1" fontWeight={700}>
                  {qt('quickapp_api.duplicate_check_visual_models', '视觉模型（ONNX）')}
                </Typography>
                <Button
                  variant="outlined"
                  onClick={() =>
                    saveDuplicateCheckSettings({
                      visualModels: [
                        ...duplicateSettings.visualModels,
                        createEmptyDuplicateCheckVisualModel()
                      ]
                    })
                  }
                >
                  {qt('quickapp_api.duplicate_check_add_model', '添加视觉模型')}
                </Button>
              </Box>
              <Alert severity={duplicateSettings.visualModels.length > 0 ? 'success' : 'warning'}>
                <Typography variant="body2">
                  {duplicateSettings.visualModels.length > 0
                    ? qt(
                        'quickapp_api.duplicate_check_visual_models_ready',
                        '已配置视觉模型后，检查页就可以启用视觉相似度与鲁棒性复核。'
                      )
                    : qt(
                        'quickapp_api.duplicate_check_visual_models_empty',
                        '还没有可用的 ONNX 视觉模型。添加模型后即可参与检查。'
                      )}
                </Typography>
              </Alert>

              {duplicateSettings.visualModels.map((model, index) => (
                <Box
                  key={model.id}
                  sx={(theme) => ({
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: theme.palette.divider,
                    p: 2
                  })}
                >
                  <Stack spacing={2}>
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 2,
                        flexWrap: 'wrap'
                      }}
                    >
                      <Typography variant="subtitle2" fontWeight={700}>
                        {qt('quickapp_api.duplicate_check_model_item', `模型 ${index + 1}`)}
                      </Typography>
                      <Button
                        color="error"
                        variant="text"
                        onClick={() =>
                          saveDuplicateCheckSettings({
                            visualModels: duplicateSettings.visualModels.filter(
                              (item) => item.id !== model.id
                            )
                          })
                        }
                      >
                        {qt('quickapp_api.duplicate_check_remove_model', '删除模型')}
                      </Button>
                    </Box>
                    <InputSwitch
                      label={qt('quickapp_api.duplicate_check_model_enabled', '启用该模型')}
                      value={model.enabled}
                      onChange={(value) => updateVisualModel(model.id, { enabled: value })}
                    />
                    <InputText
                      label={qt('quickapp_api.duplicate_check_model_name', '模型名称')}
                      value={model.name}
                      onChange={(value) => updateVisualModel(model.id, { name: value })}
                      placeholder="CLIP ViT-B/32"
                    />
                    <InputPath
                      label={qt('quickapp_api.duplicate_check_model_path', 'ONNX 模型路径')}
                      value={model.modelPath}
                      onChange={(value) => updateVisualModel(model.id, { modelPath: value })}
                      pathType="file"
                      placeholder="D:\\models\\duplicate-check\\model.onnx"
                    />
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                      <Box sx={{ flex: 1 }}>
                        <InputNumber
                          label={qt('quickapp_api.duplicate_check_model_input_size', '输入尺寸')}
                          value={model.inputSize}
                          min={32}
                          max={2048}
                          step={1}
                          onChange={(value) => updateVisualModel(model.id, { inputSize: value })}
                        />
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <InputNumber
                          label={qt(
                            'quickapp_api.duplicate_check_model_embedding_dim',
                            'Embedding 维度'
                          )}
                          value={model.embeddingDim || 0}
                          min={0}
                          max={32768}
                          step={1}
                          onChange={(value) => updateVisualModel(model.id, { embeddingDim: value })}
                        />
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <InputNumber
                          label={qt('quickapp_api.duplicate_check_model_threshold', '默认视觉阈值')}
                          value={model.defaultThreshold || presetSummary.visualSimilarity}
                          min={0}
                          max={1}
                          step={0.01}
                          onChange={(value) =>
                            updateVisualModel(model.id, { defaultThreshold: value })
                          }
                        />
                      </Box>
                    </Stack>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                      <Box sx={{ flex: 1 }}>
                        <InputText
                          label={qt('quickapp_api.duplicate_check_model_input_name', '输入张量名')}
                          value={model.inputName || ''}
                          onChange={(value) => updateVisualModel(model.id, { inputName: value })}
                          placeholder={qt(
                            'quickapp_api.duplicate_check_model_input_name_placeholder',
                            '留空时自动读取第一个输入'
                          )}
                        />
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <InputText
                          label={qt('quickapp_api.duplicate_check_model_output_name', '输出张量名')}
                          value={model.outputName || ''}
                          onChange={(value) => updateVisualModel(model.id, { outputName: value })}
                          placeholder={qt(
                            'quickapp_api.duplicate_check_model_output_name_placeholder',
                            '留空时自动读取第一个输出'
                          )}
                        />
                      </Box>
                    </Stack>
                    <InputSwitch
                      label={qt(
                        'quickapp_api.duplicate_check_model_normalize',
                        '输出 embedding 后自动归一化'
                      )}
                      value={model.normalizeEmbedding !== false}
                      onChange={(value) =>
                        updateVisualModel(model.id, { normalizeEmbedding: value })
                      }
                    />
                    <Stack spacing={1}>
                      <Typography variant="body2" fontWeight={600}>
                        {qt('quickapp_api.duplicate_check_model_mean', 'Mean')}
                      </Typography>
                      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                        {[0, 1, 2].map((channel) => (
                          <Box key={`mean-${model.id}-${channel}`} sx={{ flex: 1 }}>
                            <InputNumber
                              label={`Mean ${channel + 1}`}
                              value={model.mean?.[channel] ?? 0.5}
                              min={-10}
                              max={10}
                              step={0.01}
                              onChange={(value) =>
                                updateVisualModelVectorValue(model.id, 'mean', channel, value)
                              }
                            />
                          </Box>
                        ))}
                      </Stack>
                    </Stack>
                    <Stack spacing={1}>
                      <Typography variant="body2" fontWeight={600}>
                        {qt('quickapp_api.duplicate_check_model_std', 'Std')}
                      </Typography>
                      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                        {[0, 1, 2].map((channel) => (
                          <Box key={`std-${model.id}-${channel}`} sx={{ flex: 1 }}>
                            <InputNumber
                              label={`Std ${channel + 1}`}
                              value={model.std?.[channel] ?? 0.5}
                              min={0.0001}
                              max={10}
                              step={0.01}
                              onChange={(value) =>
                                updateVisualModelVectorValue(model.id, 'std', channel, value)
                              }
                            />
                          </Box>
                        ))}
                      </Stack>
                    </Stack>
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Box>
        </Stack>
      </Box>
    </SettingSection>
  )
}

const normalizeHy3dCosPrefix = (value?: string): string =>
  value?.trim().replace(/^\/+|\/+$/g, '') || DEFAULT_HY3D_COS_PREFIX

const HunyuanSection: React.FC<HunyuanSectionProps> = ({ saveSettings, settingsValue }) => {
  const { t, i18n } = useTranslation()
  const { notifyInfo, notifySuccess, notifyWarning, closeMessage } = useMessage()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const [isClearingCosPrefix, setIsClearingCosPrefix] = React.useState(false)
  const qt = React.useCallback(
    (key: string, fallback: string) => {
      const value = t(key)
      return isChineseUi && value === key ? fallback : value
    },
    [isChineseUi, t]
  )

  const configuredSecretId = settingsValue.aigc3d_config?.tencent_secret_id?.trim() || ''
  const configuredSecretKey = settingsValue.aigc3d_config?.tencent_secret_key?.trim() || ''
  const configuredApiRegion = settingsValue.aigc3d_config?.api_region?.trim() || ''
  const configuredBucket = settingsValue.aigc3d_config?.cos_bucket?.trim() || ''
  const configuredRegion = settingsValue.aigc3d_config?.cos_region?.trim() || ''
  const configuredKeyPrefix = settingsValue.aigc3d_config?.cos_key_prefix || DEFAULT_HY3D_COS_PREFIX
  const effectiveKeyPrefix = normalizeHy3dCosPrefix(configuredKeyPrefix)
  const canClearCosPrefix = !!(
    configuredSecretId &&
    configuredSecretKey &&
    configuredBucket &&
    configuredRegion
  )

  const handleClearCosPrefix = React.useCallback(async () => {
    const dialogResult = await api().svcDialog.showMessageBox({
      type: 'warning',
      title: qt('quickapp_api.clear_cos_dialog_title', '清理 Hunyuan3D COS 缓存'),
      message: qt(
        'quickapp_api.clear_cos_dialog_message',
        '将删除当前 Hunyuan3D Prefix 下的所有对象，此操作不可恢复。'
      ),
      detail: [
        `Bucket: ${configuredBucket}`,
        `Region: ${configuredRegion}`,
        `Prefix: ${effectiveKeyPrefix}`
      ].join('\n'),
      buttons: [
        qt('quickapp_api.clear_cos_cancel', '取消'),
        qt('quickapp_api.clear_cos_confirm', '确认清理')
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (dialogResult.response !== 1) {
      return
    }

    const messageKey = notifyInfo(
      qt('quickapp_api.clear_cos_progress', '正在清理 Hunyuan3D COS 缓存...'),
      null
    )
    setIsClearingCosPrefix(true)

    try {
      const result = await api().svcLLMProxy.clearHy3DCosPrefix({})

      if (result.matchedCount === 0) {
        notifySuccess(qt('quickapp_api.clear_cos_empty', '当前 Prefix 下没有可清理的对象。'))
      } else if (result.errorCount > 0) {
        notifyWarning(
          t('quickapp_api.clear_cos_partial', {
            deletedCount: result.deletedCount,
            errorCount: result.errorCount,
            defaultValue: `已删除 ${result.deletedCount} 个对象，另有 ${result.errorCount} 个对象删除失败。`
          })
        )
      } else {
        notifySuccess(
          t('quickapp_api.clear_cos_success', {
            deletedCount: result.deletedCount,
            defaultValue: `已清理 ${result.deletedCount} 个对象。`
          })
        )
      }
    } catch (error) {
      notifyWarning(
        error instanceof Error
          ? error.message
          : qt('quickapp_api.clear_cos_failed', '清理 Hunyuan3D COS 缓存失败。')
      )
    } finally {
      setIsClearingCosPrefix(false)
      closeMessage(messageKey)
    }
  }, [
    closeMessage,
    configuredBucket,
    configuredRegion,
    effectiveKeyPrefix,
    notifyInfo,
    notifySuccess,
    notifyWarning,
    t,
    qt
  ])

  return (
    <SettingSection title={qt('quickapp_api.hunyuan_title', 'Hunyuan3D（快应用）')}>
      <Box sx={quickAppSectionSurfaceSx}>
        <Stack divider={<Divider sx={quickAppSectionDividerSx} />} spacing={0}>
          <Box sx={quickAppSectionPaneSx}>
            <Alert severity="info">
              <Typography variant="body2">
                {qt(
                  'quickapp_api.hunyuan_info',
                  '在右侧快应用面板中选择 Hunyuan3D。此处配置的腾讯云凭证会用于将上传的参考图转换为 3D 模型。'
                )}
              </Typography>
            </Alert>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <InputText
                label={qt('quickapp_api.tencent_secret_id', '腾讯云 SecretId')}
                value={settingsValue.aigc3d_config?.tencent_secret_id || ''}
                onChange={(value) => saveSettings({ aigc3d_config: { tencent_secret_id: value } })}
                placeholder="AKID..."
                updateMode="change"
              />
              <InputText
                label={qt('quickapp_api.tencent_secret_key', '腾讯云 SecretKey')}
                value={settingsValue.aigc3d_config?.tencent_secret_key || ''}
                onChange={(value) => saveSettings({ aigc3d_config: { tencent_secret_key: value } })}
                placeholder={qt('quickapp_api.tencent_secret_key_placeholder', '请输入 SecretKey')}
                updateMode="change"
              />
              <InputText
                label={qt('quickapp_api.api_region', '腾讯云 API 地域')}
                value={settingsValue.aigc3d_config?.api_region || ''}
                onChange={(value) => saveSettings({ aigc3d_config: { api_region: value } })}
                placeholder="ap-guangzhou"
                updateMode="change"
              />
              <Typography color="text.secondary" variant="caption">
                {qt('quickapp_api.api_region_hint', `留空时默认使用 ${DEFAULT_HY3D_API_REGION}。`)}
              </Typography>
            </Stack>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <InputText
                label={qt('quickapp_api.cos_bucket', 'COS Bucket')}
                value={settingsValue.aigc3d_config?.cos_bucket || ''}
                onChange={(value) => saveSettings({ aigc3d_config: { cos_bucket: value } })}
                placeholder="examplebucket-1250000000"
                updateMode="change"
              />
              <InputText
                label={qt('quickapp_api.cos_region', 'COS 地域')}
                value={settingsValue.aigc3d_config?.cos_region || ''}
                onChange={(value) => saveSettings({ aigc3d_config: { cos_region: value } })}
                placeholder="ap-guangzhou"
                updateMode="change"
              />
              <InputText
                label={qt('quickapp_api.cos_key_prefix', 'COS Key 前缀')}
                value={settingsValue.aigc3d_config?.cos_key_prefix || 'magicpot/hunyuan3d'}
                onChange={(value) => saveSettings({ aigc3d_config: { cos_key_prefix: value } })}
                placeholder="magicpot/hunyuan3d"
                updateMode="change"
              />
            </Stack>
          </Box>

          <Box sx={quickAppSectionPaneSx}>
            <Stack spacing={2}>
              <Alert severity="warning">
                <Typography variant="body2">
                  {qt(
                    'quickapp_api.clear_cos_hint',
                    '清理按钮只会删除当前 Prefix 下的对象，不会清空整个 Bucket。'
                  )}
                </Typography>
              </Alert>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  color="warning"
                  disabled={!canClearCosPrefix || isClearingCosPrefix}
                  onClick={() => void handleClearCosPrefix()}
                  startIcon={<DeleteSweepOutlinedIcon />}
                  variant="outlined"
                >
                  {isClearingCosPrefix
                    ? qt('quickapp_api.clear_cos_loading', '清理中...')
                    : qt('quickapp_api.clear_cos_button', '清理当前 Prefix')}
                </Button>
                <Typography color="text.secondary" variant="body2">
                  {`Prefix: ${effectiveKeyPrefix}`}
                </Typography>
              </Box>
              {!canClearCosPrefix && (
                <Typography color="text.secondary" variant="caption">
                  {qt(
                    'quickapp_api.clear_cos_requirements',
                    '填写 SecretId、SecretKey、COS Bucket 和 COS 地域后，才可以执行清理。'
                  )}
                </Typography>
              )}
            </Stack>
          </Box>
        </Stack>
      </Box>
    </SettingSection>
  )
}

const PanelPlugin: React.FC<PanelProps> = ({ settingsValue, saveSettings }: PanelProps) => {
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const pluginProfiles = React.useMemo(
    () => settingsValue.plugin_config?.api_profiles ?? [],
    [settingsValue.plugin_config?.api_profiles]
  )
  const pluginProfileCards = pluginProfiles
  const qAppProfiles = React.useMemo(() => getQAppApiProfiles(settingsValue), [settingsValue])
  const qt = React.useCallback(
    (key: string, fallback: string) => {
      const value = t(key)
      return isChineseUi && value === key ? fallback : value
    },
    [isChineseUi, t]
  )

  const savePluginProfiles = React.useCallback(
    (nextProfiles: LLMAPIProfile[]) => {
      saveSettings({
        plugin_config: {
          api_profiles: nextProfiles
        }
      })
    },
    [saveSettings]
  )

  const handleSetPluginApiProfile = React.useCallback(
    (profileId: string, nextProfile: LLMAPIProfile) => {
      savePluginProfiles(upsertProfile(pluginProfiles, profileId, nextProfile))
    },
    [pluginProfiles, savePluginProfiles]
  )

  const handleDeletePluginApiProfile = React.useCallback(
    (profileId: string) => {
      savePluginProfiles(pluginProfiles.filter((profile) => profile.id !== profileId))
    },
    [pluginProfiles, savePluginProfiles]
  )

  const handleAddPluginApiProfile = React.useCallback(() => {
    savePluginProfiles([...pluginProfiles, createEmptyProfile()])
  }, [pluginProfiles, savePluginProfiles])

  const handleClonePluginApiProfile = React.useCallback(
    (profile: LLMAPIProfile) => {
      savePluginProfiles([
        ...pluginProfiles,
        {
          ...stripExternalAuthProfile(profile),
          id: crypto.randomUUID(),
          api_key: ''
        }
      ])
    },
    [pluginProfiles, savePluginProfiles]
  )

  const apiProfileOptions = React.useMemo(() => {
    const profiles = qAppProfiles
    const options = profiles.map((p) => ({ label: p.model_name || 'Unnamed Model', value: p.id }))
    return [{ label: qt('quickapp_api.default_profile', '默认模型'), value: '' }, ...options]
  }, [qAppProfiles, qt])

  const visionProfileOptions = React.useMemo(() => {
    const profiles = qAppProfiles
    const options = profiles
      .filter(isVisionCapableApiProfile)
      .map((p) => ({ label: p.model_name || 'Unnamed Model', value: p.id }))
    return [{ label: qt('quickapp_api.default_profile', '默认模型'), value: '' }, ...options]
  }, [qAppProfiles, qt])

  const qAppPromptSettings = React.useMemo(
    () => getQAppPromptSettings(settingsValue),
    [settingsValue]
  )
  const showPluginInfoBanners = false

  return (
    <Box sx={{ p: 3 }}>
      {showPluginInfoBanners && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <Typography variant="body2">
            {qt(
              'quickapp_api.section_info',
              '快应用运行、快应用提示辅助和 Hunyuan3D 会优先使用这里配置的“快应用 API”档案；如果这里还没配，会自动复用 Agent API 档案。'
            )}
          </Typography>
        </Alert>
      )}
      {showPluginInfoBanners && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <Typography variant="body2">
            {qt(
              'quickapp_api.split_notice',
              '当前还没有单独配置快应用 API，所以快应用会暂时复用 Agent API 档案。如果你希望快应用单独使用别的模型，可以在这里额外添加。'
            )}
          </Typography>
        </Alert>
      )}

      {!settingsValue.use_remote_llm && (
        <ApiProfilesSection
          title={qt('quickapp_api.api_profiles_section', '快应用 API 设置')}
          onAdd={handleAddPluginApiProfile}
          onClone={handleClonePluginApiProfile}
          onDelete={handleDeletePluginApiProfile}
          onUpdate={handleSetPluginApiProfile}
          isChineseUi={isChineseUi}
          profiles={pluginProfileCards}
          t={t}
        />
      )}

      <Box sx={{ mt: 3 }}>
        <SettingSection title={qt('quickapp_api.prompt_title', '快应用 Prompt 输入设置')}>
          <Box sx={quickAppSectionSurfaceSx}>
            <Box sx={{ display: { xs: 'block', lg: 'flex' } }}>
              <Box sx={{ ...quickAppSectionPaneSx, flex: 1 }}>
                <InputSwitch
                  label={qt('quickapp_api.use_prompt_translation', '启用快应用 Prompt 翻译')}
                  value={qAppPromptSettings.usePromptTranslation}
                  onChange={(v) => saveSettings({ plugin_config: { usePromptTranslation: v } })}
                />
                <Collapse
                  in={qAppPromptSettings.usePromptTranslation && !settingsValue.use_remote_llm}
                >
                  <Stack spacing={2} sx={{ mt: 2 }}>
                    <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
                      <Typography variant="body2">
                        {qt(
                          'quickapp_api.translation_info_line1',
                          '启用后，快应用 Prompt 翻译会优先使用这里配置的模型。'
                        )}
                      </Typography>
                      <Typography variant="body2">
                        {qt(
                          'quickapp_api.translation_info_line3',
                          '{{ prompt }} 代表输入的非英文提示词。'
                        )}
                      </Typography>
                    </Alert>
                    <InputSelect
                      label={qt('quickapp_api.select_profile', '选择模型（留空则使用默认）')}
                      value={qAppPromptSettings.promptTranslationProfileId || ''}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { promptTranslationProfileId: v } })
                      }
                      items={apiProfileOptions}
                    />
                    <InputTextArea
                      label={qt('quickapp_api.prompt_translation_system_prompt', 'System Prompt')}
                      value={qAppPromptSettings.promptTranslationSystemPrompt}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { promptTranslationSystemPrompt: v } })
                      }
                      placeholder=""
                      rows={4}
                    />
                    <InputTextArea
                      label={qt('quickapp_api.prompt_translation_user_prompt', 'User Prompt')}
                      value={qAppPromptSettings.promptTranslationUserPrompt}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { promptTranslationUserPrompt: v } })
                      }
                      placeholder=""
                      rows={3}
                    />
                  </Stack>
                </Collapse>
              </Box>

              <Divider sx={{ ...quickAppSectionDividerSx, display: { xs: 'block', lg: 'none' } }} />
              <Divider
                orientation="vertical"
                flexItem
                sx={{ ...quickAppSectionDividerSx, display: { xs: 'none', lg: 'block' } }}
              />

              <Box sx={{ ...quickAppSectionPaneSx, flex: 1 }}>
                <InputSwitch
                  label={qt('quickapp_api.use_image_interrogation', '启用快应用图片反推')}
                  value={qAppPromptSettings.useImageInterrogation}
                  onChange={(v) => saveSettings({ plugin_config: { useImageInterrogation: v } })}
                />
                <Collapse
                  in={qAppPromptSettings.useImageInterrogation && !settingsValue.use_remote_llm}
                >
                  <Stack spacing={2} sx={{ mt: 2 }}>
                    <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
                      <Typography variant="body2">
                        {qt(
                          'quickapp_api.interrogation_info_line1',
                          '启用后，快应用图片反推会优先使用这里配置的模型。'
                        )}
                      </Typography>
                      <Typography variant="body2">
                        {qt('quickapp_api.interrogation_info_line3', '至少需要配置一个视觉模型。')}
                      </Typography>
                    </Alert>
                    <InputSelect
                      label={qt('quickapp_api.select_profile', '选择模型（留空则使用默认）')}
                      value={qAppPromptSettings.imageInterrogationProfileId || ''}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { imageInterrogationProfileId: v } })
                      }
                      items={visionProfileOptions}
                    />
                    <InputTextArea
                      label={qt('quickapp_api.image_interrogation_system_prompt', 'System Prompt')}
                      value={qAppPromptSettings.imageInterrogationSystemPrompt}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { imageInterrogationSystemPrompt: v } })
                      }
                      placeholder={qt(
                        'quickapp_api.image_interrogation_system_prompt_placeholder',
                        '输入用于反推快应用图片提示词的 Prompt'
                      )}
                      rows={4}
                    />
                    <InputTextArea
                      label={qt('quickapp_api.image_interrogation_user_prompt', 'User Prompt')}
                      value={qAppPromptSettings.imageInterrogationUserPrompt}
                      onChange={(v) =>
                        saveSettings({ plugin_config: { imageInterrogationUserPrompt: v } })
                      }
                      placeholder={qt(
                        'quickapp_api.image_interrogation_user_prompt_placeholder',
                        '输入图片反推时使用的 user prompt（可选）'
                      )}
                      rows={3}
                    />
                  </Stack>
                </Collapse>
              </Box>
            </Box>
          </Box>
        </SettingSection>
      </Box>

      <Box sx={{ mt: 3 }}>
        <DuplicateCheckSection saveSettings={saveSettings} settingsValue={settingsValue} />
      </Box>

      {!settingsValue.use_remote_llm && (
        <Box sx={{ mt: 3 }}>
          <HunyuanSection saveSettings={saveSettings} settingsValue={settingsValue} />
        </Box>
      )}
    </Box>
  )
}

export default PanelPlugin
