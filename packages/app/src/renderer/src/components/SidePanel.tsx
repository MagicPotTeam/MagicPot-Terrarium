// packages/app/src/renderer/src/components/SidePanel.tsx
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  CircularProgress,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  Stack,
  Alert,
  Button,
  Collapse,
  LinearProgress
} from '@mui/material'
import {
  Close as CloseIcon,
  Refresh as RefreshIcon,
  ImageOutlined as ImageOutlinedIcon,
  ViewInAr as ViewInArIcon,
  MovieOutlined as MovieOutlinedIcon,
  FactCheckOutlined as FactCheckOutlinedIcon,
  MoreHoriz as MoreHorizIcon
} from '@mui/icons-material'
import { QueueItem, Workflow } from '@shared/comfy/types'

export type QueueState = {
  queue_running: QueueItem[]
  queue_pending: QueueItem[]
  queue_error: QueueItem[]
}
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMessage } from '@renderer/hooks/useMessage'
import { useConfig } from '@renderer/hooks/useConfig'
import { useComfyEventCallback } from '@renderer/hooks/useComfyEvent'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { api } from '@renderer/utils/windowUtils'
import { Config } from '@shared/config/config'
import { findHunyuan3DQAppProfile } from '@shared/config/apiProfileSelectors'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { useAppDispatch, useAppSelector } from '../store'
import { closeSidePanel, openTab, setActiveTab } from '../store/slices/layoutSlice'
import { PromptTagProvider } from './inputs/PromptTagContext'
import { QAppContextProvider, useQAppContext } from '../pages/QuickAppPage/components/QAppContext'
import { useQAppRunner as useSharedQAppRunner } from '../pages/QuickAppPage/hooks/useQAppRunner'
import { ResultItem } from '@shared/qApp/resultTypes'
import { transformResults } from '../pages/QuickAppPage/ResultList/resultTransformers'
import { dispatchQAppResultsToCanvas } from '../pages/QuickAppPage/utils/qAppCanvasDispatch'
import { normalizeQAppErrorMessage } from '../pages/QuickAppPage/utils/qAppErrorMessage'
import { buildHy3dProfileId } from '../pages/ChatPage/chatPageShared'
import { buildAssistantMessageFromResult } from '../pages/ChatPage/chatMessageUtils'
import { requestChatCompletion } from '../pages/ChatPage/chatRequestUtils'
import {
  persistCurrentQAppKey,
  readCurrentQAppKey
} from '../pages/QuickAppPage/utils/qAppSelectionStorage'
import { buildQAppSubmitWorkflowRequest } from '../pages/QuickAppPage/utils/qAppSubmitWorkflow'
import { resolveQAppSessionKey } from '../pages/QuickAppPage/utils/qAppSessionIdentity'
import {
  getQueueItemDisplayLabel,
  getQueueItemProgress,
  pruneQueueAnimationStates,
  type QueueAnimationStates
} from './sidePanelQueueUtils'
import {
  cloneHy3dMediaState,
  DEFAULT_MEDIA_STATE,
  getBuiltinHunyuan3DQuickAppKeyForAction,
  getBuiltinHunyuan3DStepId,
  buildHy3dSubmissionContent as buildSharedHy3dSubmissionContent,
  buildHy3dGenerateAttachments,
  getHy3dMissingInputMessage as getSharedHy3dMissingInputMessage,
  getHy3dSubmissionConflictMessage,
  getHy3dMediaState,
  getHy3dParams,
  isBuiltinHunyuan3DMenuKey,
  isBuiltinHunyuan3DWorkflowKey,
  saveHy3dMediaState,
  saveHy3dParams,
  WORKFLOW_STEPS,
  type Hy3dParams
} from '../pages/ChatPage/hy3d/types'
import DuplicateCheckWorkspace from '../pages/QuickAppPage/duplicateCheck/DuplicateCheckWorkspace'
import {
  BUILTIN_DUPLICATE_CHECK_QAPP_KEY,
  isBuiltinDuplicateCheckQApp
} from '../pages/QuickAppPage/duplicateCheck/builtin'

const QAppMenu = lazy(() => import('../pages/QuickAppPage/components/QAppMenu'))
const QAppPanel = lazy(() => import('../pages/QuickAppPage/QAppExecutePanel/QAppInputPanel'))
const ModelPage = lazy(() => import('../pages/FileBrowserPage/ModelPage'))

/*
type QuickAppCategory = 'image' | 'model3d' | 'video' | 'inspection'
const QUICK_APP_CATEGORY_LABELS: Record<QuickAppCategory, string> = {
  image: '图像',
  model3d: '3D',
  video: '视频'
}

const QUICK_APP_CATEGORY_ICONS: Record<QuickAppCategory, React.ReactNode> = {
  image: <ImageOutlinedIcon sx={{ fontSize: 14 }} />,
  model3d: <ViewInArIcon sx={{ fontSize: 14 }} />,
  video: <MovieOutlinedIcon sx={{ fontSize: 14 }} />
}

const QUICK_APP_CATEGORY_DISPLAY_LABELS: Record<QuickAppCategory, string> = {
  image: '图像',
  model3d: '3D',
  video: '视频',
  inspection: '检查'
}

const QUICK_APP_CATEGORY_DISPLAY_ICONS: Record<QuickAppCategory, React.ReactNode> = {
  image: <ImageOutlinedIcon sx={{ fontSize: 14 }} />,
  model3d: <ViewInArIcon sx={{ fontSize: 14 }} />,
  video: <MovieOutlinedIcon sx={{ fontSize: 14 }} />,
  inspection: <FactCheckOutlinedIcon sx={{ fontSize: 14 }} />
}

*/

type QuickAppCategory = 'image' | 'model3d' | 'video' | 'inspection'
const QUICK_APP_CATEGORIES: QuickAppCategory[] = ['image', 'model3d', 'video', 'inspection']

const QUICK_APP_CATEGORY_LABELS: Record<QuickAppCategory, string> = {
  image: '\u56fe\u50cf',
  model3d: '3D',
  video: '\u89c6\u9891',
  inspection: '\u68c0\u67e5'
}

const QUICK_APP_CATEGORY_ICONS: Record<QuickAppCategory, React.ReactNode> = {
  image: <ImageOutlinedIcon sx={{ fontSize: 14 }} />,
  model3d: <ViewInArIcon sx={{ fontSize: 14 }} />,
  video: <MovieOutlinedIcon sx={{ fontSize: 14 }} />,
  inspection: <FactCheckOutlinedIcon sx={{ fontSize: 14 }} />
}

const QUICK_APP_CATEGORY_ESTIMATED_WIDTHS: Record<QuickAppCategory, number> = {
  image: 74,
  model3d: 58,
  video: 74,
  inspection: 74
}

const QUICK_APP_HEADER_HORIZONTAL_PADDING = 24
const QUICK_APP_HEADER_SECTION_GAP = 10
const QUICK_APP_CATEGORY_BAR_CHROME_WIDTH = 8
const QUICK_APP_CATEGORY_OVERFLOW_BUTTON_WIDTH = 42
const QUICK_APP_HEADER_TITLE_FALLBACK_WIDTH = 26
const QUICK_APP_HEADER_ACTIONS_FALLBACK_WIDTH = 40
const QUICK_APP_HEADER_QUEUE_BADGE_FALLBACK_WIDTH = 36

