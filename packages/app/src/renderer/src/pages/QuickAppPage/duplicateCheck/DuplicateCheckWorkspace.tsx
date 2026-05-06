import React from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Popover,
  Slider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import {
  FactCheckOutlined as FactCheckOutlinedIcon,
  FolderOpenOutlined as FolderOpenOutlinedIcon,
  ImageOutlined as ImageOutlinedIcon,
  SettingsOutlined as SettingsOutlinedIcon,
  FileDownloadOutlined as FileDownloadOutlinedIcon,
  MyLocationOutlined as MyLocationOutlinedIcon,
  UploadOutlined as UploadOutlinedIcon,
  RefreshOutlined as RefreshOutlinedIcon
} from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { openTab, setActiveTab } from '@renderer/store/slices/layoutSlice'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import {
  getDroppedImageDropError,
  getDroppedImageFile,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'
import {
  activateQuickAppImagePasteTarget,
  deactivateQuickAppImagePasteTarget
} from '@renderer/utils/quickAppPasteTarget'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type {
  DuplicateCheckComparableImage,
  DuplicateCheckRunResult
} from '@shared/api/svcDuplicateCheck'
import {
  DEFAULT_DUPLICATE_CHECK_SETTINGS,
  DUPLICATE_CHECK_THRESHOLD_PRESETS,
  type DuplicateCheckMethod,
  type DuplicateCheckThresholdPreset,
  type DuplicateCheckVisualModelConfig
} from '@shared/duplicateCheck/types'
import type { TabItem } from '@renderer/store/slices/layoutSlice'
import { loadCanvasItems } from '@renderer/pages/ProjectCanvasPage/canvasStorage'
import type { CanvasImageItem } from '@renderer/pages/ProjectCanvasPage/types'
import {
  CANVAS_DUPLICATE_CHECK_FOCUS_EVENT,
  CANVAS_DUPLICATE_CHECK_RUNTIME_EVENT,
  readCanvasDuplicateCheckRuntimeSnapshot,
  type CanvasDuplicateCheckRuntimeSnapshot
} from '@renderer/pages/ProjectCanvasPage/canvasDuplicateCheckRuntime'
import { toProjectCanvasRoutePath } from '@renderer/pages/ProjectCanvasPage/projectCanvasRouting'
import {
  buildClientImageFromCanvasItem,
  buildClientImageFromFile,
  inferMimeTypeFromName,
  type DuplicateCheckClientImage
} from './imageSource'

type ScopeMode = 'folder' | 'canvas' | 'selection'

type QueryDropZoneProps = {
  disabled?: boolean
  onFiles: (files: File[], meta?: Partial<DuplicateCheckComparableImage>) => Promise<void>
}

const isPasteShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === 'v'

const SVG_MIME_TYPE = 'image/svg+xml'

const buildPastedImageFile = (blob: Blob, index = 0): File => {
  const timestamp = Date.now()
  const extension =
    blob.type === SVG_MIME_TYPE ? 'svg' : blob.type.split('/')[1]?.split('+')[0]?.trim() || 'png'
  return new File([blob], `duplicate-query-${timestamp}-${index + 1}.${extension}`, {
    type: blob.type
  })
}

const buildPastedSvgFile = (markup: string, index = 0): File =>
  buildPastedImageFile(new Blob([markup], { type: SVG_MIME_TYPE }), index)

const looksLikeSvgMarkup = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  return /<svg[\s>]/i.test(trimmed)
}

const getClipboardSvgMarkup = (clipboardData?: DataTransfer | null): string | null => {
  if (!clipboardData) {
    return null
  }

  for (const type of [SVG_MIME_TYPE, 'text/html', 'text/plain', 'text', 'Text']) {
    const value = clipboardData.getData(type)
    if (looksLikeSvgMarkup(value)) {
      return value.trim()
    }
  }

  return null
}

const getClipboardImageFiles = (clipboardData?: DataTransfer | null): File[] => {
  if (!clipboardData) {
    return []
  }

  const directFiles = Array.from(clipboardData.files || []).filter((file) =>
    file.type.startsWith('image/')
  )
  if (directFiles.length > 0) {
    return directFiles
  }

  return Array.from(clipboardData.items || []).flatMap((item, index) => {
    if (!item.type.startsWith('image/')) {
      return []
    }

    const file = item.getAsFile()
    return file ? [buildPastedImageFile(file, index)] : []
  })
}

const readNavigatorClipboardImageFiles = async (): Promise<File[]> => {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return []
  }
  if (typeof navigator.clipboard.read !== 'function') {
    return []
  }

  try {
    const clipItems = await navigator.clipboard.read()
    const files: File[] = []

    for (const clipItem of clipItems) {
      const imageTypes = clipItem.types.filter((type) => type.startsWith('image/'))
      for (const imageType of imageTypes) {
        const blob = await clipItem.getType(imageType)
        files.push(buildPastedImageFile(blob, files.length))
      }

      if (imageTypes.length > 0) {
        continue
      }

      for (const type of [SVG_MIME_TYPE, 'text/html', 'text/plain']) {
        if (!clipItem.types.includes(type)) {
          continue
        }

        const text = await (await clipItem.getType(type)).text()
        if (looksLikeSvgMarkup(text)) {
          files.push(buildPastedSvgFile(text.trim(), files.length))
          break
        }
      }
    }

    return files
  } catch {
    return []
  }
}

