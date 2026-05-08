/* eslint-disable react/prop-types */
// packages/app/src/renderer/src/pages/SettingsPage/PanelEnvironment.tsx
import {
  Box,
  Typography,
  Button,
  Stack,
  MenuItem,
  Alert,
  AlertTitle,
  Divider,
  TextField
} from '@mui/material'
import { Code as CodeIcon, Folder as FolderIcon, Refresh as RefreshIcon } from '@mui/icons-material'
import { PanelProps } from './PanelProps'
import SettingSection from './components/SettingSection'
import EnvironmentInfo from './components/EnvironmentInfo'
import DataStorageInfo from './components/DataStorageInfo'
import PureConfigNotSetCallout from '@renderer/components/PureConfigNotSetCallout'
import InputPath from '@renderer/components/inputs/InputPath'
import { ConfigUtils } from '@shared/config/configUtils'
import {
  Config,
  DEFAULT_CLIP_DIR,
  DEFAULT_CHECKPOINTS_DIR,
  DEFAULT_CONTROLNET_DIR,
  DEFAULT_DIFFUSION_MODELS_DIR,
  DEFAULT_LORA_DIR,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_UNET_DIR,
  DEFAULT_UPSCALE_MODELS_DIR,
  DEFAULT_VAE_DIR,
  DEFAULT_WORKFLOW_DIR,
  type LLMProxyAccessTokenEntry
} from '@shared/config/config'
import type { CanvasFigmaBinding } from '@shared/figma'
import InputText from '@renderer/components/inputs/InputText'
import { splitSpace } from '@shared/utils/utilFuncs'
import { FastSettingTemplate } from '@shared/api/svcHyper'
import type { LlmProxyAccessUsageSnapshot } from '@shared/api/svcState'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { DropdownButton } from '@renderer/components/DropdownButton'
import { FastSettingErrorModal } from './components/FastSettingErrorModal'
import { DeepPartial } from '@shared/utils/utilTypes'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import RemoteConfigNotSetCallout from '@renderer/components/RemoteConfigNotSetCallout'
import { useConfig } from '@renderer/hooks/useConfig'
import { useTranslation } from 'react-i18next'
import { useAppSelector } from '@renderer/store'
import FigmaBindingDialog from '@renderer/pages/ProjectCanvasPage/Dialogs/FigmaBindingDialog'
import { loadCanvasItems, saveCanvasItems } from '@renderer/pages/ProjectCanvasPage/canvasStorage'
import { getCanvasItemsBounds } from '@renderer/pages/ProjectCanvasPage/projectCanvasPageShared'
import type {
  CanvasGroup,
  CanvasGroupBranch,
  CanvasImageItem,
  CanvasItem
} from '@renderer/pages/ProjectCanvasPage/types'

type ProxyModeSectionProps = {
  saveSettings: PanelProps['saveSettings']
  settingsValue: PanelProps['settingsValue']
  t: ReturnType<typeof useTranslation>['t']
  text: (fallbackChinese: string, fallbackEnglish: string) => string
}

type ManagedCanvasSnapshot = {
  canvasId: string
  canvasLabel: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  binding: CanvasFigmaBinding | null
}

const DEFERRED_ENVIRONMENT_RENDER_DELAY_MS = 80