const getQuickAppCategoryLayout = (
  availableWidth: number
): { visible: QuickAppCategory[]; overflow: QuickAppCategory[] } => {
  const normalizedAvailableWidth = Math.max(
    0,
    Math.floor(availableWidth - QUICK_APP_CATEGORY_BAR_CHROME_WIDTH)
  )

  if (normalizedAvailableWidth <= 0) {
    return {
      visible: [QUICK_APP_CATEGORIES[0]],
      overflow: QUICK_APP_CATEGORIES.slice(1)
    }
  }

  let usedWidth = 0
  let visibleCount = 0

  for (let index = 0; index < QUICK_APP_CATEGORIES.length; index += 1) {
    const category = QUICK_APP_CATEGORIES[index]
    const categoryWidth = QUICK_APP_CATEGORY_ESTIMATED_WIDTHS[category]
    const hasRemainingCategories = index < QUICK_APP_CATEGORIES.length - 1
    const reservedOverflowWidth = hasRemainingCategories
      ? QUICK_APP_CATEGORY_OVERFLOW_BUTTON_WIDTH
      : 0

    if (usedWidth + categoryWidth + reservedOverflowWidth > normalizedAvailableWidth) {
      break
    }

    usedWidth += categoryWidth
    visibleCount += 1
  }

  if (visibleCount <= 0) {
    visibleCount = 1
  }

  return {
    visible: QUICK_APP_CATEGORIES.slice(0, visibleCount),
    overflow: QUICK_APP_CATEGORIES.slice(visibleCount)
  }
}

const SIDE_PANEL_DEFAULT_WIDTH = 460

const hasRapidHunyuanConfig = (config: Config): boolean => {
  const hunyuanConfig = config.aigc3d_config
  return Boolean(
    hunyuanConfig?.tencent_secret_id?.trim() &&
    hunyuanConfig?.tencent_secret_key?.trim() &&
    hunyuanConfig?.cos_bucket?.trim() &&
    hunyuanConfig?.cos_region?.trim()
  )
}

const isHunyuanConfigured = (config: Config): boolean =>
  hasRapidHunyuanConfig(config) || Boolean(findHunyuan3DQAppProfile(config))

let hy3dDraftMediaStateCache: import('../pages/ChatPage/hy3d/types').Hy3dMediaState = {
  ...DEFAULT_MEDIA_STATE,
  conceptImages: []
}

const resetHy3dDraftMediaStateForTests = (): void => {
  hy3dDraftMediaStateCache = {
    ...DEFAULT_MEDIA_STATE,
    conceptImages: []
  }
}

type SwitchQAppDetail = {
  qAppKey: string
  workflow?: Workflow
}

const HY3D_POST_PROCESS_ACTIONS = new Set([
  'SubmitHunyuan3DPartJob',
  'SubmitReduceFaceJob',
  'SubmitHunyuanTo3DUVJob',
  'SubmitTextureTo3DJob',
  'Convert3DFormat'
])
const HY3D_CONCEPT_ACTIONS = new Set(['SubmitHunyuanTo3DProJob', 'SubmitHunyuanTo3DRapidJob'])
const HY3D_SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000
const HY3D_PART_RESULT_CANVAS_MODEL_SIZE = 240
const HY3D_PART_RESULT_CANVAS_GAP = 40
const HY3D_PART_RESULT_CANVAS_OFFSET =
  HY3D_PART_RESULT_CANVAS_MODEL_SIZE + HY3D_PART_RESULT_CANVAS_GAP

const isHy3dConceptAction = (
  apiAction: import('../pages/ChatPage/hy3d/types').Hy3dParams['apiAction']
): boolean => HY3D_CONCEPT_ACTIONS.has(apiAction)

const getDefaultHy3dConceptAction = (
  apiAction: import('../pages/ChatPage/hy3d/types').Hy3dParams['apiAction']
): import('../pages/ChatPage/hy3d/types').Hy3dParams['apiAction'] =>
  apiAction === 'SubmitHunyuanTo3DRapidJob'
    ? 'SubmitHunyuanTo3DRapidJob'
    : 'SubmitHunyuanTo3DProJob'

const buildHy3dSubmissionContent = (params: Hy3dParams): string => {
  if (HY3D_POST_PROCESS_ACTIONS.has(params.apiAction)) {
    const promptParts = [params.modelUrl]
    if (params.apiAction === 'SubmitTextureTo3DJob' && params.texturePrompt) {
      promptParts.push(params.texturePrompt)
    }
    return promptParts.filter(Boolean).join('\n').trim()
  }

  if (
    (params.apiAction === 'SubmitHunyuanTo3DProJob' ||
      params.apiAction === 'SubmitHunyuanTo3DRapidJob') &&
    params.prompt
  ) {
    return params.prompt
  }

  return ''
}

const getHy3dMissingInputMessage = (params: Hy3dParams): string => {
  switch (params.apiAction) {
    case 'SubmitProfileTo3DJob':
      return '请先上传人物参考图，再开始生成人物模型。'
    case 'SubmitTextureTo3DJob':
      return '请先上传待处理模型，并填写纹理描述或参考图。'
    case 'SubmitHunyuan3DPartJob':
    case 'SubmitReduceFaceJob':
    case 'SubmitHunyuanTo3DUVJob':
    case 'Convert3DFormat':
      return '请先上传待处理模型，再执行当前流程。'
    case 'SubmitHunyuanTo3DProJob':
    case 'SubmitHunyuanTo3DRapidJob':
    default:
      return '请先填写提示词或上传参考图，再开始生成 3D。'
  }
}

const getFriendlyHy3dRuntimeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '')
  if (
    message.includes("No handler registered for 'svcLLMProxy.uploadHy3DModel'") ||
    message.includes("No handler registered for 'svcLLMProxy.signHy3DModel'")
  ) {
    return '当前运行中的主进程还是旧版本，Hy3D 本地上传能力尚未加载。请完全退出应用后重新启动一次。'
  }
  return message || 'Hy3D 模型链接处理失败'
}

type Model3DAttachment = ChatAttachment & { type: 'model3d' }

const isModel3DAttachment = (attachment: ChatAttachment): attachment is Model3DAttachment =>
  attachment.type === 'model3d'

const getModelAttachmentPriority = (attachment: Model3DAttachment): number => {
  const hint = `${attachment.fileName || ''}\n${attachment.url || ''}`.toLowerCase()
  if (hint.includes('.glb')) return 0
  if (hint.includes('.gltf')) return 1
  if (hint.includes('.fbx')) return 2
  if (hint.includes('.obj')) return 3
  return 10
}

const pickPrimaryModelAttachment = (attachments: Model3DAttachment[]): Model3DAttachment =>
  attachments.reduce((best, current) =>
    getModelAttachmentPriority(current) < getModelAttachmentPriority(best) ? current : best
  )

const summarizeHy3dAttachmentForLog = (attachment: ChatAttachment) => ({
  type: attachment.type,
  fileName: attachment.fileName || '',
  mimeType: attachment.mimeType || '',
  url: attachment.url
})

const getHy3dPartResultCanvasOffset = (
  index: number,
  totalCount: number
): { offsetX: number; offsetY: number } => {
  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(totalCount, 1)))))
  const rows = Math.max(1, Math.ceil(totalCount / columns))
  const columnIndex = index % columns
  const rowIndex = Math.floor(index / columns)

  return {
    offsetX: Math.round((columnIndex - (columns - 1) / 2) * HY3D_PART_RESULT_CANVAS_OFFSET),
    offsetY: Math.round((rowIndex - (rows - 1) / 2) * HY3D_PART_RESULT_CANVAS_OFFSET)
  }
}

const refreshHy3dModelUrlIfNeeded = async (params: Hy3dParams): Promise<Hy3dParams> => {
  if (!HY3D_POST_PROCESS_ACTIONS.has(params.apiAction)) {
    return params
  }

  if (!params.modelStorageKey || !params.modelStorageBucket || !params.modelStorageRegion) {
    return params
  }

  const expiresAtMs = Date.parse(params.modelSignedUrlExpiresAt || '')
  if (
    params.modelUrl &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now() + HY3D_SIGNED_URL_REFRESH_BUFFER_MS
  ) {
    return params
  }

  const signed = await api().svcLLMProxy.signHy3DModel({
    key: params.modelStorageKey,
    bucket: params.modelStorageBucket,
    region: params.modelStorageRegion
  })

  const nextParams = {
    ...params,
    modelUrl: signed.url,
    modelSignedUrlExpiresAt: signed.expiresAt
  }

  saveHy3dParams(nextParams)
  window.dispatchEvent(new CustomEvent('hy3d:params-updated', { detail: { params: nextParams } }))
  return nextParams
}