const QueryDropZone: React.FC<QueryDropZoneProps> = ({ disabled, onFiles }) => {
  const { notifyError } = useMessage()
  const [isDragging, setIsDragging] = React.useState(false)
  const [isHovered, setIsHovered] = React.useState(false)
  const [isKeyboardFocused, setIsKeyboardFocused] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pasteTargetTokenRef = React.useRef(Symbol('duplicate-check-query-paste-target'))
  const isPasteTargetActive = isHovered || isKeyboardFocused

  const handleFileChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || [])
      if (files.length > 0) {
        await onFiles(files)
      }
      event.target.value = ''
    },
    [onFiles]
  )

  const handleDrop = React.useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setIsDragging(false)

      if (disabled) {
        return
      }

      const dropError = getDroppedImageDropError(event.dataTransfer, { allowSvg: true })
      if (dropError) {
        notifyError(dropError)
        return
      }

      const internalPayload = parseInternalImageDragPayload(event.dataTransfer)
      if (internalPayload) {
        const file = await getDroppedImageFile(event.dataTransfer, { allowSvg: true })
        if (!file) {
          notifyError('无法读取拖入的画布图片')
          return
        }

        await onFiles([file], {
          canvasId: internalPayload.sourceCanvasId,
          sourceUrl: internalPayload.objectUrl,
          originLabel: internalPayload.sourceCanvasId ? '画布拖入' : '内部拖入'
        })
        return
      }

      const droppedFiles = Array.from(event.dataTransfer.files || []).filter((file) =>
        file.type.startsWith('image/')
      )
      if (droppedFiles.length === 0) {
        const singleFile = await getDroppedImageFile(event.dataTransfer, { allowSvg: true })
        if (!singleFile) {
          notifyError('请拖入图片文件')
          return
        }
        await onFiles([singleFile])
        return
      }

      await onFiles(droppedFiles)
    },
    [disabled, notifyError, onFiles]
  )

  const handlePaste = React.useCallback(
    (event: ClipboardEvent) => {
      if (disabled || !isPasteTargetActive) {
        return
      }

      const pastedFiles = getClipboardImageFiles(event.clipboardData)
      if (pastedFiles.length > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void onFiles(pastedFiles)
        return
      }

      const svgMarkup = getClipboardSvgMarkup(event.clipboardData)
      if (svgMarkup) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void onFiles([buildPastedSvgFile(svgMarkup)])
      }
    },
    [disabled, isPasteTargetActive, onFiles]
  )

  const handlePasteShortcut = React.useCallback(
    (event: KeyboardEvent) => {
      if (disabled || !isPasteTargetActive || !isPasteShortcut(event)) {
        return
      }

      if (typeof navigator === 'undefined' || typeof navigator.clipboard?.read !== 'function') {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      void (async () => {
        const files = await readNavigatorClipboardImageFiles()
        if (files.length > 0) {
          await onFiles(files)
        }
      })()
    },
    [disabled, isPasteTargetActive, onFiles]
  )

  React.useEffect(() => {
    const token = pasteTargetTokenRef.current
    if (isPasteTargetActive && !disabled) {
      activateQuickAppImagePasteTarget(token)
    } else {
      deactivateQuickAppImagePasteTarget(token)
    }

    return () => {
      deactivateQuickAppImagePasteTarget(token)
    }
  }, [disabled, isPasteTargetActive])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    document.addEventListener('paste', handlePaste)
    return () => {
      document.removeEventListener('paste', handlePaste)
    }
  }, [handlePaste])

  React.useEffect(() => {
    window.addEventListener('keydown', handlePasteShortcut, true)
    return () => {
      window.removeEventListener('keydown', handlePasteShortcut, true)
    }
  }, [handlePasteShortcut])

  return (
    <Box
      ref={containerRef}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(false)
      }}
      onDrop={(event) => {
        void handleDrop(event)
      }}
      onClick={() => !disabled && fileInputRef.current?.click()}
      onFocus={() => setIsKeyboardFocused(true)}
      onBlur={() => setIsKeyboardFocused(false)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      tabIndex={0}
      sx={{
        borderRadius: 2,
        border: '1px dashed',
        borderColor: isDragging
          ? 'primary.main'
          : isPasteTargetActive
            ? 'primary.light'
            : 'divider',
        minHeight: 132,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        px: 2,
        py: 2,
        bgcolor: isDragging ? 'action.hover' : 'transparent',
        outline: 'none'
      }}
    >
      <Stack spacing={1} alignItems="center" textAlign="center">
        <UploadOutlinedIcon color={disabled ? 'disabled' : 'action'} />
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          从外部拖入 / 粘贴图片，或把画布图片拖到这里
        </Typography>
        <Typography variant="caption" color="text.secondary">
          支持多张查询图，支持 Ctrl/Cmd + V
        </Typography>
      </Stack>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          void handleFileChange(event)
        }}
      />
    </Box>
  )
}

const duplicateCheckMethodLabel: Record<DuplicateCheckMethod, string> = {
  hash: '哈希值',
  visual: '视觉模型',
  robust: '鲁棒性检查'
}

const presetLabel: Record<DuplicateCheckThresholdPreset, string> = {
  strict: '严格',
  balanced: '平衡',
  loose: '宽松'
}

const buildLocalMediaUrl = (fullPath: string): string =>
  `local-media:///${fullPath.replace(/[\\/]+/g, '/').replace(/^\/+/, '')}`

const openQuickAppSettingsTab = (
  dispatch: ReturnType<typeof useAppDispatch>,
  navigate: ReturnType<typeof useNavigate>,
  openTabs: TabItem[]
) => {
  if (!openTabs.some((tab) => tab.id === 'tab-settings')) {
    dispatch(
      openTab({
        id: 'tab-settings',
        label: '设置',
        routePath: '/settings',
        closable: true
      })
    )
  }
  dispatch(setActiveTab('tab-settings'))
  navigate('/settings', { state: { tab: 'plugin' } })
}

const flattenMatchesForExport = (result: DuplicateCheckRunResult) =>
  result.queryResults.flatMap((queryResult) =>
    [...queryResult.exactMatches, ...queryResult.highMatches, ...queryResult.uncertainMatches].map(
      (match) => ({
        queryName: queryResult.query.name,
        matchLevel: match.level,
        targetName: match.target.name,
        targetCanvas: match.target.canvasName || '',
        targetPath: match.target.sourcePath || '',
        reasons: match.reasons.join('|'),
        pHashDistance: match.scores.pHashDistance ?? '',
        dHashDistance: match.scores.dHashDistance ?? '',
        visual: Math.max(0, ...Object.values(match.scores.visualSimilarityByModel || {})),
        robust: Math.max(0, ...Object.values(match.scores.robustnessSimilarityByModel || {}))
      })
    )
  )

const normalizeDuplicateCheckErrorMessage = (error: unknown): string => {
  const rawMessage = error instanceof Error ? error.message : String(error || '')
  const message = rawMessage.trim()

  if (!message) {
    return '\u91cd\u590d\u56fe\u68c0\u67e5\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
  }

  if (message.includes('currentPythonWorker')) {
    return '\u91cd\u590d\u56fe\u68c0\u67e5\u670d\u52a1\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u4e00\u6b21\u3002\u5982\u679c\u4ecd\u7136\u51fa\u9519\uff0c\u53ef\u4ee5\u91cd\u542f\u5e94\u7528\u540e\u518d\u8bd5\u3002'
  }

  if (message.includes('CUDAExecutionProvider')) {
    return '\u5f53\u524d Python \u73af\u5883\u672a\u542f\u7528 CUDA\uff0c\u65e0\u6cd5\u4f7f\u7528 GPU \u52a0\u901f\u3002\u8bf7\u5173\u95ed GPU \u52a0\u901f\uff0c\u6216\u5b89\u88c5\u652f\u6301 CUDA \u7684 onnxruntime-gpu \u540e\u518d\u8bd5\u3002'
  }

  if (message.includes('Visual model worker exited with code')) {
    return '\u89c6\u89c9\u6a21\u578b\u68c0\u67e5\u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u8bf7\u68c0\u67e5 ONNX \u6a21\u578b\u3001Python \u73af\u5883\u6216 GPU \u8bbe\u7f6e\u3002'
  }

  if (message.includes('did not produce output')) {
    return '\u89c6\u89c9\u6a21\u578b\u6ca1\u6709\u8fd4\u56de\u7ed3\u679c\uff0c\u8bf7\u68c0\u67e5 ONNX \u6a21\u578b\u662f\u5426\u53ef\u7528\u3002'
  }

  if (message.includes('spawn')) {
    return '\u542f\u52a8\u89c6\u89c9\u6a21\u578b\u68c0\u67e5\u8fdb\u7a0b\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 Python \u8def\u5f84\u3001\u6743\u9650\u548c\u8fd0\u884c\u73af\u5883\u914d\u7f6e\u3002'
  }

  if (message.includes('Image source is unavailable')) {
    return '\u6709\u67e5\u8be2\u56fe\u6216\u68c0\u67e5\u8303\u56f4\u4e2d\u7684\u56fe\u7247\u65e0\u6cd5\u8bfb\u53d6\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u540e\u518d\u8bd5\u3002'
  }

  if (message.includes('Unsupported or invalid image payload')) {
    return '\u5b58\u5728\u65e0\u6cd5\u89e3\u6790\u7684\u56fe\u7247\uff0c\u8bf7\u68c0\u67e5\u56fe\u7247\u683c\u5f0f\u6216\u91cd\u65b0\u9009\u62e9\u540e\u518d\u8bd5\u3002'
  }

  if (message.includes('Image dimensions are unavailable')) {
    return '\u5b58\u5728\u65e0\u6cd5\u8bfb\u53d6\u5c3a\u5bf8\u7684\u56fe\u7247\uff0c\u8bf7\u68c0\u67e5\u56fe\u7247\u5185\u5bb9\u662f\u5426\u5b8c\u6574\u3002'
  }

  if (/[\u4e00-\u9fff]/.test(message)) {
    return message
  }

  return '\u91cd\u590d\u56fe\u68c0\u67e5\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
}