const createProxyAccessTokenId = (): string =>
  globalThis.crypto?.randomUUID?.() ||
  `proxy-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const buildProxyAccessTokenScope = (label: string, index: number): string => {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return normalized || `user-${index + 1}`
}

const getLocalProxyAccessTokens = (config: Config): LLMProxyAccessTokenEntry[] => {
  const configuredEntries = Array.isArray(config.local_llm_server_config?.access_tokens)
    ? config.local_llm_server_config.access_tokens
    : []

  if (configuredEntries.length > 0) {
    return configuredEntries
  }

  const legacyToken = config.local_llm_server_config?.access_token?.trim() || ''
  return legacyToken
    ? [
        {
          id: 'default',
          label: 'Default',
          token: legacyToken,
          resource_scope: 'default'
        }
      ]
    : []
}

const getDefaultProxyAccessTokenIndex = (
  entry: Pick<LLMProxyAccessTokenEntry, 'resource_scope'>,
  index: number
): number => {
  const match = entry.resource_scope?.match(/^user-(\d+)$/)
  const parsed = match ? Number.parseInt(match[1] || '', 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : index + 1
}

const getDisplayProxyAccessTokenLabel = (
  entry: Pick<LLMProxyAccessTokenEntry, 'label' | 'resource_scope'>,
  index: number,
  text: (fallbackChinese: string, fallbackEnglish: string) => string
): string => {
  const label = entry.label?.trim() || ''
  const tokenIndex = getDefaultProxyAccessTokenIndex(entry, index)
  const defaultLabel = text(`用户 ${tokenIndex}`, `User ${tokenIndex}`)
  if (!label) {
    return defaultLabel
  }

  const canonicalLabelPattern = new RegExp(`^(?:用户|User)\\s*${tokenIndex}$`, 'u')
  if (canonicalLabelPattern.test(label)) {
    return defaultLabel
  }

  const looksLikeLegacyGeneratedGarble =
    entry.resource_scope === `user-${tokenIndex}` &&
    label.length <= 8 &&
    label.endsWith(String(tokenIndex))
  return looksLikeLegacyGeneratedGarble ? defaultLabel : label
}

const formatProxyUsageTime = (timestamp?: number): string => {
  if (!timestamp) {
    return 'Never'
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

const formatProxyUsageBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

const ProxyModeSection: React.FC<ProxyModeSectionProps> = ({
  saveSettings,
  settingsValue,
  t,
  text
}) => {
  const accessTokens = getLocalProxyAccessTokens(settingsValue)

  const persistAccessTokens = (nextTokens: LLMProxyAccessTokenEntry[]) => {
    saveSettings({
      local_llm_server_config: {
        access_token: nextTokens.length === 1 ? nextTokens[0]?.token || '' : '',
        access_tokens: nextTokens
      }
    })
  }

  const addAccessToken = () => {
    const nextIndex = accessTokens.length
    persistAccessTokens([
      ...accessTokens,
      {
        id: createProxyAccessTokenId(),
        label: text(`用户 ${nextIndex + 1}`, `User ${nextIndex + 1}`),
        token: '',
        resource_scope: buildProxyAccessTokenScope('', nextIndex)
      }
    ])
  }

  return (
    <SettingSection title={t('llm.proxy_mode_title')}>
      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography variant="body2">{t('llm.proxy_mode_desc')}</Typography>
      </Alert>

      <Box sx={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
            {t('llm.client_config')}
          </Typography>
          <Stack spacing={2}>
            <InputSwitch
              label={t('llm.use_remote_llm_label')}
              value={settingsValue.use_remote_llm || false}
              onChange={(enabled) => {
                if (enabled) {
                  saveSettings({
                    use_remote_llm: true,
                    local_llm_server_config: { enable_server: false }
                  })
                  return
                }

                saveSettings({ use_remote_llm: false })
              }}
              tooltip={t('llm.use_remote_llm_tooltip')}
            />
            <InputText
              label={t('llm.remote_server_address')}
              value={
                settingsValue.remote_llm_server_config?.server_origin || 'http://localhost:3721'
              }
              onChange={(value) =>
                saveSettings({ remote_llm_server_config: { server_origin: value } })
              }
              placeholder={t('llm.remote_server_placeholder')}
            />
            <InputText
              label={t('llm.remote_server_access_token')}
              value={settingsValue.remote_llm_server_config?.access_token || ''}
              onChange={(value) =>
                saveSettings({ remote_llm_server_config: { access_token: value } })
              }
              placeholder={t('llm.remote_server_access_token_placeholder')}
            />
          </Stack>
        </Box>

        <Divider orientation="vertical" flexItem />

        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
            {t('llm.server_config')}
          </Typography>
          <Stack spacing={2}>
            <InputSwitch
              label={t('llm.enable_llm_server_label')}
              value={settingsValue.local_llm_server_config?.enable_server || false}
              onChange={(enabled) => {
                if (enabled) {
                  saveSettings({
                    use_remote_llm: false,
                    local_llm_server_config: { enable_server: true }
                  })
                  return
                }

                saveSettings({ local_llm_server_config: { enable_server: false } })
              }}
              tooltip={t('llm.enable_llm_server_tooltip')}
            />
            <InputText
              label={t('llm.llm_server_port')}
              value={String(settingsValue.local_llm_server_config?.port || 3721)}
              onChange={(value) =>
                saveSettings({ local_llm_server_config: { port: parseInt(value, 10) || 3721 } })
              }
              placeholder="3721"
            />

            <Stack spacing={1.5}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 2
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {text('代理访问令牌', 'Proxy Access Tokens')}
                </Typography>
                <Button size="small" variant="outlined" onClick={addAccessToken}>
                  {text('添加令牌', 'Add Token')}
                </Button>
              </Box>
              <Typography variant="caption" color="text.secondary">
                {text(
                  '每个令牌对应一位用户，服务端会按令牌把生成资源分开存放。',
                  'Each token identifies one user, and generated resources are stored separately per token.'
                )}
              </Typography>
              {accessTokens.length > 0 ? (
                <Stack spacing={1.5}>
                  {accessTokens.map((entry, index) => {
                    const displayLabel = getDisplayProxyAccessTokenLabel(entry, index, text)
                    return (
                      <Box
                        key={entry.id}
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 2,
                          p: 1.5
                        }}
                      >
                        <Stack spacing={1.5}>
                          <TextField
                            label={text('用户名称', 'User Name')}
                            size="small"
                            value={displayLabel}
                            onChange={(event) => {
                              const nextTokens = [...accessTokens]
                              nextTokens[index] = {
                                ...entry,
                                label: event.target.value
                              }
                              persistAccessTokens(nextTokens)
                            }}
                          />
                          <TextField
                            label={text('访问令牌', 'Access Token')}
                            size="small"
                            value={entry.token || ''}
                            onChange={(event) => {
                              const nextTokens = [...accessTokens]
                              nextTokens[index] = {
                                ...entry,
                                token: event.target.value
                              }
                              persistAccessTokens(nextTokens)
                            }}
                            placeholder={t('llm.llm_server_access_token_placeholder')}
                          />
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <Button
                              color="error"
                              size="small"
                              onClick={() =>
                                persistAccessTokens(
                                  accessTokens.filter((token) => token.id !== entry.id)
                                )
                              }
                            >
                              {text('删除', 'Remove')}
                            </Button>
                          </Box>
                        </Stack>
                      </Box>
                    )
                  })}
                </Stack>
              ) : (
                <Alert severity="warning">
                  <Typography variant="body2">
                    {text(
                      '当前未设置代理令牌。配置后，客户端需要携带匹配令牌才能访问代理。',
                      'No proxy access tokens are configured. Clients must send a matching token after you set one.'
                    )}
                  </Typography>
                </Alert>
              )}
            </Stack>
          </Stack>
        </Box>
      </Box>
    </SettingSection>
  )
}

const PanelEnvironment: React.FC<PanelProps> = ({ settingsValue, saveSettings }: PanelProps) => {
  const { notifyError, notifyInfo, notifySuccess, notifyWarning } = useMessage()
  const { buildEnv } = useConfig()
  const buildMode = buildEnv.env.buildMode
  // const { t } = useI18n()
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh') ?? true
  const text = useCallback(
    (fallbackChinese: string, fallbackEnglish: string) =>
      isChineseUi ? fallbackChinese : fallbackEnglish,
    [isChineseUi]
  )

  const configUtils = new ConfigUtils(settingsValue, buildEnv, window.path)
  const appRootDir = buildEnv.pathMap.file

  const toEmbeddedRelativePath = (value: string): string => {
    const trimmed = value.trim()
    if (buildMode !== 'embedded' || !trimmed || !window.path.isAbsolute(trimmed)) {
      return trimmed
    }
    const normalizedRoot = window.path.normalize(appRootDir)
    const normalizedValue = window.path.normalize(trimmed)
    const rootWithSlash = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    if (normalizedValue === normalizedRoot || normalizedValue.startsWith(rootWithSlash)) {
      return window.path.relative(normalizedRoot, normalizedValue)
    }
    return trimmed
  }

  const [fastSettingTemplates, setFastSettingTemplates] = useState<FastSettingTemplate[]>([])
  const [fastSettingErrorMessage, setFastSettingErrorMessage] = useState<string>('')
  const [fastSettingErrorDescription, setFastSettingErrorDescription] = useState<string>('')
  const [managedCanvasSnapshot, setManagedCanvasSnapshot] = useState<ManagedCanvasSnapshot | null>(
    null
  )
  const [figmaBindingDialogOpen, setFigmaBindingDialogOpen] = useState(false)
  const [figmaBindingDraft, setFigmaBindingDraft] = useState<CanvasFigmaBinding | null>(null)
  const [figmaFileKeyOrUrlInput, setFigmaFileKeyOrUrlInput] = useState('')
  const [figmaBusyAction, setFigmaBusyAction] = useState<
    'resolve' | 'bind' | 'sync' | 'check' | null
  >(null)
  const [figmaBindingError, setFigmaBindingError] = useState<string | null>(null)
  const lastActiveProjectId = useAppSelector((state) => state.layout.lastActiveProjectId)
  const openTabs = useAppSelector((state) => state.layout.openTabs)
  const [renderDeferredSections, setRenderDeferredSections] = useState(false)
  const [proxyUsageState, setProxyUsageState] = useState<{
    running: boolean
    port?: number
    usage: LlmProxyAccessUsageSnapshot[]
  }>({
    running: false,
    usage: []
  })
  const [proxyUsageLoading, setProxyUsageLoading] = useState(false)
  const currentCanvasLabel =
    openTabs.find((tab) => tab.id === lastActiveProjectId)?.label ||
    (isChineseUi ? '当前画布' : 'Current canvas')
  const figmaAccessToken = settingsValue.figma_config?.personal_access_token?.trim() || ''
  const figmaGlobalAutoCheckEnabled = settingsValue.figma_config?.auto_check_updates ?? true
  const figmaAutoCheckIntervalMinutes = Math.min(
    1440,
    Math.max(5, settingsValue.figma_config?.auto_check_interval_minutes ?? 15)
  )
  const currentCanvasBinding = managedCanvasSnapshot?.binding || null
  const displayedFigmaBinding = figmaBindingDraft || currentCanvasBinding
  const managedCanvasLabel =
    openTabs.find((tab) => tab.id === lastActiveProjectId)?.label ||
    text('当前画布', 'Current canvas')

  const localProxyAccessTokens = getLocalProxyAccessTokens(settingsValue)
  const proxyUsageByTokenId = new Map(proxyUsageState.usage.map((entry) => [entry.tokenId, entry]))

  const refreshProxyUsage = useCallback(
    async (silent = false) => {
      setProxyUsageLoading(true)
      try {
        const response = await api().svcState.getLlmProxyAccessUsage({})
        setProxyUsageState(response)
      } catch (error) {
        console.warn('[PanelEnvironment] Failed to load proxy access usage:', error)
        if (!silent) {
          notifyWarning(text('无法获取代理使用统计', 'Failed to load proxy usage statistics'))
        }
      } finally {
        setProxyUsageLoading(false)
      }
    },
    [notifyWarning, text]
  )

  useEffect(() => {
    const timerId = window.setTimeout(
      () => setRenderDeferredSections(true),
      DEFERRED_ENVIRONMENT_RENDER_DELAY_MS
    )

    return () => window.clearTimeout(timerId)
  }, [])

  useEffect(() => {
    if (!renderDeferredSections) return

    void refreshProxyUsage(true)
  }, [refreshProxyUsage, renderDeferredSections, settingsValue.local_llm_server_config])

  const persistManagedCanvasSnapshot = useCallback(async (snapshot: ManagedCanvasSnapshot) => {
    await saveCanvasItems(
      snapshot.items,
      snapshot.canvasId,
      snapshot.groups,
      snapshot.groupBranches,
      snapshot.binding
    )
    setManagedCanvasSnapshot(snapshot)
  }, [])

  const buildNextFigmaBindingDraft = useCallback(
    ({
      fileKey,
      fileName,
      pages,
      fileKeyOrUrl,
      version,
      lastModified,
      previous
    }: {
      fileKey: string
      fileName: string
      pages: CanvasFigmaBinding['pages']
      fileKeyOrUrl: string
      version?: string
      lastModified?: string
      previous?: CanvasFigmaBinding | null
    }): CanvasFigmaBinding => {
      const selectedPage =
        pages.find((page) => page.nodeId === previous?.pageNodeId) || pages[0] || undefined

      return {
        fileKey,
        fileName,
        fileUrl: fileKeyOrUrl.trim() || previous?.fileUrl || fileKey,
        pageNodeId: selectedPage?.nodeId,
        pageName: selectedPage?.name,
        pages,
        autoCheckUpdates: previous?.autoCheckUpdates ?? figmaGlobalAutoCheckEnabled,
        lastSyncedAt: previous?.lastSyncedAt,
        lastCheckedAt: previous?.lastCheckedAt,
        lastKnownVersion: version ?? previous?.lastKnownVersion,
        lastKnownModifiedAt: lastModified ?? previous?.lastKnownModifiedAt,
        updateAvailable: previous?.updateAvailable ?? false
      }
    },
    [figmaGlobalAutoCheckEnabled]
  )

  useEffect(() => {
    let cancelled = false

    if (!renderDeferredSections || !lastActiveProjectId) {
      setManagedCanvasSnapshot(null)
      return () => {
        cancelled = true
      }
    }

    void loadCanvasItems(lastActiveProjectId)
      .then((saved) => {
        if (cancelled) return
        setManagedCanvasSnapshot({
          canvasId: lastActiveProjectId,
          canvasLabel: managedCanvasLabel,
          items: saved.items,
          groups: saved.groups,
          groupBranches: saved.groupBranches,
          binding: saved.figmaBinding
        })
      })
      .catch((error) => {
        console.error('[Settings] Failed to load canvas binding snapshot:', error)
        if (cancelled) return
        setManagedCanvasSnapshot({
          canvasId: lastActiveProjectId,
          canvasLabel: managedCanvasLabel,
          items: [],
          groups: [],
          groupBranches: [],
          binding: null
        })
      })

    return () => {
      cancelled = true
    }
  }, [lastActiveProjectId, managedCanvasLabel, renderDeferredSections])

  useEffect(() => {
    setFigmaBindingDraft(
      managedCanvasSnapshot?.binding ? { ...managedCanvasSnapshot.binding } : null
    )
    setFigmaFileKeyOrUrlInput(
      managedCanvasSnapshot?.binding?.fileUrl || managedCanvasSnapshot?.binding?.fileKey || ''
    )
    setFigmaBindingError(null)
  }, [managedCanvasSnapshot])

  // Load the quick environment templates when the panel mounts.
  useEffect(() => {
    api()
      .svcHyper.listFastSettingTemplates({})
      .then((res) => setFastSettingTemplates(res.templates))
  }, [])

  // Reset both environment and model paths back to the embedded defaults.
  const handleResetAllPaths = () => {
    const resetDefaults: DeepPartial<Config> = {
      checkpoints_dir: DEFAULT_CHECKPOINTS_DIR,
      clip_dir: DEFAULT_CLIP_DIR,
      vae_dir: DEFAULT_VAE_DIR,
      lora_dir: DEFAULT_LORA_DIR,
      controlnet_dir: DEFAULT_CONTROLNET_DIR,
      diffusion_models_dir: DEFAULT_DIFFUSION_MODELS_DIR,
      unet_dir: DEFAULT_UNET_DIR,
      upscale_models_dir: DEFAULT_UPSCALE_MODELS_DIR,
      output_dir: DEFAULT_OUTPUT_DIR,
      workflow_dir: DEFAULT_WORKFLOW_DIR
    }
    if (buildMode === 'embedded') {
      resetDefaults.local_comfyui_config = {
        python_cmd: '',
        comfyui_dir: ''
      }
    }
    saveSettings(resetDefaults)
  }

  // Apply a named quick environment template.
  const handleFastSetting = async (key: string) => {
    const currentTemplate = fastSettingTemplates.find((template) => template.key === key)
    if (!currentTemplate) {
      notifyError(t('environment.err_quick_missing'))
      return
    }
    const dialogResp = await api().svcDialog.showOpenDialog({
      title: currentTemplate.description,
      defaultPath: configUtils.getComfyUIDir()[0],
      properties: ['openDirectory']
    })
    if (dialogResp.canceled) {
      return
    }
    const inputPath = dialogResp.filePaths[0]
    if (!inputPath) {
      notifyError(t('environment.err_no_path_selected'))
      return
    }
    const res = await api().svcHyper.getFastSettingValue({ key, inputPath })
    if (res.errorMessage) {
      setFastSettingErrorMessage(res.errorMessage)
      setFastSettingErrorDescription(currentTemplate.errorDescription)
    } else {
      saveSettings({
        local_comfyui_config: {
          python_cmd: toEmbeddedRelativePath(res.pythonCmd),
          comfyui_dir: toEmbeddedRelativePath(res.comfyuiDir)
        }
      })
    }
  }

  const handleLoadExtraModelPaths = async () => {
    try {
      const res = await api().svcHyper.getExtraModelPaths({})
      saveSettings(res)
    } catch (error) {
      console.error(error)
      setFastSettingErrorMessage(t('environment.err_load_extra_yaml'))
      setFastSettingErrorDescription(t('environment.err_load_extra_yaml_desc'))
      return
    }
  }

  const handleOpenFigmaBindingDialog = useCallback(async () => {
    if (!lastActiveProjectId) {
      notifyError(isChineseUi ? '请先打开一个画布项目。' : 'Open a canvas project first.')
      return
    }

    const saved = await loadCanvasItems(lastActiveProjectId)
    const snapshot: ManagedCanvasSnapshot = {
      canvasId: lastActiveProjectId,
      canvasLabel: managedCanvasLabel,
      items: saved.items,
      groups: saved.groups,
      groupBranches: saved.groupBranches,
      binding: saved.figmaBinding
    }

    setManagedCanvasSnapshot(snapshot)
    setFigmaBindingDialogOpen(true)
    setFigmaBindingError(null)
    setFigmaBusyAction(null)
    setFigmaBindingDraft(snapshot.binding ? { ...snapshot.binding } : null)
    setFigmaFileKeyOrUrlInput(snapshot.binding?.fileUrl || snapshot.binding?.fileKey || '')
  }, [isChineseUi, lastActiveProjectId, managedCanvasLabel, notifyError])

  const handleCloseFigmaBindingDialog = useCallback(() => {
    if (figmaBusyAction) return
    setFigmaBindingDialogOpen(false)
    setFigmaBindingError(null)
    setFigmaBusyAction(null)
  }, [figmaBusyAction])

  const handleResolveFigmaBinding = useCallback(async () => {
    const normalizedInput = figmaFileKeyOrUrlInput.trim()
    if (!figmaAccessToken) {
      const message = isChineseUi
        ? '请先到设置 > 环境部署里配置 Figma Personal Access Token。'
        : 'Set the Figma Personal Access Token in Settings > Environment first.'
      setFigmaBindingError(message)
      notifyWarning(message)
      return
    }
    if (!normalizedInput) {
      const message = isChineseUi
        ? '请输入 Figma 文件链接或 File Key。'
        : 'Enter a Figma file link or File Key.'
      setFigmaBindingError(message)
      return
    }

    setFigmaBusyAction('resolve')
    setFigmaBindingError(null)
    try {
      const resolved = await api().svcFigma.resolveFile({
        accessToken: figmaAccessToken,
        fileKeyOrUrl: normalizedInput
      })
      setFigmaBindingDraft((prev) =>
        buildNextFigmaBindingDraft({
          fileKey: resolved.fileKey,
          fileName: resolved.fileName,
          pages: resolved.pages,
          fileKeyOrUrl: normalizedInput,
          version: resolved.version,
          lastModified: resolved.lastModified,
          previous: prev ?? managedCanvasSnapshot?.binding ?? null
        })
      )
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    buildNextFigmaBindingDraft,
    figmaAccessToken,
    figmaFileKeyOrUrlInput,
    isChineseUi,
    managedCanvasSnapshot,
    notifyWarning
  ])

  const handleFigmaDraftPageChange = useCallback((pageNodeId: string) => {
    setFigmaBindingDraft((prev) => {
      if (!prev) return prev
      const nextPage = prev.pages.find((page) => page.nodeId === pageNodeId)
      return {
        ...prev,
        pageNodeId,
        pageName: nextPage?.name || prev.pageName
      }
    })
  }, [])

  const handleFigmaDraftAutoCheckUpdatesChange = useCallback((value: boolean) => {
    setFigmaBindingDraft((prev) => (prev ? { ...prev, autoCheckUpdates: value } : prev))
  }, [])

  const handleSaveFigmaBinding = useCallback(async () => {
    if (!managedCanvasSnapshot || !figmaBindingDraft) return

    setFigmaBusyAction('bind')
    setFigmaBindingError(null)
    try {
      await persistManagedCanvasSnapshot({
        ...managedCanvasSnapshot,
        binding: figmaBindingDraft
      })
      setFigmaBindingDialogOpen(false)
      notifySuccess(
        isChineseUi
          ? `宸蹭负鈥?{managedCanvasSnapshot.canvasLabel}鈥濈粦瀹?Figma锛?{figmaBindingDraft.fileName}`
          : `Bound Figma for "${managedCanvasSnapshot.canvasLabel}": ${figmaBindingDraft.fileName}`
      )
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    figmaBindingDraft,
    isChineseUi,
    managedCanvasSnapshot,
    notifySuccess,
    persistManagedCanvasSnapshot
  ])

  const handleUnbindFigmaBinding = useCallback(async () => {
    if (!managedCanvasSnapshot) return

    setFigmaBusyAction('bind')
    setFigmaBindingError(null)
    try {
      await persistManagedCanvasSnapshot({
        ...managedCanvasSnapshot,
        binding: null
      })
      setFigmaBindingDraft(null)
      setFigmaFileKeyOrUrlInput('')
      setFigmaBindingDialogOpen(false)
      notifyInfo(
        isChineseUi
          ? `已解除“${managedCanvasSnapshot.canvasLabel}”的 Figma 绑定，画布内现有元素会保留。`
          : `Removed the Figma binding from "${managedCanvasSnapshot.canvasLabel}". Existing canvas items were kept.`
      )
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [isChineseUi, managedCanvasSnapshot, notifyInfo, persistManagedCanvasSnapshot])

  const handleCheckFigmaUpdate = useCallback(async () => {
    const candidate = figmaBindingDraft || managedCanvasSnapshot?.binding
    if (!candidate || !managedCanvasSnapshot) return

    setFigmaBusyAction('check')
    setFigmaBindingError(null)
    try {
      const response = await api().svcFigma.checkFileUpdate({
        accessToken: figmaAccessToken,
        fileKey: candidate.fileKey,
        knownLastModified: candidate.lastKnownModifiedAt,
        knownVersion: candidate.lastKnownVersion
      })

      const checkedAt = new Date().toISOString()
      const selectedPage =
        response.pages.find((page) => page.nodeId === candidate.pageNodeId) || response.pages[0]
      const nextBinding: CanvasFigmaBinding = {
        ...candidate,
        fileName: response.fileName,
        pages: response.pages,
        pageNodeId: selectedPage?.nodeId || candidate.pageNodeId,
        pageName: selectedPage?.name || candidate.pageName,
        lastCheckedAt: checkedAt,
        lastKnownVersion: candidate.lastKnownVersion || response.version,
        lastKnownModifiedAt: candidate.lastKnownModifiedAt || response.lastModified,
        updateAvailable: response.hasUpdate || candidate.updateAvailable
      }

      setFigmaBindingDraft((prev) => (prev ? nextBinding : prev))

      if (managedCanvasSnapshot.binding?.fileKey === candidate.fileKey) {
        await persistManagedCanvasSnapshot({
          ...managedCanvasSnapshot,
          binding: nextBinding
        })
      }

      if (response.hasUpdate) {
        notifyInfo(
          isChineseUi
            ? `检测到“${response.fileName}”有新版本，可以继续同步到“${managedCanvasSnapshot.canvasLabel}”。`
            : `A newer version of "${response.fileName}" is available for "${managedCanvasSnapshot.canvasLabel}".`
        )
      } else {
        notifySuccess(
          isChineseUi
            ? `“${managedCanvasSnapshot.canvasLabel}”绑定的 Figma 文件已经是最新。`
            : `The Figma file bound to "${managedCanvasSnapshot.canvasLabel}" is already up to date.`
        )
      }
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    figmaAccessToken,
    figmaBindingDraft,
    isChineseUi,
    managedCanvasSnapshot,
    notifyInfo,
    notifySuccess,
    persistManagedCanvasSnapshot
  ])

  const handleSyncFigmaBinding = useCallback(async () => {
    const candidate = figmaBindingDraft || managedCanvasSnapshot?.binding
    if (!candidate || !managedCanvasSnapshot) return

    if (!figmaAccessToken) {
      const message = isChineseUi
        ? '请先到设置 > 环境部署里配置 Figma Personal Access Token。'
        : 'Set the Figma Personal Access Token in Settings > Environment first.'
      setFigmaBindingError(message)
      notifyWarning(message)
      return
    }

    setFigmaBusyAction('sync')
    setFigmaBindingError(null)
    try {
      const response = await api().svcFigma.syncFile({
        accessToken: figmaAccessToken,
        fileKeyOrUrl: candidate.fileUrl || candidate.fileKey,
        pageNodeId: candidate.pageNodeId
      })

      const importedAt = new Date().toISOString()
      const currentFigmaItems = managedCanvasSnapshot.items.filter(
        (item) =>
          item.provenance?.kind === 'figma' &&
          item.provenance?.sourceDocumentId === response.fileKey
      )
      const currentFigmaBounds = getCanvasItemsBounds(currentFigmaItems)

      const sourceItems: CanvasImageItem[] = response.items.map((item) => ({
        id: `figma-${response.fileKey}-${item.nodeId}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'image',
        src: item.src,
        fileName: item.fileName,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 0,
        locked: false,
        sourceWidth: item.width,
        sourceHeight: item.height,
        provenance: {
          kind: 'figma',
          sourceFileName: response.fileName,
          sourceDocumentId: response.fileKey,
          sourceNodeId: item.nodeId,
          ...(item.nodeName ? { sourceNodeName: item.nodeName } : {}),
          importedAt
        }
      }))

      const importedBounds = getCanvasItemsBounds(sourceItems)
      const positionedItems =
        currentFigmaBounds && importedBounds
          ? (() => {
              const offsetX = currentFigmaBounds.minX - importedBounds.minX
              const offsetY = currentFigmaBounds.minY - importedBounds.minY
              return sourceItems.map((item) => ({
                ...item,
                x: item.x + offsetX,
                y: item.y + offsetY
              }))
            })()
          : sourceItems

      let nextZIndex =
        managedCanvasSnapshot.items.reduce((maxValue, item) => Math.max(maxValue, item.zIndex), 0) +
        1

      const nextItems = [
        ...managedCanvasSnapshot.items.filter(
          (item) =>
            !(
              item.provenance?.kind === 'figma' &&
              item.provenance?.sourceDocumentId === response.fileKey
            )
        ),
        ...positionedItems.map((item) => ({
          ...item,
          zIndex: nextZIndex++
        }))
      ]
      const nextGroups = managedCanvasSnapshot.groups.filter(
        (group) => group.provenance?.sourceDocumentId !== response.fileKey
      )
      const nextBinding: CanvasFigmaBinding = {
        ...candidate,
        fileKey: response.fileKey,
        fileName: response.fileName,
        pages: response.pages,
        pageNodeId: response.pageNodeId,
        pageName: response.pageName,
        lastSyncedAt: importedAt,
        lastCheckedAt: importedAt,
        lastKnownVersion: response.version,
        lastKnownModifiedAt: response.lastModified,
        updateAvailable: false
      }

      await persistManagedCanvasSnapshot({
        ...managedCanvasSnapshot,
        items: nextItems,
        groups: nextGroups,
        binding: nextBinding
      })
      setFigmaBindingDraft(nextBinding)

      if (response.warnings.length > 0) {
        notifyWarning(
          isChineseUi
            ? `Figma 已同步到“${managedCanvasSnapshot.canvasLabel}”，共 ${positionedItems.length} 个元素，另有 ${response.warnings.length} 条提示。`
            : `Synced ${positionedItems.length} Figma item(s) to "${managedCanvasSnapshot.canvasLabel}" with ${response.warnings.length} warning(s).`
        )
      } else {
        notifySuccess(
          isChineseUi
            ? `Figma 已同步到“${managedCanvasSnapshot.canvasLabel}”，共 ${positionedItems.length} 个元素。`
            : `Synced ${positionedItems.length} Figma item(s) to "${managedCanvasSnapshot.canvasLabel}".`
        )
      }
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    figmaAccessToken,
    figmaBindingDraft,
    isChineseUi,
    managedCanvasSnapshot,
    notifySuccess,
    notifyWarning,
    persistManagedCanvasSnapshot
  ])

  return (
    <Box sx={{ p: 3 }}>
      <>
        <Box key="comfy_mode">
          <SettingSection title={t('environment.comfy_mode_title')}>
            <Alert severity="info">
              <AlertTitle>{t('environment.comfy_mode_info_title')}</AlertTitle>
              <Typography sx={{ whiteSpace: 'pre-line', wordBreak: 'break-all' }}>
                {t('environment.comfy_mode_info_desc')}
              </Typography>
            </Alert>
            <InputSwitch
              label={t('environment.comfy_mode_label')}
              value={settingsValue.use_remote_comfyui || false}
              onChange={(value) => saveSettings({ use_remote_comfyui: value })}
            />
          </SettingSection>
        </Box>

        {settingsValue.use_remote_comfyui && (
          <Box key="remote_comfyui">
            <SettingSection title={t('environment.remote_comfyui_title')}>
              <InputText
                label={t('environment.remote_comfyui_origin_label')}
                value={settingsValue.remote_comfyui_config.comfyui_origin}
                onChange={(value) =>
                  saveSettings({ remote_comfyui_config: { comfyui_origin: value } })
                }
                placeholder={t('environment.placeholder_remote_comfyui_origin')}
                errorText={
                  settingsValue.remote_comfyui_config.comfyui_origin.trim() === ''
                    ? t('environment.err_remote_comfyui_origin_required')
                    : undefined
                }
              />
              <InputPath
                label={t('environment.remote_comfyui_mapping_dir_label')}
                value={settingsValue.remote_comfyui_config.mapping_comfyui_dir}
                pathType="directory"
                defaultTo={configUtils.getComfyUIDir()[0]}
                onChange={(value) =>
                  saveSettings({ remote_comfyui_config: { mapping_comfyui_dir: value } })
                }
                placeholder={t('environment.placeholder_remote_comfyui_mapping_dir')}
              />
            </SettingSection>
          </Box>
        )}

        <Box key="proxy_mode">
          <ProxyModeSection
            saveSettings={saveSettings}
            settingsValue={settingsValue}
            t={t}
            text={text}
          />
        </Box>

        {renderDeferredSections && (
          <>
            <Box key="proxy_usage">
              <SettingSection
                title={text('代理使用情况', 'Proxy Usage')}
                action={
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<RefreshIcon />}
                    onClick={() => void refreshProxyUsage()}
                    disabled={proxyUsageLoading}
                  >
                    {text('刷新统计', 'Refresh Stats')}
                  </Button>
                }
              >
                <Stack spacing={1.5}>
                  <Alert severity={proxyUsageState.running ? 'info' : 'warning'}>
                    <Typography variant="body2">
                      {proxyUsageState.running
                        ? text(
                            `当前已启用本次运行统计，端口 ${proxyUsageState.port || 3721}`,
                            `Live session stats are available on port ${proxyUsageState.port || 3721}`
                          )
                        : text(
                            '代理服务当前未运行，因此这里只显示已持久化的资源统计。',
                            'The proxy server is not running, so only persisted resource stats are shown.'
                          )}
                    </Typography>
                  </Alert>

                  {localProxyAccessTokens.length > 0 ? (
                    <Stack spacing={1.5}>
                      {localProxyAccessTokens.map((entry, index) => {
                        const usageEntry = proxyUsageByTokenId.get(entry.id)
                        const displayLabel = getDisplayProxyAccessTokenLabel(entry, index, text)
                        return (
                          <Box
                            key={`usage-${entry.id}`}
                            sx={{
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 2,
                              p: 1.5
                            }}
                          >
                            <Stack spacing={1}>
                              <Typography variant="subtitle2">
                                {displayLabel || entry.id}
                              </Typography>
                              <Box
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                                  gap: 1
                                }}
                              >
                                <Typography variant="caption">
                                  {text('请求数', 'Requests')}: {usageEntry?.requestCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  {text('聊天', 'Chat')}: {usageEntry?.chatRequestCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  OpenAI: {usageEntry?.openAiRequestCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  QApp:{' '}
                                  {(usageEntry?.quickAppListRequestCount || 0) +
                                    (usageEntry?.quickAppGetRequestCount || 0)}
                                </Typography>
                                <Typography variant="caption">
                                  {text('下载数', 'Downloads')}:{' '}
                                  {usageEntry?.mediaDownloadCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  {text('生成资源', 'Generated Media')}:{' '}
                                  {usageEntry?.generatedMediaCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  {text('已存资源', 'Stored Media')}:{' '}
                                  {usageEntry?.storedMediaCount || 0}
                                </Typography>
                                <Typography variant="caption">
                                  {text('已存大小', 'Stored Size')}:{' '}
                                  {formatProxyUsageBytes(usageEntry?.storedMediaBytes || 0)}
                                </Typography>
                              </Box>
                              <Typography variant="caption" color="text.secondary">
                                {text('最后活跃', 'Last Active')}:{' '}
                                {formatProxyUsageTime(usageEntry?.lastSeenAt)}
                                {usageEntry?.lastRequesterAddress
                                  ? ` / IP ${usageEntry.lastRequesterAddress}`
                                  : ''}
                                {usageEntry?.lastProfileId ? ` / ${usageEntry.lastProfileId}` : ''}
                              </Typography>
                            </Stack>
                          </Box>
                        )
                      })}
                    </Stack>
                  ) : (
                    <Alert severity="warning">
                      <Typography variant="body2">
                        {text(
                          '请先添加代理访问令牌，才能查看按令牌拆分的使用情况。',
                          'Add proxy access tokens first to view per-token usage.'
                        )}
                      </Typography>
                    </Alert>
                  )}
                </Stack>
              </SettingSection>
            </Box>

            <Box key="pure_config_not_set">
              <PureConfigNotSetCallout needNavigate={false} />
            </Box>

            <Box key="remote_config_not_set">
              <RemoteConfigNotSetCallout needNavigate={false} />
            </Box>

            <Box key="data_storage">
              <SettingSection title={text('数据根目录', 'Data directory')}>
                <DataStorageInfo />
              </SettingSection>
            </Box>

            {!settingsValue.use_remote_comfyui && (
              <Box key="monitor">
                <SettingSection title={t('environment.monitor_title')}>
                  <EnvironmentInfo />
                </SettingSection>
              </Box>
            )}

            {!settingsValue.use_remote_comfyui && (
              <Box key="setup">
                <SettingSection
                  title={t('environment.setup_title')}
                  action={
                    <Stack direction="row" spacing={1}>
                      <DropdownButton
                        variant="outlined"
                        size="small"
                        startIcon={<CodeIcon />}
                        buttonChildren={t('environment.setup_quick')}
                      >
                        {({ handleClose }) =>
                          fastSettingTemplates.map((template) => (
                            <MenuItem
                              key={template.key}
                              onClick={() => {
                                handleFastSetting(template.key)
                                handleClose()
                              }}
                            >
                              {template.name}
                            </MenuItem>
                          ))
                        }
                      </DropdownButton>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={handleResetAllPaths}
                      >
                        {t('environment.setup_reset_paths')}
                      </Button>
                    </Stack>
                  }
                >
                  <InputPath
                    label={t('environment.python_cmd_label')}
                    value={settingsValue.local_comfyui_config.python_cmd.trim()}
                    Icon={CodeIcon}
                    pathType="file"
                    defaultTo={configUtils.getPythonCmd()[0]}
                    onChange={(value) =>
                      saveSettings({
                        local_comfyui_config: { python_cmd: toEmbeddedRelativePath(value) }
                      })
                    }
                    placeholder={
                      configUtils.getPythonCmd()[0] || t('environment.placeholder_python')
                    }
                    errorText={
                      !configUtils.isPythonCmdAvailable()
                        ? t('environment.err_pure_need_python')
                        : undefined
                    }
                  />

                  <InputPath
                    label={t('environment.comfy_dir_label')}
                    value={settingsValue.local_comfyui_config.comfyui_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    defaultTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) =>
                      saveSettings({
                        local_comfyui_config: { comfyui_dir: toEmbeddedRelativePath(value) }
                      })
                    }
                    placeholder={
                      configUtils.getComfyUIDir()[0] || t('environment.placeholder_comfy')
                    }
                    errorText={
                      !configUtils.isComfyUIDirAvailable()
                        ? t('environment.err_pure_need_comfy')
                        : undefined
                    }
                  />

                  <InputText
                    label={t('environment.comfy_port_label')}
                    value={settingsValue.local_comfyui_config.comfyui_port}
                    Icon={CodeIcon}
                    onChange={(value) =>
                      saveSettings({ local_comfyui_config: { comfyui_port: value } })
                    }
                    placeholder={configUtils.getComfyUIPort()}
                  />

                  <InputText
                    label={t('environment.comfy_args_label')}
                    value={settingsValue.local_comfyui_config.comfyui_args?.join(' ') || ''}
                    Icon={CodeIcon}
                    onChange={(value) =>
                      saveSettings({ local_comfyui_config: { comfyui_args: splitSpace(value) } })
                    }
                    placeholder={configUtils.getComfyUIArgs().join(' ')}
                  />
                </SettingSection>
              </Box>
            )}

            {configUtils.isComfyUIDirAvailable() && (
              <Box key="models">
                <SettingSection
                  title={t('environment.models_title')}
                  action={
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={handleLoadExtraModelPaths}
                      >
                        {t('environment.models_load_extra_yaml')}
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={handleResetAllPaths}
                      >
                        {t('environment.models_reset_paths')}
                      </Button>
                    </Stack>
                  }
                >
                  <Typography variant="caption" sx={{ ml: 0.5 }}>
                    {t('environment.models_relative_tip')}
                  </Typography>

                  <InputPath
                    label={t('environment.checkpoints_label')}
                    value={settingsValue.checkpoints_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ checkpoints_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.clip_label')}
                    value={settingsValue.clip_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ clip_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.vae_label')}
                    value={settingsValue.vae_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ vae_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.lora_label')}
                    value={settingsValue.lora_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ lora_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.controlnet_label')}
                    value={settingsValue.controlnet_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ controlnet_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.diffusion_models_label')}
                    value={settingsValue.diffusion_models_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ diffusion_models_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.unet_label')}
                    value={settingsValue.unet_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ unet_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.upscale_models_label')}
                    value={settingsValue.upscale_models_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ upscale_models_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.output_label')}
                    value={settingsValue.output_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ output_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                  <InputPath
                    label={t('environment.workflow_label')}
                    value={settingsValue.workflow_dir.trim()}
                    Icon={FolderIcon}
                    pathType="directory"
                    relativeTo={configUtils.getComfyUIDir()[0]}
                    onChange={(value) => saveSettings({ workflow_dir: value })}
                    placeholder={t('environment.placeholder_rel_or_abs')}
                  />
                </SettingSection>
              </Box>
            )}

            <Box key="dcc_bridge">
              <SettingSection title={text('DCC 桥接', 'DCC Bridge')}>
                <Alert severity="info">
                  <AlertTitle>{text('文件夹目标', 'Folder Targets')}</AlertTitle>
                  <Typography sx={{ whiteSpace: 'pre-line', wordBreak: 'break-all' }}>
                    {text(
                      'Unity：指向项目的 Assets 文件夹，或 Assets 下的某个子文件夹。\nUnreal：指向 Auto Reimport 使用的监视源文件夹。',
                      'Unity: point this at the project Assets folder or a subfolder inside Assets.\nUnreal: point this at a watched source folder used by Auto Reimport.'
                    )}
                  </Typography>
                </Alert>

                <InputPath
                  label={text('Unity 桥接文件夹', 'Unity bridge folder')}
                  value={settingsValue.dcc_bridge_config.unity_export_dir.trim()}
                  Icon={FolderIcon}
                  pathType="directory"
                  onChange={(value) =>
                    saveSettings({ dcc_bridge_config: { unity_export_dir: value } })
                  }
                  placeholder={text(
                    '例如：C:/MyUnityProject/Assets/MagicPot',
                    'C:/MyUnityProject/Assets/MagicPot'
                  )}
                />

                <InputPath
                  label={text('Unreal 桥接文件夹', 'Unreal bridge folder')}
                  value={settingsValue.dcc_bridge_config.unreal_export_dir.trim()}
                  Icon={FolderIcon}
                  pathType="directory"
                  onChange={(value) =>
                    saveSettings({ dcc_bridge_config: { unreal_export_dir: value } })
                  }
                  placeholder={text(
                    '例如：D:/MyUnrealProject/BridgeInbox',
                    'D:/MyUnrealProject/BridgeInbox'
                  )}
                />
              </SettingSection>
            </Box>

            <Box key="adobe_bridge">
              <SettingSection title={text('Adobe 桥接', 'Adobe Bridge')}>
                <Alert severity="info">
                  <AlertTitle>{text('文件夹导入目标', 'Folder Inbox Targets')}</AlertTitle>
                  <Typography sx={{ whiteSpace: 'pre-line', wordBreak: 'break-all' }}>
                    {text(
                      'After Effects / Premiere Pro：指向工作流可导入的文件夹。MagicPot 会把资源复制到 MagicPotImports，并在旁边写入清单。',
                      'After Effects / Premiere Pro: point this at a folder your workflow can import from. MagicPot will copy assets into MagicPotImports and write a manifest beside them.'
                    )}
                  </Typography>
                </Alert>

                <InputPath
                  label={text('After Effects 导出文件夹', 'After Effects bridge folder')}
                  value={(settingsValue.adobe_bridge_config?.after_effects_export_dir || '').trim()}
                  Icon={FolderIcon}
                  pathType="directory"
                  onChange={(value) =>
                    saveSettings({ adobe_bridge_config: { after_effects_export_dir: value } })
                  }
                  placeholder={text(
                    '例如：D:/Creative/AfterEffects/BridgeInbox',
                    'D:/Creative/AfterEffects/BridgeInbox'
                  )}
                />

                <InputPath
                  label={text('Premiere Pro 导出文件夹', 'Premiere Pro bridge folder')}
                  value={(settingsValue.adobe_bridge_config?.premiere_export_dir || '').trim()}
                  Icon={FolderIcon}
                  pathType="directory"
                  onChange={(value) =>
                    saveSettings({ adobe_bridge_config: { premiere_export_dir: value } })
                  }
                  placeholder={text(
                    '例如：D:/Creative/Premiere/BridgeInbox',
                    'D:/Creative/Premiere/BridgeInbox'
                  )}
                />
              </SettingSection>
            </Box>
            <Box key="figma_bridge">
              <SettingSection
                title={text('\u0046\u0069\u0067\u006d\u0061 \u63a5\u5165', 'Figma Integration')}
              >
                <Alert
                  severity={
                    settingsValue.figma_config?.personal_access_token?.trim()
                      ? 'success'
                      : 'warning'
                  }
                >
                  <AlertTitle>
                    {settingsValue.figma_config?.personal_access_token?.trim()
                      ? text('Figma API 已配置', 'Figma API configured')
                      : text('请先配置 Figma API', 'Set up Figma API first')}
                  </AlertTitle>
                  <Typography sx={{ whiteSpace: 'pre-line', wordBreak: 'break-all' }}>
                    {text(
                      '在这里配置一次 Figma Personal Access Token 后，画布里就可以绑定某个 Figma 文件，后续由 MagicPot 主动拉取同步，并按设置自动检查更新。\n发送到 Figma 仍然会继续走剪贴板粘贴流程。',
                      'Configure your Figma Personal Access Token here once. Then each canvas can bind a Figma file, sync it on demand from MagicPot, and automatically check for updates.\nSend to Figma still uses the clipboard paste flow.'
                    )}
                  </Typography>
                </Alert>

                <Stack spacing={2.5} sx={{ mt: 2 }}>
                  <TextField
                    fullWidth
                    type="password"
                    autoComplete="off"
                    label={text('Figma Personal Access Token', 'Figma Personal Access Token')}
                    value={settingsValue.figma_config?.personal_access_token || ''}
                    onChange={(event) =>
                      saveSettings({
                        figma_config: { personal_access_token: event.target.value }
                      })
                    }
                    placeholder="figd_********************************"
                    helperText={text(
                      '用于画布绑定 Figma 文件、手动同步和自动检查更新。',
                      'Used for canvas-side Figma binding, manual sync, and automatic update checks.'
                    )}
                  />

                  <Box
                    sx={{
                      display: 'grid',
                      gap: 2,
                      gridTemplateColumns: {
                        xs: '1fr',
                        md: 'minmax(260px, 1fr) minmax(220px, 320px)'
                      }
                    }}
                  >
                    <InputSwitch
                      label={text(
                        '自动检查已绑定 Figma 文件更新',
                        'Automatically check bound Figma files'
                      )}
                      value={settingsValue.figma_config?.auto_check_updates ?? true}
                      onChange={(value) =>
                        saveSettings({
                          figma_config: { auto_check_updates: value }
                        })
                      }
                      tooltip={text(
                        '开启后，画布侧已绑定的 Figma 文件会由 MagicPot 按间隔自动检查是否有新版本。',
                        'When enabled, MagicPot automatically checks bound Figma files for updates on the canvas side.'
                      )}
                    />

                    <TextField
                      fullWidth
                      type="number"
                      label={text('检查间隔（分钟）', 'Check interval (minutes)')}
                      value={String(settingsValue.figma_config?.auto_check_interval_minutes ?? 15)}
                      onChange={(event) => {
                        const parsed = parseInt(event.target.value, 10)
                        saveSettings({
                          figma_config: {
                            auto_check_interval_minutes: Number.isFinite(parsed)
                              ? Math.min(1440, Math.max(5, parsed))
                              : 15
                          }
                        })
                      }}
                      inputProps={{ min: 5, max: 1440, step: 1 }}
                      helperText={text(
                        '建议 5 到 60 分钟；绑定文件的自动检查会使用这个全局间隔。',
                        'Recommended range: 5 to 60 minutes. Bound-file auto checks use this global interval.'
                      )}
                    />
                  </Box>

                  <Divider />

                  <Alert severity={lastActiveProjectId ? 'info' : 'warning'} variant="outlined">
                    <AlertTitle>
                      {lastActiveProjectId
                        ? text('当前画布绑定', 'Current canvas binding')
                        : text('未打开画布', 'No canvas open')}
                    </AlertTitle>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                      {lastActiveProjectId
                        ? currentCanvasBinding
                          ? text(
                              `当前操作对象：${managedCanvasLabel}\n绑定文件：${currentCanvasBinding.fileName}`,
                              `Current target: ${managedCanvasLabel}\nBound file: ${currentCanvasBinding.fileName}`
                            )
                          : text(
                              `当前操作对象：${managedCanvasLabel}\n尚未绑定 Figma 文件。`,
                              `Current target: ${managedCanvasLabel}\nNo Figma file is bound yet.`
                            )
                        : text(
                            '请先打开一个画布项目，再到这里管理该画布的 Figma 绑定和同步。',
                            'Open a canvas project first, then manage that canvas Figma binding here.'
                          )}
                    </Typography>
                  </Alert>

                  {lastActiveProjectId && displayedFigmaBinding?.updateAvailable && (
                    <Typography variant="body2" color="warning.main" sx={{ fontWeight: 600 }}>
                      {text(
                        '检测到已绑定 Figma 有更新，可在下方面板里同步。',
                        'A newer bound Figma version is available. Use the panel below to sync it.'
                      )}
                    </Typography>
                  )}

                  {lastActiveProjectId && (
                    <FigmaBindingDialog
                      variant="inline"
                      open
                      accessTokenConfigured={Boolean(figmaAccessToken)}
                      busyAction={figmaBusyAction}
                      error={figmaBindingError}
                      fileKeyOrUrl={figmaFileKeyOrUrlInput}
                      binding={displayedFigmaBinding}
                      globalAutoCheckEnabled={figmaGlobalAutoCheckEnabled}
                      globalAutoCheckIntervalMinutes={figmaAutoCheckIntervalMinutes}
                      onFileKeyOrUrlChange={setFigmaFileKeyOrUrlInput}
                      onPageNodeIdChange={handleFigmaDraftPageChange}
                      onAutoCheckUpdatesChange={handleFigmaDraftAutoCheckUpdatesChange}
                      onResolve={() => void handleResolveFigmaBinding()}
                      onBind={() => void handleSaveFigmaBinding()}
                      onSync={() => void handleSyncFigmaBinding()}
                      onCheck={() => void handleCheckFigmaUpdate()}
                      onUnbind={() => void handleUnbindFigmaBinding()}
                      onClose={handleCloseFigmaBindingDialog}
                    />
                  )}

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1.5}
                    alignItems={{ xs: 'stretch', sm: 'center' }}
                    sx={{ display: 'none' }}
                  >
                    <Button
                      variant="outlined"
                      startIcon={<CodeIcon />}
                      onClick={() => void handleOpenFigmaBindingDialog()}
                      disabled={!lastActiveProjectId}
                    >
                      {text('管理当前画布绑定', 'Manage Current Canvas Binding')}
                    </Button>
                    {currentCanvasBinding?.updateAvailable && (
                      <Typography variant="body2" color="warning.main" sx={{ fontWeight: 600 }}>
                        {text(
                          '检测到已绑定 Figma 有更新，可在上面的对话框里同步。',
                          'A newer bound Figma version is available. Open the dialog above to sync it.'
                        )}
                      </Typography>
                    )}
                  </Stack>
                </Stack>
              </SettingSection>
            </Box>
          </>
        )}
      </>

      {renderDeferredSections && (
        <FigmaBindingDialog
          open={figmaBindingDialogOpen}
          accessTokenConfigured={Boolean(figmaAccessToken)}
          busyAction={figmaBusyAction}
          error={figmaBindingError}
          fileKeyOrUrl={figmaFileKeyOrUrlInput}
          binding={figmaBindingDraft || currentCanvasBinding}
          globalAutoCheckEnabled={figmaGlobalAutoCheckEnabled}
          globalAutoCheckIntervalMinutes={figmaAutoCheckIntervalMinutes}
          onFileKeyOrUrlChange={setFigmaFileKeyOrUrlInput}
          onPageNodeIdChange={handleFigmaDraftPageChange}
          onAutoCheckUpdatesChange={handleFigmaDraftAutoCheckUpdatesChange}
          onResolve={() => void handleResolveFigmaBinding()}
          onBind={() => void handleSaveFigmaBinding()}
          onSync={() => void handleSyncFigmaBinding()}
          onCheck={() => void handleCheckFigmaUpdate()}
          onUnbind={() => void handleUnbindFigmaBinding()}
          onClose={handleCloseFigmaBindingDialog}
        />
      )}

      <FastSettingErrorModal
        errorMessage={fastSettingErrorMessage}
        errorDescription={fastSettingErrorDescription}
      />
    </Box>
  )
}

export default PanelEnvironment