const getLocalizedFallbackText = (
  t: (key: string) => string,
  language: string | undefined,
  key: string,
  fallback: string
): string => {
  const isChineseUi = language?.toLowerCase().startsWith('zh')
  const value = t(key)
  return isChineseUi && value === key ? fallback : value
}

const emitWorkflowFill = (workflow: Workflow): void => {
  window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
}

const LoadingFallback: React.FC = () => (
  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
    <CircularProgress size={24} />
  </Box>
)

// Kept temporarily to avoid risky large-file churn while the shared runner is rolled out.

const scopeResultItemsToProject = (resultItems: ResultItem[], projectId?: string): ResultItem[] =>
  projectId ? resultItems.map((item) => ({ ...item, projectId })) : resultItems

const useLegacyQAppRunner = (projectId?: string) => {
  const { t } = useTranslation()
  const {
    validate,
    buildWorkflow,
    buildSubmitExtraData,
    qAppCfg,
    currentQAppKey,
    submitClientId,
    submitSessionKey
  } = useQAppContext()
  const {
    state: { isConnected, isRunning },
    setIsRunning,
    appendResults,
    setErrorPromptStatus
  } = useComfyStatus()
  const { notifySuccess, notifyError } = useMessage()

  const summarizeGeneratedResults = (resultItems: ResultItem[]) => {
    let imageCount = 0
    let videoCount = 0

    for (const item of resultItems) {
      if (item.type === 'image') imageCount += 1
      if (item.type === 'video') videoCount += 1
    }

    const parts: string[] = []
    if (imageCount > 0) parts.push(`${imageCount} images`)
    if (videoCount > 0) parts.push(`${videoCount} videos`)
    return parts.join(', ')
  }

  const run = useCallback(async () => {
    if (!validate || !buildWorkflow) {
      notifyError('Quick App is not fully loaded yet')
      return
    }

    if (!isConnected) {
      notifyError('ComfyUI is not connected')
      return
    }

    try {
      if (!(await validate())) return

      setIsRunning(true)

      const workflow = await buildWorkflow()
      const { prompt_id } = await api().svcComfy.submitWorkflow(
        buildQAppSubmitWorkflowRequest({
          prompt: workflow,
          qAppKey: currentQAppKey,
          clientId: submitClientId,
          sessionKey: resolveQAppSessionKey({
            qAppKey: currentQAppKey,
            projectId,
            submitSessionKey
          }),
          extraData: buildSubmitExtraData?.()
        })
      )

      setIsRunning(false)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await new Promise<any>((resolve, reject) => {
        api()
          .svcComfy.waitPromptId(
            { prompt_id },
            {
              onData: (data) => {
                resolve(data[prompt_id])
              }
            }
          )
          .catch(reject)
      })

      if (result.status.status_str === 'error') {
        setErrorPromptStatus(prompt_id, result.status)

        for (const message of result.status.messages) {
          if (message[0] === 'prompt_error') {
            notifyError(
              `${t('quickapp.generate.error')}: ${normalizeQAppErrorMessage(message[1].error.message)}`
            )
          }

          if (message[0] === 'execution_error') {
            notifyError(
              `${t('quickapp.generate.error')}: ${normalizeQAppErrorMessage(message[1].exception_message)}`
            )
          }
        }

        return
      }

      const resultItems = await transformResults(prompt_id, result, qAppCfg?.outputNodeIds)

      if (!resultItems || resultItems.length === 0) {
        notifyError('工作流执行完成，但没有生成任何输出。请检查工作流配置是否正确。')
        return
      }

      const scopedResultItems = scopeResultItemsToProject(resultItems, projectId)
      appendResults(scopedResultItems)

      const canvasDispatchCounts = dispatchQAppResultsToCanvas(scopedResultItems, projectId)

      const summary = summarizeGeneratedResults(resultItems)
      if (canvasDispatchCounts.totalCount > 0) {
        notifySuccess(
          summary
            ? `跑完喽，已将 ${summary} 放进参考区。`
            : `跑完喽，已生成 ${resultItems.length} 个结果。`
        )
      } else {
        notifySuccess(
          summary
            ? `工作流执行完成，已生成 ${summary}。`
            : `工作流执行完成，已生成 ${resultItems.length} 个结果。`
        )
      }

      console.log(`${t('quickapp.generate.complete')} - 生成了 ${resultItems.length} 个结果`)
    } finally {
      setIsRunning(false)
    }
  }, [
    appendResults,
    buildWorkflow,
    buildSubmitExtraData,
    currentQAppKey,
    isConnected,
    notifyError,
    notifySuccess,
    projectId,
    qAppCfg,
    setErrorPromptStatus,
    setIsRunning,
    submitClientId,
    submitSessionKey,
    t,
    validate
  ])

  return { run, isRunning }
}

const InlineQAppParams: React.FC<{
  projectId?: string
  onRunReady: (runner: () => Promise<void>, isRunning: boolean) => void
}> = ({ projectId, onRunReady }) => {
  const { run, isRunning } = useSharedQAppRunner(projectId)

  useEffect(() => {
    onRunReady(run, isRunning)
  }, [isRunning, onRunReady, run])

  return (
    <Box
      sx={{
        p: 1.5,
        width: '100%',
        boxSizing: 'border-box',
        overflowX: 'hidden',
        overflowY: 'visible'
      }}
    >
      <Suspense fallback={<LoadingFallback />}>
        <QAppPanel fallback={<CircularProgress size={24} />} />
      </Suspense>
    </Box>
  )
}