const DuplicateCheckWorkspace: React.FC<{
  projectId?: string
  inline?: boolean
  onRunReady?: (run: () => Promise<void>, isRunning: boolean) => void
}> = ({ projectId, inline = false, onRunReady }) => {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { config } = useConfig()
  const { notifySuccess, notifyWarning } = useMessage()
  const { activeTabId, openTabs } = useAppSelector((state) => state.layout)
  const duplicateSettings = config.plugin_config?.duplicateCheck || DEFAULT_DUPLICATE_CHECK_SETTINGS
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>(projectId ? 'canvas' : 'folder')
  const [folderPath, setFolderPath] = React.useState('')
  const [queryImages, setQueryImages] = React.useState<DuplicateCheckClientImage[]>([])
  const [runtimeSnapshot, setRuntimeSnapshot] =
    React.useState<CanvasDuplicateCheckRuntimeSnapshot | null>(() =>
      readCanvasDuplicateCheckRuntimeSnapshot()
    )
  const [selectedMethods, setSelectedMethods] = React.useState<DuplicateCheckMethod[]>(
    duplicateSettings.defaultMethods.length > 0 ? duplicateSettings.defaultMethods : ['hash']
  )
  const [selectedPreset, setSelectedPreset] = React.useState<DuplicateCheckThresholdPreset>(
    duplicateSettings.defaultPreset
  )
  const [hashDistance, setHashDistance] = React.useState(
    DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset].hashDistance
  )
  const [uncertainHashDistance, setUncertainHashDistance] = React.useState(
    DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset].uncertainHashDistance
  )
  const [visualSimilarity, setVisualSimilarity] = React.useState(
    DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset].visualSimilarity
  )
  const [uncertainVisualSimilarity, setUncertainVisualSimilarity] = React.useState(
    DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset].uncertainVisualSimilarity
  )
  const [robustnessSimilarity, setRobustnessSimilarity] = React.useState(
    DUPLICATE_CHECK_THRESHOLD_PRESETS[duplicateSettings.defaultPreset].robustnessSimilarity
  )
  const [recursiveScan, setRecursiveScan] = React.useState(duplicateSettings.recursiveScan)
  const [imageOnlyScan, setImageOnlyScan] = React.useState(duplicateSettings.imageOnlyScan)
  const [excludeSelf, setExcludeSelf] = React.useState(duplicateSettings.excludeSelf)
  const [enableCache, setEnableCache] = React.useState(duplicateSettings.enableCache)
  const [useGpu, setUseGpu] = React.useState(duplicateSettings.gpuAcceleration)
  const [fallbackToCpu, setFallbackToCpu] = React.useState(duplicateSettings.fallbackToCpu)
  const [selectedVisualModelIds, setSelectedVisualModelIds] = React.useState<string[]>(
    duplicateSettings.visualModels.filter((model) => model.enabled).map((model) => model.id)
  )
  const [isRunning, setIsRunning] = React.useState(false)
  const [progressMessage, setProgressMessage] = React.useState('')
  const [progressValue, setProgressValue] = React.useState<number | null>(null)
  const [result, setResult] = React.useState<DuplicateCheckRunResult | null>(null)
  const [resultDialogOpen, setResultDialogOpen] = React.useState(false)
  const [errorDialogMessage, setErrorDialogMessage] = React.useState('')
  const [skippedPopoverAnchorEl, setSkippedPopoverAnchorEl] =
    React.useState<HTMLButtonElement | null>(null)
  const [scopePreviewMap, setScopePreviewMap] = React.useState<
    Record<string, DuplicateCheckClientImage>
  >({})
  const abortSenderRef = React.useRef<ReturnType<typeof newAbortHandler>[0] | null>(null)
  const activeRunIdRef = React.useRef<string | null>(null)
  const cancelledRunIdsRef = React.useRef<Set<string>>(new Set())

  const activeCanvasId = React.useMemo(() => {
    if (projectId) {
      return projectId
    }
    return activeTabId?.startsWith('tab-project-') ? activeTabId : null
  }, [activeTabId, projectId])

  const activeCanvasName = React.useMemo(() => {
    if (!activeCanvasId) {
      return ''
    }
    return (
      openTabs.find((tab) => tab.id === activeCanvasId)?.label ||
      runtimeSnapshot?.projectName ||
      activeCanvasId
    )
  }, [activeCanvasId, openTabs, runtimeSnapshot?.projectName])

  const activeVisualModels = React.useMemo(
    () =>
      duplicateSettings.visualModels
        .filter((model) => model.enabled && model.modelPath.trim())
        .map((model) => ({
          ...model,
          mean: model.mean || [0.5, 0.5, 0.5],
          std: model.std || [0.5, 0.5, 0.5]
        })),
    [duplicateSettings.visualModels]
  )

  React.useEffect(() => {
    if (activeVisualModels.length === 0) {
      setSelectedVisualModelIds([])
      return
    }

    setSelectedVisualModelIds((previous) => {
      const valid = previous.filter((id) => activeVisualModels.some((model) => model.id === id))
      return valid.length > 0 ? valid : activeVisualModels.map((model) => model.id)
    })
  }, [activeVisualModels])

  React.useEffect(() => {
    const handleRuntimeUpdate = (event: Event) => {
      setRuntimeSnapshot((event as CustomEvent<CanvasDuplicateCheckRuntimeSnapshot>).detail || null)
    }

    window.addEventListener(CANVAS_DUPLICATE_CHECK_RUNTIME_EVENT, handleRuntimeUpdate)
    return () => {
      window.removeEventListener(CANVAS_DUPLICATE_CHECK_RUNTIME_EVENT, handleRuntimeUpdate)
    }
  }, [])

  React.useEffect(() => {
    return () => {
      queryImages.forEach((image) => {
        if (image.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(image.previewUrl)
        }
      })
    }
  }, [queryImages])

  const selectedScopeImageCount =
    runtimeSnapshot && runtimeSnapshot.canvasId === activeCanvasId
      ? runtimeSnapshot.selectedImageItemIds.length
      : 0

  const applyPreset = React.useCallback((preset: DuplicateCheckThresholdPreset) => {
    const nextValues = DUPLICATE_CHECK_THRESHOLD_PRESETS[preset]
    setSelectedPreset(preset)
    setHashDistance(nextValues.hashDistance)
    setUncertainHashDistance(nextValues.uncertainHashDistance)
    setVisualSimilarity(nextValues.visualSimilarity)
    setUncertainVisualSimilarity(nextValues.uncertainVisualSimilarity)
    setRobustnessSimilarity(nextValues.robustnessSimilarity)
  }, [])

  const handleAddQueryFiles = React.useCallback(
    async (files: File[], meta?: Partial<DuplicateCheckComparableImage>) => {
      const builtImages = await Promise.all(
        files.map((file) => buildClientImageFromFile(file, meta))
      )
      setQueryImages((previous) => [...previous, ...builtImages])
    },
    []
  )

  const handleChooseQueryFiles = React.useCallback(async () => {
    const result = await api().svcDialog.showOpenDialog({
      title: '选择查询图片',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'] }
      ]
    })

    if (result.canceled || !result.filePaths.length) {
      return
    }

    const files = await Promise.all(
      result.filePaths.map(async (fullPath) => {
        const { image, filename } = await api().svcFs.readImageFromPath({ fullPath })
        return new File(
          [image as BlobPart],
          filename || fullPath.split(/[\\/]/).pop() || 'query.png',
          {
            type: inferMimeTypeFromName(filename || fullPath)
          }
        )
      })
    )

    await handleAddQueryFiles(files)
  }, [handleAddQueryFiles])

  const loadCanvasImageItems = React.useCallback(
    async (selectionOnly: boolean): Promise<DuplicateCheckClientImage[]> => {
      if (!activeCanvasId) {
        throw new Error('当前没有可用画布')
      }

      const { items } = await loadCanvasItems(activeCanvasId)
      const selectionIds =
        selectionOnly && runtimeSnapshot?.canvasId === activeCanvasId
          ? new Set(runtimeSnapshot.selectedImageItemIds)
          : null
      const targetItems = items.filter(
        (item): item is CanvasImageItem =>
          item.type === 'image' && (!selectionIds || selectionIds.has(item.id))
      )

      if (targetItems.length === 0) {
        throw new Error(selectionOnly ? '当前未选中任何图片元素' : '当前画布中没有图片')
      }

      return await Promise.all(
        targetItems.map((item) =>
          buildClientImageFromCanvasItem(item, activeCanvasId, activeCanvasName || activeCanvasId)
        )
      )
    },
    [activeCanvasId, activeCanvasName, runtimeSnapshot]
  )

  const handleImportSelectedCanvasQueries = React.useCallback(async () => {
    try {
      const images = await loadCanvasImageItems(true)
      setQueryImages((previous) => [...previous, ...images])
    } catch (error) {
      notifyWarning(error instanceof Error ? error.message : '导入当前选中图片失败')
    }
  }, [loadCanvasImageItems, notifyWarning])

  const prepareScopeImages = React.useCallback(async (): Promise<DuplicateCheckClientImage[]> => {
    if (scopeMode === 'folder') {
      return []
    }

    return loadCanvasImageItems(scopeMode === 'selection')
  }, [loadCanvasImageItems, scopeMode])

  const handleBrowseFolder = React.useCallback(async () => {
    const dialogResult = await api().svcDialog.showOpenDialog({
      title: '选择检查文件夹',
      properties: ['openDirectory']
    })

    if (!dialogResult.canceled && dialogResult.filePaths.length > 0) {
      setFolderPath(dialogResult.filePaths[0])
    }
  }, [])

  const validateBeforeRun = React.useCallback((): string | null => {
    if (queryImages.length === 0) {
      return '请先添加至少一张查询图片'
    }

    if (scopeMode === 'folder' && !folderPath.trim()) {
      return '请先选择检查文件夹'
    }

    if (
      (selectedMethods.includes('visual') || selectedMethods.includes('robust')) &&
      selectedVisualModelIds.length === 0
    ) {
      return '请至少选择一个视觉模型'
    }

    if (selectedMethods.includes('robust') && !selectedMethods.includes('visual')) {
      return '鲁棒性检查需要配合视觉模型一起使用'
    }

    return null
  }, [folderPath, queryImages.length, scopeMode, selectedMethods, selectedVisualModelIds.length])

  const handleCancel = React.useCallback(() => {
    const activeRunId = activeRunIdRef.current
    if (activeRunId) {
      cancelledRunIdsRef.current.add(activeRunId)
    }
    abortSenderRef.current?.abort()
    setIsRunning(false)
    setProgressMessage('检查已取消')
    setProgressValue(null)
  }, [])

  const handleRun = React.useCallback(async () => {
    if (isRunning) {
      return
    }

    const validationError = validateBeforeRun()
    if (validationError) {
      notifyWarning(validationError)
      return
    }

    setIsRunning(true)
    setResult(null)
    setResultDialogOpen(false)
    setErrorDialogMessage('')
    setSkippedPopoverAnchorEl(null)
    setProgressMessage('正在准备检查任务...')
    setProgressValue(null)

    let runId: string | null = null
    let abortSender: ReturnType<typeof newAbortHandler>[0] | null = null

    try {
      runId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `duplicate-check-run-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const abortContext = newAbortHandler()
      abortSender = abortContext[0]
      const abortReceiver = abortContext[1]
      activeRunIdRef.current = runId
      abortSenderRef.current = abortSender

      const scopeImages = await prepareScopeImages()
      if (!runId || activeRunIdRef.current !== runId || cancelledRunIdsRef.current.has(runId)) {
        return
      }
      setScopePreviewMap(Object.fromEntries(scopeImages.map((image) => [image.id, image])))
      const selectedModels = activeVisualModels.filter((model) =>
        selectedVisualModelIds.includes(model.id)
      )
      const taskId = `duplicate-check-${Date.now()}`

      await api().svcDuplicateCheck.runDuplicateCheck(
        {
          taskId,
          scope:
            scopeMode === 'folder'
              ? {
                  type: 'folder',
                  folderPath: folderPath.trim(),
                  recursive: recursiveScan,
                  imageExtensions: imageOnlyScan ? duplicateSettings.imageExtensions : []
                }
              : {
                  type: 'canvas',
                  canvasId: activeCanvasId || 'default',
                  canvasName: activeCanvasName || activeCanvasId || '当前画布',
                  selectionOnly: scopeMode === 'selection',
                  images: scopeImages
                },
          queries: queryImages,
          methods: selectedMethods,
          preset: selectedPreset,
          hashDistance,
          uncertainHashDistance,
          visualSimilarity,
          uncertainVisualSimilarity,
          robustnessSimilarity,
          excludeSelf,
          enableCache,
          useGpu,
          fallbackToCpu,
          batchSize: duplicateSettings.batchSize,
          maxConcurrency: duplicateSettings.maxConcurrency,
          visualModels: selectedModels as DuplicateCheckVisualModelConfig[]
        },
        {
          abortReceiver,
          onData: (event) => {
            if (
              !runId ||
              activeRunIdRef.current !== runId ||
              cancelledRunIdsRef.current.has(runId)
            ) {
              return
            }
            if (event.type === 'status') {
              setProgressMessage(event.message)
              setProgressValue(
                typeof event.percent === 'number' && Number.isFinite(event.percent)
                  ? Math.max(0, Math.min(event.percent, 1))
                  : null
              )
              return
            }

            setResult(event.result)
            setResultDialogOpen(true)
            setProgressMessage('检查完成')
            setProgressValue(1)
          }
        }
      )
    } catch (error) {
      if (runId && activeRunIdRef.current === runId && !cancelledRunIdsRef.current.has(runId)) {
        setErrorDialogMessage(normalizeDuplicateCheckErrorMessage(error))
      }
    } finally {
      if (abortSenderRef.current === abortSender) {
        abortSenderRef.current = null
      }
      if (runId) {
        cancelledRunIdsRef.current.delete(runId)
      }
      if (runId && activeRunIdRef.current === runId) {
        activeRunIdRef.current = null
        setIsRunning(false)
      }
    }
  }, [
    activeCanvasId,
    activeCanvasName,
    activeVisualModels,
    duplicateSettings.batchSize,
    duplicateSettings.imageExtensions,
    duplicateSettings.maxConcurrency,
    enableCache,
    excludeSelf,
    fallbackToCpu,
    folderPath,
    hashDistance,
    imageOnlyScan,
    notifyWarning,
    prepareScopeImages,
    queryImages,
    recursiveScan,
    robustnessSimilarity,
    scopeMode,
    selectedMethods,
    selectedPreset,
    selectedVisualModelIds,
    isRunning,
    uncertainHashDistance,
    uncertainVisualSimilarity,
    useGpu,
    validateBeforeRun,
    visualSimilarity
  ])

  React.useEffect(() => {
    if (!onRunReady) {
      return
    }
    onRunReady(handleRun, isRunning)
  }, [handleRun, isRunning, onRunReady])

  const handleRemoveQueryImage = React.useCallback((imageId: string) => {
    setQueryImages((previous) => {
      const target = previous.find((image) => image.id === imageId)
      if (target?.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl)
      }
      return previous.filter((image) => image.id !== imageId)
    })
  }, [])

  const handleClearQueryImages = React.useCallback(() => {
    setQueryImages((previous) => {
      previous.forEach((image) => {
        if (image.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(image.previewUrl)
        }
      })
      return []
    })
  }, [])

  const handleLocateCanvasItem = React.useCallback(
    (target: DuplicateCheckComparableImage) => {
      if (!target.canvasId || !target.itemId) {
        return
      }

      if (!openTabs.some((tab) => tab.id === target.canvasId)) {
        dispatch(
          openTab({
            id: target.canvasId,
            label: target.canvasName || target.canvasId,
            routePath: toProjectCanvasRoutePath(target.canvasId),
            closable: true
          })
        )
      }

      dispatch(setActiveTab(target.canvasId))
      navigate(toProjectCanvasRoutePath(target.canvasId))
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, {
            detail: {
              canvasId: target.canvasId,
              itemIds: [target.itemId]
            }
          })
        )
      }, 50)
    },
    [dispatch, navigate, openTabs]
  )

  const handleRevealFile = React.useCallback(async (target: DuplicateCheckComparableImage) => {
    const sourcePath = target.sourcePath?.trim()
    if (!sourcePath) {
      return
    }
    await api().svcShell.showItemInFolder(sourcePath)
  }, [])

  const handleExportReport = React.useCallback(
    async (format: 'json' | 'csv') => {
      if (!result || !window.path) {
        return
      }

      const saveResult = await api().svcDialog.showSaveDialog({
        title: `导出${format.toUpperCase()}报告`,
        defaultPath: `duplicate-check-report.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }]
      })

      if (saveResult.canceled || !saveResult.filePath) {
        return
      }

      const rows = flattenMatchesForExport(result)
      const content =
        format === 'json'
          ? JSON.stringify({ result, rows }, null, 2)
          : [
              [
                'queryName',
                'matchLevel',
                'targetName',
                'targetCanvas',
                'targetPath',
                'reasons',
                'pHashDistance',
                'dHashDistance',
                'visual',
                'robust'
              ].join(','),
              ...rows.map((row) =>
                [
                  row.queryName,
                  row.matchLevel,
                  row.targetName,
                  row.targetCanvas,
                  row.targetPath,
                  row.reasons,
                  row.pHashDistance,
                  row.dHashDistance,
                  row.visual.toFixed(4),
                  row.robust.toFixed(4)
                ]
                  .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
                  .join(',')
              )
            ].join('\n')

      await api().svcFs.writeTextFile({
        outputPath: window.path.dirname(saveResult.filePath),
        filename: window.path.basename(saveResult.filePath),
        content
      })
      notifySuccess(`已导出${format.toUpperCase()}报告`)
    },
    [notifySuccess, result]
  )

  const handleCloseResultDialog = React.useCallback(() => {
    setResultDialogOpen(false)
    setSkippedPopoverAnchorEl(null)
  }, [])

  const handleOpenResultDialog = React.useCallback(() => {
    if (result) {
      setResultDialogOpen(true)
    }
  }, [result])

  const handleCloseErrorDialog = React.useCallback(() => {
    setErrorDialogMessage('')
  }, [])

  const handleOpenSkippedPopover = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setSkippedPopoverAnchorEl(event.currentTarget)
    },
    []
  )

  const handleCloseSkippedPopover = React.useCallback(() => {
    setSkippedPopoverAnchorEl(null)
  }, [])

  const getComparablePreviewSrc = React.useCallback(
    (image: DuplicateCheckComparableImage): string =>
      scopePreviewMap[image.id]?.previewUrl ||
      image.sourceUrl ||
      (image.sourcePath ? buildLocalMediaUrl(image.sourcePath) : ''),
    [scopePreviewMap]
  )

  const getComparableLocationText = React.useCallback((image: DuplicateCheckComparableImage) => {
    if (image.canvasName) {
      return `画布：${image.canvasName}`
    }
    if (image.originLabel) {
      return image.originLabel
    }
    if (image.sourcePath) {
      return image.sourcePath
    }
    return '来源未知'
  }, [])

  const headerSx = inline
    ? {
        px: 1.5,
        pt: 1.5
      }
    : {
        px: 2.5,
        pt: 2.5
      }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, ...headerSx }}>
      <Paper variant="outlined" sx={{ borderRadius: 3 }}>
        <Box sx={{ p: 2.25 }}>
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} alignItems="center">
              <FactCheckOutlinedIcon color="primary" />
              <Typography variant="h6" sx={{ fontWeight: 800 }}>
                重复图检查
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              依次选择检查范围、查询图片、阈值和检查方式，然后计算重复图数量与相似明细。
            </Typography>
          </Stack>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ borderRadius: 3 }}>
        <Box sx={{ p: 2.25 }}>
          <Stack spacing={2}>
            <Typography sx={{ fontWeight: 800 }}>1. 选择检查范围</Typography>
            <ToggleButtonGroup
              exclusive
              color="primary"
              value={scopeMode}
              onChange={(_, value: ScopeMode | null) => {
                if (value) {
                  setScopeMode(value)
                }
              }}
              size="small"
            >
              <ToggleButton value="folder">文件夹</ToggleButton>
              <ToggleButton value="canvas" disabled={!activeCanvasId}>
                整个画布
              </ToggleButton>
              <ToggleButton
                value="selection"
                disabled={!activeCanvasId || selectedScopeImageCount === 0}
              >
                当前选中
              </ToggleButton>
            </ToggleButtonGroup>

            {scopeMode === 'folder' ? (
              <Stack spacing={1.5}>
                <TextField
                  label="检查文件夹"
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  fullWidth
                  size="small"
                />
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Button
                    variant="outlined"
                    startIcon={<FolderOpenOutlinedIcon />}
                    onClick={() => {
                      void handleBrowseFolder()
                    }}
                  >
                    选择文件夹
                  </Button>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={recursiveScan}
                        onChange={(event) => setRecursiveScan(event.target.checked)}
                      />
                    }
                    label="递归扫描子目录"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={imageOnlyScan}
                        onChange={(event) => setImageOnlyScan(event.target.checked)}
                      />
                    }
                    label="只扫描图片格式"
                  />
                </Stack>
              </Stack>
            ) : (
              <Alert severity="info">
                {scopeMode === 'canvas'
                  ? `将检查当前画布“${activeCanvasName || '未命名画布'}”中的全部图片。`
                  : `将检查当前画布已选中的 ${selectedScopeImageCount} 张图片。`}
              </Alert>
            )}
          </Stack>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ borderRadius: 3 }}>
        <Box sx={{ p: 2.25 }}>
          <Stack spacing={2}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              flexWrap="wrap"
            >
              <Typography sx={{ fontWeight: 800 }}>2. 选择查询图片</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<ImageOutlinedIcon />}
                  onClick={() => {
                    void handleChooseQueryFiles()
                  }}
                >
                  从文件选择
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<MyLocationOutlinedIcon />}
                  disabled={!activeCanvasId || selectedScopeImageCount === 0}
                  onClick={() => {
                    void handleImportSelectedCanvasQueries()
                  }}
                >
                  导入当前选中
                </Button>
                <Button size="small" color="inherit" onClick={handleClearQueryImages}>
                  清空
                </Button>
              </Stack>
            </Stack>

            <QueryDropZone
              disabled={isRunning}
              onFiles={async (files, meta) => {
                await handleAddQueryFiles(files, meta)
              }}
            />

            {queryImages.length > 0 && (
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {queryImages.map((image) => (
                  <Card key={image.id} variant="outlined" sx={{ width: 120 }}>
                    <Box
                      sx={{
                        height: 78,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        bgcolor: 'action.hover'
                      }}
                    >
                      <img
                        src={image.previewUrl}
                        alt={image.name}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </Box>
                    <CardContent sx={{ p: 1 }}>
                      <Typography
                        variant="caption"
                        sx={{ display: 'block' }}
                        noWrap
                        title={image.name}
                      >
                        {image.name}
                      </Typography>
                      <Button
                        size="small"
                        color="inherit"
                        sx={{ mt: 0.5, minWidth: 0, px: 0 }}
                        onClick={() => handleRemoveQueryImage(image.id)}
                      >
                        移除
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            )}
          </Stack>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ borderRadius: 3 }}>
        <Box sx={{ p: 2.25 }}>
          <Stack spacing={2}>
            <Typography sx={{ fontWeight: 800 }}>3. 设置阈值</Typography>
            <TextField
              select
              label="阈值预设"
              value={selectedPreset}
              onChange={(event) => applyPreset(event.target.value as DuplicateCheckThresholdPreset)}
              size="small"
              sx={{ maxWidth: 220 }}
            >
              {Object.entries(presetLabel).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>

            <Box>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                哈希距离阈值：{hashDistance}
              </Typography>
              <Slider
                value={hashDistance}
                onChange={(_, value) => setHashDistance(value as number)}
                min={0}
                max={32}
                step={1}
              />
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                哈希疑似区间：{uncertainHashDistance}
              </Typography>
              <Slider
                value={uncertainHashDistance}
                onChange={(_, value) => setUncertainHashDistance(value as number)}
                min={hashDistance}
                max={40}
                step={1}
              />
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                视觉相似度阈值：{visualSimilarity.toFixed(2)}
              </Typography>
              <Slider
                value={visualSimilarity}
                onChange={(_, value) => setVisualSimilarity(value as number)}
                min={0.5}
                max={0.99}
                step={0.01}
              />
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                视觉疑似阈值：{uncertainVisualSimilarity.toFixed(2)}
              </Typography>
              <Slider
                value={uncertainVisualSimilarity}
                onChange={(_, value) => setUncertainVisualSimilarity(value as number)}
                min={0.4}
                max={visualSimilarity}
                step={0.01}
              />
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                鲁棒性阈值：{robustnessSimilarity.toFixed(2)}
              </Typography>
              <Slider
                value={robustnessSimilarity}
                onChange={(_, value) => setRobustnessSimilarity(value as number)}
                min={0.5}
                max={0.99}
                step={0.01}
              />
            </Box>
          </Stack>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ borderRadius: 3 }}>
        <Box sx={{ p: 2.25 }}>
          <Stack spacing={2}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              flexWrap="wrap"
            >
              <Typography sx={{ fontWeight: 800 }}>4. 选择检查方式</Typography>
              <Button
                size="small"
                startIcon={<SettingsOutlinedIcon />}
                onClick={() => openQuickAppSettingsTab(dispatch, navigate, openTabs)}
              >
                打开检查设置
              </Button>
            </Stack>

            <ToggleButtonGroup
              color="primary"
              value={selectedMethods}
              onChange={(_, value: DuplicateCheckMethod[]) => {
                setSelectedMethods(value)
              }}
              size="small"
            >
              {(['hash', 'visual', 'robust'] as DuplicateCheckMethod[]).map((method) => (
                <ToggleButton key={method} value={method}>
                  {duplicateCheckMethodLabel[method]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            {activeVisualModels.length > 0 ? (
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {activeVisualModels.map((model) => {
                  const selected = selectedVisualModelIds.includes(model.id)
                  return (
                    <Chip
                      key={model.id}
                      color={selected ? 'primary' : 'default'}
                      variant={selected ? 'filled' : 'outlined'}
                      label={model.name}
                      onClick={() => {
                        setSelectedVisualModelIds((previous) =>
                          previous.includes(model.id)
                            ? previous.filter((id) => id !== model.id)
                            : [...previous, model.id]
                        )
                      }}
                    />
                  )
                })}
              </Stack>
            ) : (
              <Alert severity="warning">
                还没有配置视觉模型。去“设置 - 快应用 API - 重复图检查”里添加 ONNX
                模型后，才能启用视觉检查。
              </Alert>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap">
              <FormControlLabel
                control={
                  <Checkbox
                    checked={excludeSelf}
                    onChange={(event) => setExcludeSelf(event.target.checked)}
                  />
                }
                label="排除自身"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={enableCache}
                    onChange={(event) => setEnableCache(event.target.checked)}
                  />
                }
                label="启用缓存"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={useGpu}
                    onChange={(event) => setUseGpu(event.target.checked)}
                  />
                }
                label="GPU 加速"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={fallbackToCpu}
                    onChange={(event) => setFallbackToCpu(event.target.checked)}
                  />
                }
                label="GPU 失败自动回退 CPU"
              />
            </Stack>

            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button variant="contained" onClick={() => void handleRun()} disabled={isRunning}>
                开始检查
              </Button>
              <Button color="inherit" onClick={handleCancel} disabled={!isRunning}>
                取消
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Paper>

      {(isRunning || progressMessage) && (
        <Paper variant="outlined" sx={{ borderRadius: 3 }}>
          <Box sx={{ p: 2.25 }}>
            <Stack spacing={1}>
              <Typography sx={{ fontWeight: 800 }}>运行进度</Typography>
              <Typography variant="body2" color="text.secondary">
                {progressMessage || '等待开始'}
              </Typography>
              <LinearProgress
                variant={progressValue === null ? 'indeterminate' : 'determinate'}
                value={(progressValue || 0) * 100}
                sx={{ borderRadius: 999, height: 8 }}
              />
            </Stack>
          </Box>
        </Paper>
      )}

      <Dialog
        open={Boolean(errorDialogMessage)}
        onClose={handleCloseErrorDialog}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{'重复图检查失败'}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary">
            {errorDialogMessage || '重复图检查失败，请稍后重试。'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={handleCloseErrorDialog}>我知道了</Button>
        </DialogActions>
      </Dialog>

      {result && !resultDialogOpen && (
        <Alert
          severity={result.totalMatchCount > 0 ? 'success' : 'info'}
          action={
            <Button color="inherit" size="small" onClick={handleOpenResultDialog}>
              查看结果
            </Button>
          }
        >
          {result.totalMatchCount > 0
            ? `重复图检查已完成，共找到 ${result.totalMatchCount} 条重复结果。`
            : '重复图检查已完成，当前没有找到重复结果。'}
        </Alert>
      )}

      {result && (
        <Dialog open={resultDialogOpen} onClose={handleCloseResultDialog} fullWidth maxWidth="lg">
          <DialogTitle>{'检查结果'}</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                flexWrap="wrap"
              >
                <Typography sx={{ fontWeight: 800 }}>检查结果</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Button
                    size="small"
                    startIcon={<RefreshOutlinedIcon />}
                    onClick={() => void handleRun()}
                  >
                    重新检查
                  </Button>
                  <Button
                    size="small"
                    startIcon={<FileDownloadOutlinedIcon />}
                    onClick={() => void handleExportReport('json')}
                  >
                    导出 JSON
                  </Button>
                  <Button
                    size="small"
                    startIcon={<FileDownloadOutlinedIcon />}
                    onClick={() => void handleExportReport('csv')}
                  >
                    导出 CSV
                  </Button>
                </Stack>
              </Stack>

              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Chip label={`查询图 ${result.queryCount}`} />
                <Chip color="success" label={`精确重复 ${result.exactCount}`} />
                <Chip color="primary" label={`高概率重复 ${result.highCount}`} />
                <Chip color="warning" label={`疑似重复 ${result.uncertainCount}`} />
                <Chip label={`缓存命中 ${result.cacheHitCount}`} />
              </Stack>

              {result.skippedScopeImages.length > 0 && (
                <>
                  <Alert
                    severity="warning"
                    action={
                      <Button color="inherit" size="small" onClick={handleOpenSkippedPopover}>
                        查看
                      </Button>
                    }
                  >
                    {`本次检查跳过了 ${result.skippedScopeImages.length} 张无法处理的范围图片。`}
                  </Alert>

                  <Popover
                    open={Boolean(skippedPopoverAnchorEl)}
                    anchorEl={skippedPopoverAnchorEl}
                    onClose={handleCloseSkippedPopover}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                    transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  >
                    <Box sx={{ width: 420, maxWidth: 'calc(100vw - 64px)', p: 2 }}>
                      <Stack spacing={1.5}>
                        <Typography sx={{ fontWeight: 800 }}>无法检查的图片</Typography>
                        <Typography variant="body2" color="text.secondary">
                          可以在这里查看具体图片、失败原因，以及定位到画布或打开文件位置。
                        </Typography>
                        <Divider />
                        <Stack spacing={1.25} sx={{ maxHeight: 360, overflowY: 'auto' }}>
                          {result.skippedScopeImages.map((skipped) => {
                            const preview = getComparablePreviewSrc(skipped.image)
                            return (
                              <Card
                                key={`skipped-${skipped.image.id}`}
                                variant="outlined"
                                sx={{ borderRadius: 2 }}
                              >
                                <CardContent sx={{ p: 1.5 }}>
                                  <Stack direction="row" spacing={1.25}>
                                    <Box
                                      sx={{
                                        width: 56,
                                        height: 56,
                                        borderRadius: 1.5,
                                        overflow: 'hidden',
                                        bgcolor: 'action.hover',
                                        flexShrink: 0
                                      }}
                                    >
                                      {preview ? (
                                        <img
                                          src={preview}
                                          alt={skipped.image.name}
                                          style={{
                                            width: '100%',
                                            height: '100%',
                                            objectFit: 'cover'
                                          }}
                                        />
                                      ) : null}
                                    </Box>
                                    <Box sx={{ minWidth: 0, flex: 1 }}>
                                      <Typography
                                        sx={{ fontWeight: 700 }}
                                        noWrap
                                        title={skipped.image.name}
                                      >
                                        {skipped.image.name}
                                      </Typography>
                                      <Typography
                                        variant="caption"
                                        color="text.secondary"
                                        sx={{ display: 'block', mt: 0.25 }}
                                      >
                                        {getComparableLocationText(skipped.image)}
                                      </Typography>
                                      <Typography
                                        variant="body2"
                                        color="warning.main"
                                        sx={{ mt: 0.75 }}
                                      >
                                        {skipped.reason}
                                      </Typography>
                                      <Stack
                                        direction="row"
                                        spacing={1}
                                        flexWrap="wrap"
                                        sx={{ mt: 1 }}
                                      >
                                        {skipped.image.canvasId && skipped.image.itemId && (
                                          <Button
                                            size="small"
                                            startIcon={<MyLocationOutlinedIcon />}
                                            onClick={() => {
                                              handleLocateCanvasItem(skipped.image)
                                              handleCloseSkippedPopover()
                                            }}
                                          >
                                            定位到画布
                                          </Button>
                                        )}
                                        {skipped.image.sourcePath && (
                                          <Button
                                            size="small"
                                            color="inherit"
                                            onClick={() => {
                                              void handleRevealFile(skipped.image)
                                              handleCloseSkippedPopover()
                                            }}
                                          >
                                            打开所在目录
                                          </Button>
                                        )}
                                      </Stack>
                                    </Box>
                                  </Stack>
                                </CardContent>
                              </Card>
                            )
                          })}
                        </Stack>
                      </Stack>
                    </Box>
                  </Popover>
                </>
              )}

              <Divider />

              {result.queryResults.map((queryResult) => (
                <Box key={queryResult.query.id}>
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
                    <Box
                      sx={{
                        width: 88,
                        height: 88,
                        borderRadius: 2,
                        overflow: 'hidden',
                        bgcolor: 'action.hover',
                        flexShrink: 0
                      }}
                    >
                      <img
                        src={
                          queryImages.find((item) => item.id === queryResult.query.id)
                            ?.previewUrl ||
                          queryResult.query.sourceUrl ||
                          (queryResult.query.sourcePath
                            ? buildLocalMediaUrl(queryResult.query.sourcePath)
                            : '')
                        }
                        alt={queryResult.query.name}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 800 }} noWrap title={queryResult.query.name}>
                        {queryResult.query.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        精确 {queryResult.exactMatches.length} / 高概率{' '}
                        {queryResult.highMatches.length} / 疑似{' '}
                        {queryResult.uncertainMatches.length}
                      </Typography>
                    </Box>
                  </Stack>

                  {(['exactMatches', 'highMatches', 'uncertainMatches'] as const).map((key) => {
                    const title =
                      key === 'exactMatches'
                        ? '精确重复'
                        : key === 'highMatches'
                          ? '高概率重复'
                          : '疑似重复'
                    const color =
                      key === 'exactMatches'
                        ? 'success.main'
                        : key === 'highMatches'
                          ? 'primary.main'
                          : 'warning.main'
                    const matches = queryResult[key]

                    if (matches.length === 0) {
                      return null
                    }

                    return (
                      <Box key={key} sx={{ mb: 1.75 }}>
                        <Typography sx={{ fontWeight: 700, color, mb: 1 }}>{title}</Typography>
                        <Stack spacing={1}>
                          {matches.map((match) => {
                            const preview =
                              scopePreviewMap[match.target.id]?.previewUrl ||
                              match.target.sourceUrl ||
                              (match.target.sourcePath
                                ? buildLocalMediaUrl(match.target.sourcePath)
                                : '')
                            return (
                              <Card
                                key={`${queryResult.query.id}-${match.level}-${match.target.id}`}
                                variant="outlined"
                              >
                                <CardContent sx={{ p: 1.5 }}>
                                  <Stack direction="row" spacing={1.5}>
                                    <Box
                                      sx={{
                                        width: 80,
                                        height: 80,
                                        borderRadius: 2,
                                        overflow: 'hidden',
                                        bgcolor: 'action.hover',
                                        flexShrink: 0
                                      }}
                                    >
                                      {preview ? (
                                        <img
                                          src={preview}
                                          alt={match.target.name}
                                          style={{
                                            width: '100%',
                                            height: '100%',
                                            objectFit: 'cover'
                                          }}
                                        />
                                      ) : null}
                                    </Box>
                                    <Box sx={{ minWidth: 0, flex: 1 }}>
                                      <Typography
                                        sx={{ fontWeight: 700 }}
                                        noWrap
                                        title={match.target.name}
                                      >
                                        {match.target.name}
                                      </Typography>
                                      <Typography variant="body2" color="text.secondary">
                                        命中方式：{match.reasons.join(' / ')}
                                      </Typography>
                                      <Typography
                                        variant="caption"
                                        color="text.secondary"
                                        sx={{ display: 'block', mt: 0.5 }}
                                      >
                                        pHash 距离 {match.scores.pHashDistance ?? '-'}，dHash 距离{' '}
                                        {match.scores.dHashDistance ?? '-'}
                                      </Typography>
                                      {Object.keys(match.scores.visualSimilarityByModel).length >
                                        0 && (
                                        <Typography
                                          variant="caption"
                                          color="text.secondary"
                                          sx={{ display: 'block' }}
                                        >
                                          视觉相似度：
                                          {Object.entries(match.scores.visualSimilarityByModel)
                                            .map(
                                              ([modelId, value]) =>
                                                `${activeVisualModels.find((model) => model.id === modelId)?.name || modelId} ${value.toFixed(3)}`
                                            )
                                            .join('，')}
                                        </Typography>
                                      )}
                                      {Object.keys(match.scores.robustnessSimilarityByModel)
                                        .length > 0 && (
                                        <Typography
                                          variant="caption"
                                          color="text.secondary"
                                          sx={{ display: 'block' }}
                                        >
                                          鲁棒性：
                                          {Object.entries(match.scores.robustnessSimilarityByModel)
                                            .map(
                                              ([modelId, value]) =>
                                                `${activeVisualModels.find((model) => model.id === modelId)?.name || modelId} ${value.toFixed(3)}`
                                            )
                                            .join('，')}
                                        </Typography>
                                      )}
                                      <Stack
                                        direction="row"
                                        spacing={1}
                                        flexWrap="wrap"
                                        sx={{ mt: 1 }}
                                      >
                                        {match.target.canvasId && match.target.itemId && (
                                          <Button
                                            size="small"
                                            startIcon={<MyLocationOutlinedIcon />}
                                            onClick={() => handleLocateCanvasItem(match.target)}
                                          >
                                            定位到画布
                                          </Button>
                                        )}
                                        {match.target.sourcePath && (
                                          <Button
                                            size="small"
                                            color="inherit"
                                            onClick={() => void handleRevealFile(match.target)}
                                          >
                                            打开所在目录
                                          </Button>
                                        )}
                                      </Stack>
                                    </Box>
                                  </Stack>
                                </CardContent>
                              </Card>
                            )
                          })}
                        </Stack>
                      </Box>
                    )
                  })}
                </Box>
              ))}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 2 }}>
            <Button onClick={handleCloseResultDialog}>关闭</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  )
}

export default DuplicateCheckWorkspace