const QuickAppSidePanel: React.FC<{ projectId?: string; activeCategory?: QuickAppCategory }> = ({
  projectId,
  activeCategory = 'image'
}) => {
  const { t, i18n } = useTranslation()
  const { config } = useConfig()
  const { notifyError, notifyInfo, notifySuccess, notifyWarning, closeMessage } = useMessage()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const openTabs = useAppSelector((s) => s.layout.openTabs)
  const [currentQAppKey, setCurrentQAppKey] = useState<string>(() => readCurrentQAppKey(projectId))
  const runnerRef = useRef<() => Promise<void>>(async () => {})
  const [runnerIsRunning, setRunnerIsRunning] = useState(false)
  const [hy3dParams, setHy3dParams] = useState<import('../pages/ChatPage/hy3d/types').Hy3dParams>(
    () => getHy3dParams()
  )
  const [hy3dMediaState, setHy3dMediaState] = useState<
    import('../pages/ChatPage/hy3d/types').Hy3dMediaState
  >(() => {
    const restored = getHy3dMediaState()
    hy3dDraftMediaStateCache = restored
    return restored
  })
  const preferredHy3dConceptApiActionRef = useRef<
    import('../pages/ChatPage/hy3d/types').Hy3dParams['apiAction']
  >(getDefaultHy3dConceptAction(hy3dParams.apiAction))
  const previousActiveCategoryRef = useRef<QuickAppCategory | null>(null)

  const openQuickAppSettings = useCallback(() => {
    if (!openTabs.some((tab) => tab.id === 'tab-settings')) {
      dispatch(
        openTab({
          id: 'tab-settings',
          label: t('menu.settings'),
          routePath: '/settings',
          closable: true
        })
      )
    }
    dispatch(setActiveTab('tab-settings'))
    navigate('/settings', { state: { tab: 'plugin' } })
  }, [dispatch, navigate, openTabs, t])

  const qt = useCallback(
    (key: string, fallback: string) => getLocalizedFallbackText(t, i18n.language, key, fallback),
    [i18n.language, t]
  )

  const handleRunReady = useCallback((runFn: () => Promise<void>, isRunning: boolean) => {
    runnerRef.current = runFn
    setRunnerIsRunning((prev) => (prev === isRunning ? prev : isRunning))
  }, [])

  useEffect(() => {
    setCurrentQAppKey(readCurrentQAppKey(projectId))
  }, [projectId])

  useEffect(() => {
    persistCurrentQAppKey(projectId, currentQAppKey)
  }, [currentQAppKey, projectId])

  useEffect(() => {
    const previousActiveCategory = previousActiveCategoryRef.current
    previousActiveCategoryRef.current = activeCategory

    if (activeCategory !== 'inspection') {
      return
    }

    if (previousActiveCategory === 'inspection') {
      return
    }

    if (!isBuiltinDuplicateCheckQApp(currentQAppKey)) {
      setCurrentQAppKey(BUILTIN_DUPLICATE_CHECK_QAPP_KEY)
    }
  }, [activeCategory, currentQAppKey])

  const handleHy3dParamsChange = useCallback(
    (partial: Partial<import('../pages/ChatPage/hy3d/types').Hy3dParams>) => {
      setHy3dParams((prev) => {
        const next = { ...prev, ...partial }
        saveHy3dParams(next)
        return next
      })
    },
    []
  )

  const handleHy3dMediaStateChange = useCallback(
    (partial: Partial<import('../pages/ChatPage/hy3d/types').Hy3dMediaState>) => {
      setHy3dMediaState((prev) => {
        const next = { ...prev, ...partial }
        hy3dDraftMediaStateCache = next
        saveHy3dMediaState(next)
        return next
      })
    },
    []
  )

  const handleHy3dGenerate = useCallback(async () => {
    const attachments = buildHy3dGenerateAttachments(hy3dParams, hy3dMediaState)
    const content = buildSharedHy3dSubmissionContent(hy3dParams)

    if (!content && attachments.length === 0) {
      notifyWarning(getSharedHy3dMissingInputMessage(hy3dParams))
      return
    }

    const submissionConflictMessage = getHy3dSubmissionConflictMessage(
      hy3dParams,
      content,
      attachments.length
    )
    if (submissionConflictMessage) {
      notifyWarning(submissionConflictMessage)
      return
    }

    const progressMessageKey = notifyInfo('Hunyuan3D 正在生成，请稍候…', null)
    console.log('[SidePanel] Hy3D generation started', {
      apiAction: hy3dParams.apiAction,
      projectId,
      attachmentCount: attachments.length
    })

    try {
      const nextParams = await refreshHy3dModelUrlIfNeeded(hy3dParams)
      const result = await requestChatCompletion({
        config,
        messages: [
          {
            role: 'user',
            content,
            attachments
          }
        ],
        profileId: buildHy3dProfileId(nextParams)
      })
      const assistantMessage = buildAssistantMessageFromResult({
        content: (result.content || '').replace(/file:\/\/\//g, 'local-media:///'),
        attachments: result.attachments,
        ocrResult: result.ocrResult
      })
      const modelAttachments = (assistantMessage.attachments || []).filter(isModel3DAttachment)
      const isPartSplitAction = nextParams.apiAction === 'SubmitHunyuan3DPartJob'

      if (isPartSplitAction) {
        console.info('[SidePanel] Hy3D part split parsed response', {
          rawContent: result.content || '',
          attachmentCount: assistantMessage.attachments?.length || 0,
          modelAttachmentCount: modelAttachments.length,
          attachments: (assistantMessage.attachments || []).map(summarizeHy3dAttachmentForLog)
        })
      }

      if (modelAttachments.length === 0) {
        throw new Error(assistantMessage.content || 'Hunyuan3D 未返回可用的 3D 模型')
      }

      const primaryModel = pickPrimaryModelAttachment(modelAttachments)
      const canvasModels = isPartSplitAction ? modelAttachments : [primaryModel]

      if (!isPartSplitAction) {
        handleHy3dParamsChange({
          modelUrl: primaryModel.url,
          modelSourceFileName: primaryModel.fileName || '',
          modelStorageKey: '',
          modelStorageBucket: '',
          modelStorageRegion: '',
          modelSignedUrlExpiresAt: ''
        })
      }

      const hy3dQuickAppKey = getBuiltinHunyuan3DQuickAppKeyForAction(nextParams.apiAction)
      const hy3dSourceParams = { ...nextParams }
      const hy3dSourceMediaState = cloneHy3dMediaState(hy3dMediaState)

      canvasModels.forEach((modelAttachment, index) => {
        window.dispatchEvent(
          new CustomEvent('canvas:add-model3d', {
            detail: {
              src: modelAttachment.url,
              fileName: modelAttachment.fileName,
              projectId,
              select: index === canvasModels.length - 1,
              hy3dQuickAppKey,
              hy3dParams: hy3dSourceParams,
              hy3dMediaState: hy3dSourceMediaState,
              ...(isPartSplitAction
                ? {
                    width: HY3D_PART_RESULT_CANVAS_MODEL_SIZE,
                    height: HY3D_PART_RESULT_CANVAS_MODEL_SIZE
                  }
                : {}),
              ...(isPartSplitAction
                ? getHy3dPartResultCanvasOffset(index, canvasModels.length)
                : {})
            }
          })
        )
      })

      console.log('[SidePanel] Hy3D generation completed', {
        fileName: primaryModel.fileName,
        modelUrl: primaryModel.url,
        modelCount: canvasModels.length
      })
      if (assistantMessage.content) {
        console.info('[SidePanel] Hy3D response note:', assistantMessage.content)
      }
      notifySuccess(projectId ? '3D 模型已添加到画布。' : '3D 模型已生成。')
    } catch (error) {
      console.error('[SidePanel] Hy3D generation failed:', error)
      notifyError(getFriendlyHy3dRuntimeError(error))
    } finally {
      closeMessage(progressMessageKey)
    }
  }, [
    closeMessage,
    config,
    handleHy3dParamsChange,
    hy3dMediaState,
    hy3dParams,
    notifyError,
    notifyInfo,
    notifySuccess,
    notifyWarning,
    projectId
  ])

  useEffect(() => {
    const handleSwitchQApp = (event: Event) => {
      const detail = (event as CustomEvent<SwitchQAppDetail>).detail
      setCurrentQAppKey(detail.qAppKey)

      if (detail.workflow) {
        emitWorkflowFill(detail.workflow)
      }
    }

    window.addEventListener('qapp:switch', handleSwitchQApp)
    return () => {
      window.removeEventListener('qapp:switch', handleSwitchQApp)
    }
  }, [])

  useEffect(() => {
    const handleParamsUpdated = (event: Event) => {
      const nextParams = (
        event as CustomEvent<{ params?: import('../pages/ChatPage/hy3d/types').Hy3dParams }>
      ).detail?.params

      if (!nextParams) {
        return
      }

      setHy3dParams((prev) => {
        const mergedParams = { ...prev, ...nextParams }
        saveHy3dParams(mergedParams)
        return mergedParams
      })
    }

    window.addEventListener('hy3d:params-updated', handleParamsUpdated)
    return () => window.removeEventListener('hy3d:params-updated', handleParamsUpdated)
  }, [])

  useEffect(() => {
    const handleMediaStateUpdated = (event: Event) => {
      const nextMediaState = (
        event as CustomEvent<{ mediaState?: import('../pages/ChatPage/hy3d/types').Hy3dMediaState }>
      ).detail?.mediaState

      if (!nextMediaState) {
        return
      }

      const clonedMediaState = cloneHy3dMediaState(nextMediaState)
      hy3dDraftMediaStateCache = clonedMediaState
      saveHy3dMediaState(clonedMediaState)
      setHy3dMediaState(clonedMediaState)
    }

    window.addEventListener('hy3d:media-state-updated', handleMediaStateUpdated)
    return () => window.removeEventListener('hy3d:media-state-updated', handleMediaStateUpdated)
  }, [])

  useEffect(() => {
    if (isHy3dConceptAction(hy3dParams.apiAction)) {
      preferredHy3dConceptApiActionRef.current = hy3dParams.apiAction
    }
  }, [hy3dParams.apiAction])

  useEffect(() => {
    if (!isBuiltinHunyuan3DWorkflowKey(currentQAppKey)) {
      return
    }

    const stepId = getBuiltinHunyuan3DStepId(currentQAppKey)
    if (stepId === 'concept') {
      if (isHy3dConceptAction(hy3dParams.apiAction)) {
        return
      }

      handleHy3dParamsChange({
        apiAction: preferredHy3dConceptApiActionRef.current
      })
      return
    }

    const step = WORKFLOW_STEPS.find((item) => item.id === stepId)
    if (!step?.apiAction || hy3dParams.apiAction === step.apiAction) {
      return
    }

    handleHy3dParamsChange({
      apiAction: step.apiAction
    })
  }, [currentQAppKey, handleHy3dParamsChange, hy3dParams.apiAction])

  const renderExpandedContent = useCallback(
    (key: string) =>
      isBuiltinHunyuan3DWorkflowKey(key) ? (
        <Box
          sx={{
            '& .hy3d-panel-shell': {
              height: 'auto',
              minHeight: 0,
              bgcolor: 'transparent'
            },
            '& .hy3d-panel-shell-header': {
              display: 'none'
            },
            '& .hy3d-panel-shell-body': {
              px: 1.5,
              py: 1.25,
              overflow: 'visible',
              flex: 'none'
            }
          }}
        >
          <Suspense fallback={<LoadingFallback />}>
            <Hunyuan3DSidePanelLazy
              params={hy3dParams}
              mediaState={hy3dMediaState}
              onParamsChange={handleHy3dParamsChange}
              onMediaStateChange={handleHy3dMediaStateChange}
              onGenerate={handleHy3dGenerate}
              inline
              stepId={getBuiltinHunyuan3DStepId(key)}
            />
          </Suspense>
        </Box>
      ) : isBuiltinDuplicateCheckQApp(key) ? (
        <DuplicateCheckWorkspace projectId={projectId} inline onRunReady={handleRunReady} />
      ) : (
        <QAppContextProvider key={key} qAppKey={key}>
          <PromptTagProvider>
            <InlineQAppParams projectId={projectId} onRunReady={handleRunReady} />
          </PromptTagProvider>
        </QAppContextProvider>
      ),
    [
      handleHy3dGenerate,
      handleHy3dMediaStateChange,
      handleHy3dParamsChange,
      handleRunReady,
      hy3dMediaState,
      hy3dParams,
      projectId
    ]
  )

  const handleRunClick = useCallback(
    (key: string) => {
      if (isBuiltinDuplicateCheckQApp(key)) {
        if (key !== currentQAppKey) {
          setCurrentQAppKey(key)
          return
        }

        runnerRef.current()
        return
      }

      if (isBuiltinHunyuan3DWorkflowKey(key)) {
        if (key !== currentQAppKey) {
          setCurrentQAppKey(key)
          return
        }

        handleHy3dGenerate()
        return
      }

      if (key !== currentQAppKey) {
        setCurrentQAppKey(key)
        return
      }

      runnerRef.current()
    },
    [currentQAppKey, handleHy3dGenerate]
  )

  const showHunyuanHint =
    activeCategory === 'model3d' &&
    isBuiltinHunyuan3DMenuKey(currentQAppKey) &&
    !isHunyuanConfigured(config)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, minWidth: 0 }}>
        <Collapse in={showHunyuanHint} timeout={120} unmountOnExit>
          <Box sx={{ px: 1.5, pt: 1.5 }}>
            <Alert
              severity="info"
              sx={{ mb: 1.5, alignItems: 'center' }}
              action={
                <Button size="small" variant="outlined" onClick={openQuickAppSettings}>
                  {qt('quickapp.workspace.open_quickapp_api', '打开快应用 API')}
                </Button>
              }
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {qt('quickapp.workspace.hunyuan_hint_title', 'Hunyuan3D 位于快应用')}
              </Typography>
              <Typography variant="body2">
                {qt(
                  'quickapp.workspace.hunyuan_hint',
                  '请在左侧快应用列表中切换到 3D 分类后选择 Hunyuan3D。相关 API 凭证在“快应用 API”里配置。'
                )}
              </Typography>
            </Alert>
          </Box>
        </Collapse>
        <Suspense fallback={<LoadingFallback />}>
          <QAppMenu
            currentQAppKey={currentQAppKey}
            setCurrentQAppKey={setCurrentQAppKey}
            activeCategory={activeCategory}
            onRunClick={handleRunClick}
            isRunning={runnerIsRunning}
            renderExpandedContent={renderExpandedContent}
          />
        </Suspense>
      </Box>

      <Box
        sx={(theme) => ({
          height: 28,
          bgcolor: theme.palette.background.paper,
          flexShrink: 0
        })}
      />
    </Box>
  )
}

const ExplorerSidePanel: React.FC = () => (
  <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
    <Suspense fallback={<LoadingFallback />}>
      <ModelPage compact />
    </Suspense>
  </Box>
)

const Hunyuan3DSidePanelLazy = lazy(() => import('../pages/ChatPage/Hunyuan3DPanel'))

const panelMap: Record<
  string,
  { title: string; Component: React.FC<{ projectId?: string; activeCategory?: QuickAppCategory }> }
> = {
  quickapp: { title: 'Quick App', Component: QuickAppSidePanel },
  explorer: { title: 'Explorer', Component: ExplorerSidePanel }
}

interface SidePanelProps {
  width?: number
  projectId?: string
}

const SidePanel: React.FC<SidePanelProps> = ({ width = SIDE_PANEL_DEFAULT_WIDTH, projectId }) => {
  const dispatch = useAppDispatch()
  const activeSidePanel = useAppSelector((s) => s.layout.activeSidePanel)
  const { notifySuccess, notifyError } = useMessage()
  const { t, i18n } = useTranslation()
  const qt = useCallback(
    (key: string, fallback: string) => getLocalizedFallbackText(t, i18n.language, key, fallback),
    [i18n.language, t]
  )
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const queueText = {
    expand: isChineseUi ? '展开队列详情' : 'Expand queue details',
    collapse: isChineseUi ? '收起队列' : 'Collapse queue',
    running: isChineseUi ? '运行中' : 'Running',
    cancelAllRunning: isChineseUi ? '取消全部运行中任务' : 'Cancel all running tasks',
    cancelAllRunningSuccess: isChineseUi ? '已取消全部运行中任务' : 'Cancelled all running tasks',
    cancelSingleSuccess: isChineseUi ? '已取消任务' : 'Cancelled task',
    cancelFailed: isChineseUi ? '取消失败' : 'Cancel failed',
    pending: isChineseUi ? '排队中' : 'Pending',
    failed: isChineseUi ? '失败' : 'Failed',
    clearAll: isChineseUi ? '清除全部' : 'Clear all'
  }
  const statusText = {
    connected: isChineseUi ? '已连接到 ComfyUI' : 'Connected to ComfyUI',
    refresh: isChineseUi ? '刷新状态' : 'Refresh status',
    reconnect: isChineseUi
      ? 'ComfyUI 已离线，点击重新连接'
      : 'ComfyUI is offline, click to reconnect'
  }
  const {
    state: { isConnected },
    setIsConnected,
    setObjectInfos
  } = useComfyStatus()

  const [queueState, setQueueState] = useState<QueueState>({
    queue_running: [],
    queue_pending: [],
    queue_error: []
  })
  const [animationStates, setAnimationStates] = useState<QueueAnimationStates>({})
  const [queueExpanded, setQueueExpanded] = useState(false)
  const [quickAppCategory, setQuickAppCategory] = useState<QuickAppCategory>(() =>
    isBuiltinHunyuan3DMenuKey(readCurrentQAppKey(projectId)) ? 'model3d' : 'image'
  )
  const [quickAppCategoryAvailableWidth, setQuickAppCategoryAvailableWidth] = useState(() =>
    Math.max(0, width - 120)
  )
  const [quickAppOverflowAnchorEl, setQuickAppOverflowAnchorEl] = useState<HTMLElement | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const nextReconnectAllowedAtRef = useRef(0)
  const isConnectedRef = useRef(isConnected)
  const quickAppTitleRef = useRef<HTMLElement | null>(null)
  const quickAppQueueBadgeRef = useRef<HTMLDivElement | null>(null)
  const quickAppActionsRef = useRef<HTMLDivElement | null>(null)
  const totalQueue =
    queueState.queue_running.length +
    queueState.queue_pending.length +
    queueState.queue_error.length
  const { visible: visibleQuickAppCategories, overflow: overflowQuickAppCategories } =
    getQuickAppCategoryLayout(quickAppCategoryAvailableWidth)
  const isQuickAppOverflowMenuOpen = Boolean(quickAppOverflowAnchorEl)
  const isQuickAppOverflowActive = overflowQuickAppCategories.includes(quickAppCategory)

  useComfyEventCallback((event) => {
    if (event.type !== 'progress') return

    const { prompt_id, value, max } = event.data
    setAnimationStates((prev) => ({
      ...prev,
      [prompt_id]: { value, max }
    }))
  }, [])

  useEffect(() => {
    setQuickAppCategory(
      isBuiltinHunyuan3DMenuKey(readCurrentQAppKey(projectId)) ? 'model3d' : 'image'
    )
    setQuickAppOverflowAnchorEl(null)
  }, [projectId])

  useEffect(() => {
    if (activeSidePanel !== 'quickapp') {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const measuredTitleWidth = quickAppTitleRef.current?.getBoundingClientRect().width ?? 0
      const measuredQueueBadgeWidth =
        quickAppQueueBadgeRef.current?.getBoundingClientRect().width ?? 0
      const measuredActionsWidth = quickAppActionsRef.current?.getBoundingClientRect().width ?? 0
      const titleWidth =
        measuredTitleWidth > 0 ? measuredTitleWidth : QUICK_APP_HEADER_TITLE_FALLBACK_WIDTH
      const queueBadgeWidth =
        measuredQueueBadgeWidth > 0
          ? measuredQueueBadgeWidth
          : totalQueue > 0
            ? QUICK_APP_HEADER_QUEUE_BADGE_FALLBACK_WIDTH
            : 0
      const actionsWidth =
        measuredActionsWidth > 0 ? measuredActionsWidth : QUICK_APP_HEADER_ACTIONS_FALLBACK_WIDTH
      const availableWidth =
        width -
        QUICK_APP_HEADER_HORIZONTAL_PADDING -
        titleWidth -
        actionsWidth -
        QUICK_APP_HEADER_SECTION_GAP -
        queueBadgeWidth -
        (queueBadgeWidth > 0 ? QUICK_APP_HEADER_SECTION_GAP : 0)

      setQuickAppCategoryAvailableWidth(Math.max(0, Math.floor(availableWidth)))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeSidePanel, i18n.language, totalQueue, width])

  useEffect(() => {
    const handleSwitchQApp = (event: Event) => {
      const detail = (event as CustomEvent<SwitchQAppDetail>).detail
      if (isBuiltinHunyuan3DMenuKey(detail.qAppKey)) {
        setQuickAppCategory('model3d')
      }
    }

    window.addEventListener('qapp:switch', handleSwitchQApp)
    return () => {
      window.removeEventListener('qapp:switch', handleSwitchQApp)
    }
  }, [])

  const silentRefresh = useCallback(async () => {
    const now = Date.now()
    if (!isConnectedRef.current && now < nextReconnectAllowedAtRef.current) {
      return false
    }

    try {
      const objectInfo = await api().svcComfy.getObjectInfo({})
      const wasDisconnected = !isConnected

      setIsConnected(true)
      setObjectInfos(objectInfo)
      reconnectAttemptsRef.current = 0
      nextReconnectAllowedAtRef.current = 0

      if (wasDisconnected) {
        window.dispatchEvent(new CustomEvent('qapp:refresh-list'))
      }

      return true
    } catch {
      setIsConnected(false)
      const nextAttempt = reconnectAttemptsRef.current + 1
      nextReconnectAllowedAtRef.current = Date.now() + Math.min(30000, 5000 * nextAttempt)
      return false
    }
  }, [isConnected, setIsConnected, setObjectInfos])

  const _refreshStatusLegacy = useCallback(async () => {
    const ok = await silentRefresh()
    if (ok) notifySuccess('宸茶繛鎺ュ埌 ComfyUI')
    return ok
  }, [notifySuccess, silentRefresh])

  const refreshStatus = useCallback(async () => {
    const ok = await silentRefresh()
    if (ok) notifySuccess(statusText.connected)
    return ok
  }, [notifySuccess, silentRefresh, statusText.connected])

  useEffect(() => {
    setAnimationStates((prev) => pruneQueueAnimationStates(prev, queueState.queue_running))
  }, [queueState.queue_running])

  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  useEffect(() => {
    if (activeSidePanel !== 'quickapp') {
      reconnectAttemptsRef.current = 0
      return
    }

    if (isConnected) {
      reconnectAttemptsRef.current = 0
    }

    if (!isConnected && reconnectAttemptsRef.current < 3) {
      silentRefresh().then((ok) => {
        if (!ok) reconnectAttemptsRef.current += 1
      })
    }

    const timer = setInterval(async () => {
      await silentRefresh()
    }, 5000)

    return () => clearInterval(timer)
  }, [activeSidePanel, silentRefresh, isConnected])

  useEffect(() => {
    if (activeSidePanel !== 'quickapp') return

    const abortController = new AbortController()
    let abortFn: (() => void) | null = null

    const init = async () => {
      try {
        const { newAbortHandler } = await import('@shared/api/apiUtils/abortHandler')
        const [abortSender, abortReceiver] = newAbortHandler()
        abortFn = () => abortSender.abort()
        const { isEqual } = await import('es-toolkit')

        await api().svcComfy.watchQueue(
          {},
          {
            onData: (resp) => {
              setQueueState((prev) => {
                if (isEqual(prev, resp)) return prev
                return resp
              })
            },
            abortReceiver
          }
        )
      } catch {
        /* ignore queue watch failures */
      }
    }

    init()

    return () => {
      abortFn?.()
      abortController.abort()
    }
  }, [activeSidePanel])

  const handleQuickAppCategorySelect = useCallback((category: QuickAppCategory) => {
    setQuickAppCategory(category)
    setQuickAppOverflowAnchorEl(null)
  }, [])

  const handleQuickAppOverflowOpen = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setQuickAppOverflowAnchorEl(event.currentTarget)
  }, [])

  const handleQuickAppOverflowClose = useCallback(() => {
    setQuickAppOverflowAnchorEl(null)
  }, [])

  if (!activeSidePanel) return null

  const panel = panelMap[activeSidePanel]
  if (!panel) return null

  const { Component } = panel
  const isQuickApp = activeSidePanel === 'quickapp'
  const title = isQuickApp ? qt('quickapp.workspace.title', '快应用') : panel.title
  return (
    <Box
      sx={(theme) => ({
        width,
        minWidth: width,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : '#eaecf5',
        borderRight: `1px solid ${theme.palette.divider}`,
        flexShrink: 0,
        overflow: 'hidden'
      })}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 1,
          minHeight: 36
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, flex: 1 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Typography
              ref={quickAppTitleRef}
              variant="caption"
              sx={{
                fontWeight: 700,
                letterSpacing: 0.8,
                fontSize: 13,
                color: 'text.secondary',
                whiteSpace: 'nowrap'
              }}
            >
              {title}
            </Typography>
          </Box>
          {isQuickApp && (
            <Box
              sx={(theme) => {
                const isLight = theme.palette.mode === 'light'
                return {
                  p: 0.5,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  borderRadius: 999,
                  border: isLight
                    ? '1px solid rgba(148,163,184,0.3)'
                    : '1px solid rgba(255,255,255,0.08)',
                  bgcolor: isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.03)',
                  boxShadow: isLight
                    ? 'inset 0 1px 0 rgba(255,255,255,0.72)'
                    : 'inset 0 1px 0 rgba(255,255,255,0.03)'
                }
              }}
            >
              {visibleQuickAppCategories.map((category) => {
                const isActive = quickAppCategory === category
                return (
                  <Button
                    key={category}
                    size="small"
                    variant="text"
                    onClick={() => handleQuickAppCategorySelect(category)}
                    startIcon={QUICK_APP_CATEGORY_ICONS[category]}
                    sx={(theme) => {
                      const isLight = theme.palette.mode === 'light'
                      return {
                        minWidth: 0,
                        px: 1.1,
                        py: 0.45,
                        gap: 0.5,
                        borderRadius: 999,
                        textTransform: 'none',
                        lineHeight: 1.1,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: 0,
                        whiteSpace: 'nowrap',
                        color: isActive
                          ? '#f8fbff'
                          : isLight
                            ? 'rgba(51,65,85,0.92)'
                            : 'rgba(226,232,240,0.78)',
                        bgcolor: isActive
                          ? isLight
                            ? theme.palette.primary.main
                            : 'rgba(96,165,250,0.2)'
                          : isLight
                            ? 'rgba(255,255,255,0.28)'
                            : 'transparent',
                        border: isActive
                          ? `1px solid ${
                              isLight ? theme.palette.primary.dark : 'rgba(96,165,250,0.42)'
                            }`
                          : `1px solid ${isLight ? 'rgba(148,163,184,0.22)' : 'transparent'}`,
                        boxShadow: isActive
                          ? isLight
                            ? '0 8px 18px rgba(73,103,184,0.22)'
                            : '0 6px 18px rgba(37,99,235,0.18)'
                          : 'none',
                        backdropFilter: isActive ? 'blur(8px)' : 'none',
                        '& .MuiButton-startIcon': {
                          margin: 0
                        },
                        '&:hover': {
                          bgcolor: isActive
                            ? isLight
                              ? theme.palette.primary.dark
                              : 'rgba(96,165,250,0.24)'
                            : isLight
                              ? 'rgba(255,255,255,0.72)'
                              : 'rgba(255,255,255,0.06)',
                          borderColor: isActive
                            ? isLight
                              ? theme.palette.primary.dark
                              : 'rgba(125,211,252,0.5)'
                            : isLight
                              ? 'rgba(105,136,230,0.34)'
                              : 'rgba(255,255,255,0.08)'
                        }
                      }
                    }}
                  >
                    {QUICK_APP_CATEGORY_LABELS[category]}
                  </Button>
                )
              })}
              {overflowQuickAppCategories.length > 0 && (
                <>
                  <Tooltip title={qt('quickapp.workspace.more_categories', '更多分类')} arrow>
                    <Button
                      size="small"
                      variant="text"
                      aria-label={qt('quickapp.workspace.more_categories', '更多分类')}
                      aria-haspopup="menu"
                      aria-expanded={isQuickAppOverflowMenuOpen ? 'true' : undefined}
                      onClick={handleQuickAppOverflowOpen}
                      sx={(theme) => {
                        const isLight = theme.palette.mode === 'light'
                        return {
                          minWidth: 0,
                          px: 0.9,
                          py: 0.45,
                          borderRadius: 999,
                          textTransform: 'none',
                          lineHeight: 1.1,
                          fontSize: 12,
                          fontWeight: 700,
                          letterSpacing: 0,
                          color: isQuickAppOverflowActive
                            ? '#f8fbff'
                            : isLight
                              ? 'rgba(51,65,85,0.92)'
                              : 'rgba(226,232,240,0.78)',
                          bgcolor: isQuickAppOverflowActive
                            ? isLight
                              ? theme.palette.primary.main
                              : 'rgba(96,165,250,0.2)'
                            : isLight
                              ? 'rgba(255,255,255,0.28)'
                              : 'transparent',
                          border: isQuickAppOverflowActive
                            ? `1px solid ${
                                isLight ? theme.palette.primary.dark : 'rgba(96,165,250,0.42)'
                              }`
                            : `1px solid ${isLight ? 'rgba(148,163,184,0.22)' : 'transparent'}`,
                          boxShadow: isQuickAppOverflowActive
                            ? isLight
                              ? '0 8px 18px rgba(73,103,184,0.22)'
                              : '0 6px 18px rgba(37,99,235,0.18)'
                            : 'none',
                          backdropFilter: isQuickAppOverflowActive ? 'blur(8px)' : 'none',
                          '&:hover': {
                            bgcolor: isQuickAppOverflowActive
                              ? isLight
                                ? theme.palette.primary.dark
                                : 'rgba(96,165,250,0.24)'
                              : isLight
                                ? 'rgba(255,255,255,0.72)'
                                : 'rgba(255,255,255,0.06)',
                            borderColor: isQuickAppOverflowActive
                              ? isLight
                                ? theme.palette.primary.dark
                                : 'rgba(125,211,252,0.5)'
                              : isLight
                                ? 'rgba(105,136,230,0.34)'
                                : 'rgba(255,255,255,0.08)'
                          }
                        }
                      }}
                    >
                      <MoreHorizIcon sx={{ fontSize: 16 }} />
                    </Button>
                  </Tooltip>
                  <Menu
                    anchorEl={quickAppOverflowAnchorEl}
                    open={isQuickAppOverflowMenuOpen}
                    onClose={handleQuickAppOverflowClose}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                    transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                  >
                    {overflowQuickAppCategories.map((category) => (
                      <MenuItem
                        key={category}
                        selected={quickAppCategory === category}
                        onClick={() => handleQuickAppCategorySelect(category)}
                      >
                        <ListItemIcon sx={{ minWidth: 28 }}>
                          {QUICK_APP_CATEGORY_ICONS[category]}
                        </ListItemIcon>
                        <ListItemText>{QUICK_APP_CATEGORY_LABELS[category]}</ListItemText>
                      </MenuItem>
                    ))}
                  </Menu>
                </>
              )}
            </Box>
          )}
          {isQuickApp && totalQueue > 0 && (
            <Tooltip title={queueExpanded ? queueText.collapse : queueText.expand} arrow>
              <Box
                ref={quickAppQueueBadgeRef}
                onClick={() => setQueueExpanded((value) => !value)}
                sx={(theme) => ({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1.25,
                  py: 0.4,
                  borderRadius: '12px',
                  bgcolor:
                    queueState.queue_error.length > 0
                      ? theme.palette.mode === 'dark'
                        ? 'rgba(211, 47, 47, 0.2)'
                        : 'rgba(211, 47, 47, 0.1)'
                      : queueState.queue_running.length > 0
                        ? theme.palette.mode === 'dark'
                          ? 'rgba(0, 120, 212, 0.2)'
                          : 'rgba(0, 120, 212, 0.1)'
                        : theme.palette.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.08)'
                          : 'rgba(0, 0, 0, 0.06)',
                  color:
                    queueState.queue_error.length > 0
                      ? theme.palette.mode === 'dark'
                        ? '#ff8a80'
                        : '#d32f2f'
                      : queueState.queue_running.length > 0
                        ? theme.palette.mode === 'dark'
                          ? '#64b5f6'
                          : '#1976d2'
                        : 'text.secondary',
                  border: '1px solid',
                  borderColor:
                    queueState.queue_error.length > 0
                      ? theme.palette.mode === 'dark'
                        ? 'rgba(211, 47, 47, 0.3)'
                        : 'rgba(211, 47, 47, 0.2)'
                      : queueState.queue_running.length > 0
                        ? theme.palette.mode === 'dark'
                          ? 'rgba(0, 120, 212, 0.3)'
                          : 'rgba(0, 120, 212, 0.2)'
                        : theme.palette.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.1)'
                          : 'rgba(0, 0, 0, 0.08)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    transform: 'translateY(-1px)',
                    boxShadow:
                      theme.palette.mode === 'dark'
                        ? '0 2px 8px rgba(0,0,0,0.4)'
                        : '0 2px 6px rgba(0,0,0,0.08)'
                  }
                })}
              >
                {totalQueue}
              </Box>
            </Tooltip>
          )}
        </Box>
        <Box ref={quickAppActionsRef} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {isQuickApp && (
            <Tooltip title={isConnected ? statusText.refresh : statusText.reconnect} arrow>
              <IconButton
                size="small"
                onClick={refreshStatus}
                sx={{
                  p: 0.25,
                  color: isConnected ? 'text.secondary' : 'error.main',
                  ...(!isConnected && {
                    animation: 'pulse-red 1.5s ease-in-out infinite',
                    '@keyframes pulse-red': {
                      '0%, 100%': { opacity: 0.4 },
                      '50%': { opacity: 1 }
                    }
                  })
                }}
              >
                <RefreshIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <IconButton size="small" onClick={() => dispatch(closeSidePanel())} sx={{ p: 0.25 }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      </Box>

      {isQuickApp && queueExpanded && totalQueue > 0 && (
        <Box
          sx={(theme) => ({
            px: 1.5,
            py: 1.5,
            maxHeight: 280,
            overflowY: 'auto',
            bgcolor: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.02)',
            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)'
          })}
        >
          {queueState.queue_running.length > 0 && (
            <Box sx={{ mb: 1.5 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mb: 0.75
                }}
              >
                <Typography
                  sx={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'primary.main',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5
                  }}
                >
                  {queueText.running} ({queueState.queue_running.length})
                </Typography>
                <IconButton
                  size="small"
                  onClick={async () => {
                    try {
                      await Promise.all(
                        queueState.queue_running.map((item) =>
                          api().svcComfy.cancelQueueItem({ prompt_id: item[1] })
                        )
                      )
                      notifySuccess(queueText.cancelAllRunningSuccess)
                    } catch {
                      notifyError(queueText.cancelFailed)
                    }
                  }}
                  title={queueText.cancelAllRunning}
                  sx={(theme) => ({
                    p: 0.25,
                    color: 'error.main',
                    bgcolor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(211, 47, 47, 0.1)'
                        : 'rgba(211, 47, 47, 0.05)',
                    '&:hover': { bgcolor: 'error.main', color: '#fff' }
                  })}
                >
                  <CloseIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Box>
              <Stack spacing={0.75}>
                {queueState.queue_running.map((item) => {
                  const promptId = item[1]
                  const displayLabel = getQueueItemDisplayLabel(item)
                  const itemProgress = getQueueItemProgress(animationStates, promptId)
                  return (
                    <Box
                      key={`running-${promptId}`}
                      sx={(theme) => ({
                        display: 'flex',
                        flexDirection: 'column',
                        py: 0.75,
                        px: 1.25,
                        borderRadius: '8px',
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(0, 120, 212, 0.1)'
                            : 'rgba(0, 120, 212, 0.05)',
                        border: '1px solid',
                        borderColor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(0, 120, 212, 0.2)'
                            : 'rgba(0, 120, 212, 0.15)'
                      })}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                        <Typography
                          title={promptId}
                          noWrap
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 10.5,
                            color: 'text.primary',
                            fontFamily: 'monospace',
                            opacity: 0.9
                          }}
                        >
                          {displayLabel}
                        </Typography>
                        <Typography
                          sx={{
                            flexShrink: 0,
                            fontSize: 10.5,
                            fontWeight: 700,
                            color: itemProgress === null ? 'text.secondary' : 'primary.main'
                          }}
                        >
                          {itemProgress === null
                            ? queueText.running
                            : `${Math.round(itemProgress * 100)}%`}
                        </Typography>
                      </Box>
                      <LinearProgress
                        variant={itemProgress === null ? 'indeterminate' : 'determinate'}
                        value={(itemProgress ?? 0) * 100}
                        sx={{
                          mt: 0.85,
                          height: 4,
                          borderRadius: 999,
                          bgcolor: 'rgba(148,163,184,0.18)',
                          '& .MuiLinearProgress-bar': {
                            borderRadius: 999
                          }
                        }}
                      />
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}

          {queueState.queue_pending.length > 0 && (
            <Box sx={{ mb: 1.5 }}>
              <Typography
                sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', mb: 0.75, px: 0.5 }}
              >
                {queueText.pending} ({queueState.queue_pending.length})
              </Typography>
              <Stack spacing={0.75}>
                {queueState.queue_pending.map((item) => {
                  const promptId = item[1]
                  const displayLabel = getQueueItemDisplayLabel(item)
                  return (
                    <Box
                      key={promptId}
                      sx={(theme) => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        py: 0.5,
                        px: 1.25,
                        borderRadius: '8px',
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(255,255,255,0.03)'
                            : 'rgba(0,0,0,0.02)',
                        border: '1px solid',
                        borderColor: 'divider'
                      })}
                    >
                      <Typography
                        title={promptId}
                        noWrap
                        sx={{
                          flex: 1,
                          minWidth: 0,
                          mr: 1,
                          fontSize: 10.5,
                          color: 'text.disabled',
                          fontFamily: 'monospace'
                        }}
                      >
                        {displayLabel}
                      </Typography>
                      <IconButton
                        size="small"
                        onClick={async () => {
                          try {
                            await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
                            notifySuccess(queueText.cancelSingleSuccess)
                          } catch {
                            notifyError(queueText.cancelFailed)
                          }
                        }}
                        sx={{
                          p: 0.25,
                          opacity: 0.5,
                          '&:hover': { opacity: 1, color: 'error.main' }
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 12 }} />
                      </IconButton>
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}

          {queueState.queue_error.length > 0 && (
            <Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mb: 0.75,
                  px: 0.5
                }}
              >
                <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'error.main' }}>
                  {queueText.failed} ({queueState.queue_error.length})
                </Typography>
                <Typography
                  onClick={async () => {
                    try {
                      await Promise.all(
                        queueState.queue_error.map((item) =>
                          api().svcComfy.cancelQueueItem({ prompt_id: item[1] })
                        )
                      )
                    } catch {
                      // ignore
                    }
                  }}
                  sx={{
                    fontSize: 10,
                    color: 'text.disabled',
                    cursor: 'pointer',
                    '&:hover': { color: 'error.main', textDecoration: 'underline' }
                  }}
                >
                  {queueText.clearAll}
                </Typography>
              </Box>
              <Stack spacing={0.75}>
                {queueState.queue_error.map((item) => {
                  const promptId = item[1]
                  const displayLabel = getQueueItemDisplayLabel(item)
                  return (
                    <Box
                      key={promptId}
                      sx={(theme) => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        py: 0.5,
                        px: 1.25,
                        borderRadius: '8px',
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(211, 47, 47, 0.05)'
                            : 'rgba(211, 47, 47, 0.03)',
                        border: '1px solid',
                        borderColor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(211, 47, 47, 0.2)'
                            : 'rgba(211, 47, 47, 0.15)'
                      })}
                    >
                      <Typography
                        title={promptId}
                        noWrap
                        sx={{
                          flex: 1,
                          minWidth: 0,
                          mr: 1,
                          fontSize: 10.5,
                          color: 'error.main',
                          fontFamily: 'monospace'
                        }}
                      >
                        {displayLabel}
                      </Typography>
                      <IconButton
                        size="small"
                        onClick={async () => {
                          try {
                            await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
                          } catch {
                            // ignore
                          }
                        }}
                        sx={{
                          p: 0.25,
                          color: 'error.main',
                          opacity: 0.7,
                          '&:hover': { opacity: 1, bgcolor: 'error.main', color: '#fff' }
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 12 }} />
                      </IconButton>
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}
        </Box>
      )}

      <Box sx={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Component projectId={projectId} activeCategory={quickAppCategory} />
      </Box>
    </Box>
  )
}

;(
  SidePanel as React.FC<SidePanelProps> & { __resetHy3dDraftMediaStateForTests: () => void }
).__resetHy3dDraftMediaStateForTests = resetHy3dDraftMediaStateForTests

export { SIDE_PANEL_DEFAULT_WIDTH }
export default SidePanel
