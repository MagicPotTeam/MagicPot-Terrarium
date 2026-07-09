/* eslint-disable @typescript-eslint/no-explicit-any, react-refresh/only-export-components */
/* @refresh reset */
// packages/app/src/renderer/src/pages/ProjectCanvasPage/ProjectCanvasPage.tsx

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  Divider,
  Chip,
  Button,
  TextField,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Slider
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import {
  BackHand as HandIcon,
  NearMe as SelectIcon,
  AddPhotoAlternate as ImageAddIcon,
  PlayArrow as PlayArrowIcon,
  PauseCircleFilled as PauseIcon,
  Search as ZoomInIcon,
  CenterFocusStrong as FitIcon,
  DeleteSweep as ClearIcon,
  ViewInAr as Model3DIcon,
  MovieCreation as VideoAddIcon,
  ContentCut as ScreenshotIcon,
  FileDownload as ExportIcon,
  Send as DccExportIcon,
  FileUpload as ImportIcon,
  RadioButtonUnchecked as EllipseIcon,
  CropSquare as RectIcon,
  CallMade as ArrowIcon,
  HorizontalRule as LineIcon,
  Brush as BrushIcon,
  Title as TextAnnoIcon,
  Translate as TranslateIcon,
  TextSnippet as OcrIcon,
  SaveAlt as DownloadIcon,
  PushPin as PinIcon,
  ContentCopy,
  Download,
  AutoAwesome as AutoAwesomeIcon,
  AppsOutlined as AppsOutlinedIcon,
  LayersOutlined as LayersOutlinedIcon,
  ChevronRight as ChevronRightIcon,
  FormatBold as FormatBoldIcon
} from '@mui/icons-material'
import { scheduleCanvasSync } from './components/canvasSync'
import { type ProjectCanvasImageCropOverlayHandle } from './components/ProjectCanvasImageCropOverlay'
import type { InlineTextEditState } from './ProjectCanvasPageInlineTextEditor'
import ProjectCanvasPageShell from './ProjectCanvasPageShell'
import {
  STORAGE_KEY_SELECTED_PROFILE,
  getDownloadFileNameFromUrl,
  getBaseProfileId,
  normalizeLocalMediaUrl,
  scopedStorageKey
} from '../ChatPage/chatPageShared'
import type {
  CanvasGroup,
  CanvasItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasModel3DItem,
  CanvasVideoItem,
  CanvasHtmlItem,
  CanvasTextItem,
  CanvasAnnotationItem,
  AnnotationShape
} from './types'
import { detectFileType, MODEL_IMPORT_EXTENSIONS, VIDEO_EXTENSIONS } from './types'
import { importCanvasFile, isCanvasFile } from './canvasStorage'
import { detectImageHasAlpha, estimateDataUrlByteSize } from './canvasImageMetadata'
import {
  buildCanvasAgentAttachments,
  buildCanvasAgentAttachmentManifest,
  expandCanvasItemsForAgentSend
} from './canvasAgentAttachmentUtils'
import { getInlineTextEditorViewportSize } from './canvasTextLayout'
import {
  DatabaseIconSVG,
  DocumentIconSVG,
  DoubleLineRectIconSVG,
  FILE_NODE_DEFAULT_HEIGHT,
  FILE_NODE_DEFAULT_WIDTH,
  FILLED_ANNOTATION_OPACITY,
  INLINE_MEDIA_CAPTION_BOTTOM_CLEARANCE,
  INLINE_TEXT_EDIT_SCREEN_MARGIN,
  MULTI_SELECTION_ACTION_COUNT,
  ParallelogramIconSVG,
  RoundedRectIconSVG,
  RhombusIconSVG,
  SELECTION_ACTION_STACK_MARGIN,
  VIDEO_FRAME_CAPTURE_EPSILON_SECONDS,
  applySelectedTextSizeChange,
  getCanvasItemBounds,
  getCanvasItemsBounds,
  isFillableAnnotationShape as sharedIsFillableAnnotationShape,
  normalizeOfficeFileNodeDataForCanvas,
  resolveDroppedAgentImageDataUrl,
  translateCanvasItem,
  type AvailableQAppOption,
  type CanvasDragPayload,
  type CanvasTool
} from './projectCanvasPageShared'
import { type ProjectStyleModelOption } from './projectStyleModelRegistry'
import {
  type AttachedCaptionAnnotation,
  pruneOrphanAttachedCaptions,
  removeCanvasItemsWithAttachedCaptions
} from './canvasAttachedCaptionUtils'
import {
  createExternalCanvasProvenance,
  createImportedFileProvenance,
  createMagicPotNativeProvenance,
  deriveCanvasGroupProvenance,
  summarizeCanvasItemProvenanceForBridge
} from './canvasProvenanceUtils'
import { CANVAS_IMPORT_ACCEPT } from './canvasImportAccept'
import {
  clampStageScale,
  resolveActiveAgentProfileId,
  resolveActiveCanvasAgentSessionKey,
  resolveActiveAgentScope,
  shouldKeepOriginalCanvasImage
} from './canvasPageLocalStateUtils'
import { PROJECT_CANVAS_MAX_STAGE_SCALE } from './projectCanvasViewportScale'
import {
  GROUP_CHIP_SEND_ACTION_ENABLED,
  isLegacySelectionToolbarEnabled
} from './canvasFeatureFlags'
import { extractPromptTextFromCanvasItems } from './canvasPromptTextUtils'
import { type CanvasExportBounds } from './groupPlaybackUtils'
import { canPlayGroupSummary } from './groupMenuUtils'
import { getCanvasCursorStyle, shouldForceCanvasCrosshair } from './canvasCursorUtils'
import { getExactSelectedGroupBounds, resolveCanvasFitBounds } from './canvasFitBoundsUtils'
import { getSelectionActionStackPosition } from './canvasSelectionLayoutUtils'
import { isChineseUiLanguage } from './projectCanvasPageUiCopy'
import { useCanvasFilePreview } from './useCanvasFilePreview'
import { useCanvasGenerationWorkflow } from './useCanvasGenerationWorkflow'
import { useCanvasGenerationTrace } from './useCanvasGenerationTrace'
import { useCanvasTargetWorkflow, type SelectionRect } from './useCanvasTargetWorkflow'
import { useCanvasFigmaBinding } from './useCanvasFigmaBinding'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'
import { useCanvasGroupManagement } from './useCanvasGroupManagement'
import { useCanvasGroupPlayback } from './useCanvasGroupPlayback'
import { useCanvasSelectionInfo } from './useCanvasSelectionInfo'
import { useCanvasSelectionActions } from './useCanvasSelectionActions'
import { useCanvasSelectionUiActions } from './useCanvasSelectionUiActions'
import { useCanvasStageInteraction } from './useCanvasStageInteraction'
import { useCanvasSelectionRectDomDriver } from './useCanvasSelectionRectDomDriver'
import { useStageViewportTransformDriver } from './useStageViewportTransformDriver'
import { useCanvasFileIntake } from './useCanvasFileIntake'
import { useCanvasCustomAddEvents } from './useCanvasCustomAddEvents'
import { useCanvasKeyboardShortcuts } from './useCanvasKeyboardShortcuts'
import { useCanvasBridgeActions } from './useCanvasBridgeActions'
import { useCanvasViewportPersistence } from './useCanvasViewportPersistence'
import { useCanvasLayerRuntime } from './useCanvasLayerRuntime'
import { useCanvasInlineTextEffects } from './useCanvasInlineTextEffects'
import { useCanvasMediaRuntime } from './useCanvasMediaRuntime'
import { useCanvasStageResize } from './useCanvasStageResize'
import { buildProjectCanvasPageShellProps } from './buildProjectCanvasPageShellProps'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'
import { useProjectCanvasPageShellState } from './useProjectCanvasPageShellState'
import { useCanvasViewportPlacement } from './useCanvasViewportPlacement'
import { useCanvasVisualMetrics } from './useCanvasVisualMetrics'
import { useCanvasViewerPlayback } from './useCanvasViewerPlayback'
import { installProjectCanvasBenchmarkViewportSetter } from './projectCanvasBenchmarkRuntime'
import { resolveProjectCanvasBenchmarkViewport } from './projectCanvasBenchmarkViewport'
import { useCanvasAssetIntake } from './useCanvasAssetIntake'
import { useCanvasImageBatchImportProgress } from './useCanvasImageBatchImportProgress'
import {
  getCanvasExportableItems,
  getSelectedCanvasExportableItems
} from './canvasExportableSelectionUtils'
import { useComfyExecutionActivity } from './useComfyExecutionActivity'
import { useCanvasScreenshotShortcutSync } from './useCanvasScreenshotShortcutSync'
import { useProjectTraceCanvasEvents } from './useProjectTraceCanvasEvents'
import { useProjectTraceRealtimeAdvice } from './useProjectTraceRealtimeAdvice'
import { useCanvasDuplicateCheckRuntimeBridge } from './useCanvasDuplicateCheckRuntimeBridge'
import { useCanvasLastViewportPoint } from './useCanvasLastViewportPoint'
import { useCanvasImageExtract } from './useCanvasImageExtract'
import { useMessage } from '../../hooks/useMessage'
import { useConfig } from '../../hooks/useConfig'
import { api } from '../../utils/windowUtils'
import { useDispatch, useSelector } from 'react-redux'
import { openRightPanel, openSidePanel } from '../../store/slices/layoutSlice'
import { useTranslation } from 'react-i18next'
import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type { CanvasFigmaBinding } from '@shared/figma'
import { extractVideoBoundaryFrameDataUrls } from '../ChatPage/chatVideoAttachmentUtils'
import { buildBboxToCellIdsMap, buildOcrResultHtml, isNormalizedOcrBox } from './ocrCanvasUtils'
import { createCanvasStageHandle } from './canvasStageHandle'

export {
  applySelectedTextSizeChange,
  resolveDroppedAgentImageDataUrl
} from './projectCanvasPageShared'

function isFillableAnnotationShape(
  shape: AnnotationShape | null | undefined
): shape is AnnotationShape {
  return sharedIsFillableAnnotationShape(shape)
}

const FILE_PROTOCOL_PATTERN = /^(?:file|local-media):\/\/(.+)$/i
const CANVAS_IMAGE_PROXY_MAX_SIDE = 1024
const MAX_FIT_STAGE_SCALE = PROJECT_CANVAS_MAX_STAGE_SCALE

function isCanvasInteractionDebugEnabled() {
  return (
    (window as Window & { __projectCanvasDebugInteraction?: boolean })
      .__projectCanvasDebugInteraction === true
  )
}

const ProjectCanvasPageContent: React.FC<{ canvasId: string }> = ({ canvasId }) => {
  const theme = useTheme()
  const { t, i18n } = useTranslation()
  const { config } = useConfig()
  const isChineseUi = isChineseUiLanguage(i18n.resolvedLanguage || i18n.language)
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const canvasAgentSessionKey = useMemo(
    () => resolveActiveCanvasAgentSessionKey(canvasId),
    [canvasId]
  )
  const { imageBatchImportProgress, isImageBatchImportActive, handleImageBatchImportProgress } =
    useCanvasImageBatchImportProgress()

  const projectName = useSelector((state: any) => {
    const tab = state.layout.openTabs.find((t: any) => t.id === canvasId)
    return tab?.label || 'Project'
  })
  const { isCanvasPerformanceThrottled } = useComfyExecutionActivity({
    useRemoteComfyui: config.use_remote_comfyui
  })

  const {
    activeOcrHover,
    annoTool,
    drawingState,
    groups,
    groupBranches,
    handleRedo,
    handleUndo,
    inlineTextEdit,
    isPanning,
    items,
    lastClickedIdRef,
    lastPanPosRef,
    selectedIds,
    selectedIdsRef,
    setActiveOcrHover,
    setAnnoTool,
    setDrawingState,
    setGroups,
    setGroupBranches,
    setInlineTextEdit,
    setIsPanning,
    setItems,
    setItemsWithHistory,
    setSelectedIds,
    setStagePos,
    setStageScale,
    setStageSize,
    setTool,
    stagePos,
    stagePosRef,
    stageScale,
    stageScaleRef,
    stageSize,
    tool
  } = useProjectCanvasPageRuntimeState()

  const defaultCanvasBgColor = theme.palette.mode === 'light' ? '#ffffff' : '#1a1a1a'
  const {
    bgColor,
    bgColorPickerAnchor,
    bgCustomColor,
    currentShortcut,
    gridColor,
    handleBgColorChange,
    recordedShortcut,
    shortcutDialogOpen,
    showGrid,
    setBgColorPickerAnchor,
    setBgCustomColor,
    setCurrentShortcut,
    setRecordedShortcut,
    setShowGrid,
    setShortcutDialogOpen,
    setToolShortcutCtxMenu,
    setToolShortcutRecorded,
    toolShortcutCtxMenu,
    toolShortcutRecorded,
    toolShortcuts,
    transparentPattern,
    updateToolShortcut
  } = useProjectCanvasPageShellState({
    canvasId,
    defaultCanvasBgColor,
    language: i18n.language,
    themeMode: theme.palette.mode,
    setGroups
  })

  const { notifySuccess, notifyError, notifyWarning, notifyInfo, closeMessage } = useMessage()

  useProjectTraceRealtimeAdvice({ canvasId, notifyWarning })

  const {
    activeFileDialogItem,
    fileDialogDraftContent,
    fileDialogDraftSheets,
    setFileDialogDraftContent,
    setFileDialogDraftSheets,
    handleOpenFileDialog,
    handleCloseFileDialog,
    handleSaveFileDialog,
    handleExportCanvasFile
  } = useCanvasFilePreview({
    items,
    setItems,
    setItemsWithHistory,
    setSelectedIds,
    setTool,
    notifySuccess,
    notifyError
  })
  const openQuickAppPanel = useCallback(() => {
    dispatch(openSidePanel('quickapp'))
  }, [dispatch])
  useCanvasScreenshotShortcutSync({
    toolShortcuts,
    setCurrentShortcut,
    notifyWarning,
    notifyError
  })

  const figmaAccessToken = config.figma_config?.personal_access_token?.trim() || ''
  const figmaGlobalAutoCheckEnabled = config.figma_config?.auto_check_updates ?? true
  const figmaAutoCheckIntervalMinutes = Math.min(
    1440,
    Math.max(5, config.figma_config?.auto_check_interval_minutes ?? 15)
  )

  const actionMessageKeyRef = useRef<import('notistack').SnackbarKey | null>(null)

  useEffect(() => {
    if (
      tool !== 'export-select' &&
      tool !== 'crop-select' &&
      tool !== 'extract-select' &&
      actionMessageKeyRef.current
    ) {
      closeMessage(actionMessageKeyRef.current)
      actionMessageKeyRef.current = null
    }
  }, [tool, closeMessage])

  /*
  const promptForCanvasTaggingExportDir = useCallback(async (): Promise<string | null> => {
    const storageKey = `canvas.tagging.exportDir.${canvasId}`
    try {
      const cachedDir = localStorage.getItem(storageKey)?.trim()
      if (cachedDir) {
        return cachedDir
      }
    } catch {
      // Ignore storage read errors and fall back to dialog selection.
    }

    const dialogResult = await api().svcDialog.showOpenDialog({
      title: isChineseUi
        ? '选择打标 sidecar 导出目录'
        : 'Select a tagging sidecar export directory',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })

    const selectedPath = dialogResult.filePaths?.[0]
    if (dialogResult.canceled || !selectedPath) {
      return null
    }

    try {
      localStorage.setItem(storageKey, selectedPath)
    } catch {
      // Ignore storage write failures.
    }

    return selectedPath
  }, [canvasId, isChineseUi])

  const handleExportCanvasTaggingSidecars = useCallback(
    async (targetItems: CanvasItem[]) => {
      const taggableItems = filterCanvasConstraintAnnotations(targetItems).filter(
        (item) => item.tagging
      )

      if (!taggableItems.length) {
        notifyWarning(
          isChineseUi
            ? '当前选择中还没有可导出的打标结果。'
            : 'No tagging results are available for the current selection.'
        )
        return
      }

      const exportDir = await promptForCanvasTaggingExportDir()
      if (!exportDir) {
        return
      }

      const sidecarEntries = buildCanvasTaggingSidecarEntries(taggableItems)
      const encoder = new TextEncoder()

      for (const entry of sidecarEntries) {
        await api().svcHyper.saveImageToDir({
          data: encoder.encode(entry.textContent),
          fileName: entry.textFileName,
          dir: exportDir
        })
        await api().svcHyper.saveImageToDir({
          data: encoder.encode(entry.jsonContent),
          fileName: entry.jsonFileName,
          dir: exportDir
        })
      }

      notifySuccess(
        isChineseUi
          ? `已导出 ${sidecarEntries.length} 组打标 sidecar。`
          : `Exported ${sidecarEntries.length} tagging sidecar pairs.`
      )
    },
    [isChineseUi, notifySuccess, notifyWarning, promptForCanvasTaggingExportDir]
  )

  */
  const [imageContextMenu, setImageContextMenu] = useState<{
    mouseX: number
    mouseY: number
  } | null>(null)
  const [contextMenuTarget, setContextMenuTarget] = useState<CanvasItem | null>(null)

  const [selectionRect, setSelectionRect] = useState<SelectionRect>(null)
  const [isViewportInteracting, setIsViewportInteracting] = useState(false)

  const [annotationColor, setAnnotationColor] = useState('#ef4444')
  const [annotationFillOpacity, setAnnotationFillOpacity] = useState(0)
  const [annotationStrokeWidth, setAnnotationStrokeWidth] = useState(2)
  const [brushWidthAnchor, setBrushWidthAnchor] = useState<HTMLElement | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<HTMLElement | null>(null)
  const [shapePickerAnchor, setShapePickerAnchor] = useState<HTMLElement | null>(null)
  const [linePickerAnchor, setLinePickerAnchor] = useState<HTMLElement | null>(null)
  const [labelDialogOpen, setLabelDialogOpen] = useState(false)
  const [labelDialogItemId, setLabelDialogItemId] = useState<string | null>(null)
  const [croppingImageId, setCroppingImageId] = useState<string | null>(null)
  const [extractingImageId, setExtractingImageId] = useState<string | null>(null)
  const [labelDialogText, setLabelDialogText] = useState('')
  const canvasContainerRef = useRef<HTMLDivElement>(null) // ???? DOM?????????????????
  const stageRef = useRef<any>(null)
  const cropOverlayRef = useRef<ProjectCanvasImageCropOverlayHandle | null>(null)
  const canvasActiveRef = useRef(false)
  const isMiddleMouseRef = useRef(false)
  const lastViewportPointRef = useCanvasLastViewportPoint()
  const stageSizeRef = useRef(stageSize)
  const nextZIndex = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  if (!stageRef.current) {
    stageRef.current = createCanvasStageHandle({
      canvasContainerRef,
      stagePosRef,
      stageScaleRef,
      stageSizeRef
    })
  }

  useEffect(() => {
    stageSizeRef.current = stageSize
  }, [stageSize])

  const {
    fitSizeToCanvas: fitImageToCanvasSize,
    getBatchGridLayout,
    getCanvasPointFromClient,
    getCenterPosition,
    getNextAutoPlacement: getNextAutoImagePosition,
    getViewportBounds,
    markAutoPlacementBatch
  } = useCanvasViewportPlacement({
    stagePos,
    stagePosRef,
    stageSize,
    stageScale,
    stageScaleRef,
    stageRef,
    canvasContainerRef
  })

  const {
    activateModel3DRender,
    model3DViewerItemId,
    pendingTextureModelId,
    setModel3DViewerItemId,
    setPendingTextureModelId,
    setTextureImportDialogOpen,
    textureImportDialogOpen,
    textureInputRef
  } = useCanvasMediaRuntime({
    canvasActiveRef,
    items,
    lastClickedIdRef,
    setItems,
    setSelectedIds,
    setTool
  })

  const {
    addFileToCanvas,
    addHtmlToCanvas,
    addImageToCanvas,
    addImagesToCanvas,
    addModel3DToCanvas,
    addModel3DUrlToCanvas,
    addOcrResultToCanvas,
    addTextToCanvas,
    addVideoToCanvas,
    handleImportCanvasSceneFile,
    handleImportPsdFile,
    hydrateCanvasImageItemForCanvas,
    loadImageFromSrc
  } = useCanvasAssetIntake({
    canvasId,
    dispatch,
    fitImageToCanvasSize,
    getBatchGridLayout,
    getCanvasPointFromClient,
    getCenterPosition,
    getNextAutoImagePosition,
    getViewportBounds,
    markAutoPlacementBatch,
    isChineseUi,
    nextZIndexRef: nextZIndex,
    notifyError,
    notifySuccess,
    notifyWarning,
    openQuickAppPanel,
    setGroups,
    setGroupBranches,
    setPendingTextureModelId,
    setItemsWithoutHistory: setItems,
    setItemsWithHistory,
    setSelectedIds,
    setTextureImportDialogOpen,
    setTool,
    activateModel3DRender,
    resolveCurrentItemCount: () => items.length,
    onImageBatchImportProgress: handleImageBatchImportProgress,
    t
  })

  const {
    figmaBinding,
    setFigmaBinding,
    figmaBindingDialogOpen,
    figmaBusyAction,
    figmaBindingError,
    figmaFileKeyOrUrlInput,
    setFigmaFileKeyOrUrlInput,
    figmaDialogBinding,
    handleOpenFigmaBindingDialog,
    handleCloseFigmaBindingDialog,
    handleResolveFigmaBinding,
    handleFigmaDraftPageChange,
    handleFigmaDraftAutoCheckUpdatesChange,
    handleSaveFigmaBinding,
    handleUnbindFigmaBinding,
    handleCheckFigmaUpdate,
    handleSyncFigmaBinding
  } = useCanvasFigmaBinding({
    isChineseUi,
    figmaAccessToken,
    figmaGlobalAutoCheckEnabled,
    figmaAutoCheckIntervalMinutes,
    items,
    nextZIndexRef: nextZIndex,
    getViewportBounds,
    hydrateCanvasImageItemForCanvas,
    setItems,
    setGroups,
    setSelectedIds,
    setTool,
    notifySuccess,
    notifyWarning,
    notifyInfo
  })

  const exportableItems = useMemo(() => getCanvasExportableItems(items), [items])

  const selectedExportableItems = useMemo(
    () => getSelectedCanvasExportableItems(items, selectedIds),
    [items, selectedIds]
  )

  const {
    canvasBoundsToStageRect,
    buildCanvasAssetMetadata,
    getCanvasItemVisualBounds,
    getCanvasItemsVisualBounds,
    getOverlayStageRect,
    resolveCanvasTargetItemBounds,
    stageRectToCanvasBounds
  } = useCanvasVisualMetrics({
    canvasContainerRef,
    sessionKey: canvasAgentSessionKey,
    stagePos,
    stageRef,
    stageScale
  })

  const {
    exportMenuAnchor,
    exportSubmenuAnchor,
    exportSubmenuPlacement,
    exportCtxMenuPos,
    forceRenderAllItemsForExport,
    closeExportMenus,
    handleOpenExportMenu,
    handleOpenExportContextMenu,
    handleCloseExportContextMenu,
    handleCloseExportSubmenu,
    openExportSubmenu,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleSaveCanvasAsFromContextMenu,
    handleExportCanvasProjectFile,
    handleExportScopeWithFormat,
    renderCanvasItemsImageBytes,
    renderCanvasItemsImageDataUrl,
    renderCanvasItemsSvgMarkup,
    getQuickCanvasItemsImageUrl,
    prepareQuickCanvasItemsImageUrl
  } = useCanvasExportWorkflow({
    canvasId,
    projectName,
    items,
    groups,
    groupBranches,
    figmaBinding,
    selectedIds,
    setSelectedIds,
    stageRef,
    canvasContainerRef,
    stagePos,
    stageScale,
    bgColor,
    loadImageFromSrc,
    getCanvasItemVisualBounds,
    notifySuccess,
    notifyError
  })

  const handleOpenTargetSchemeManager = useCallback(() => {
    navigate('/target-manager')
  }, [navigate])

  const {
    targetSchemes,
    canvasTargetHistoryTargets,
    canvasTargetReferenceTraces,
    canvasTargetSelectedTraceIds,
    setCanvasTargetSelectedTraceIds,
    canvasTargetEvidenceMode,
    setCanvasTargetEvidenceMode,
    canvasTargetDialogOpen,
    canvasTargetLoading,
    canvasTargetError,
    canvasTargetTargetName,
    setCanvasTargetTargetName,
    canvasTargetSelectedHistoryTargetId,
    canvasTargetSelectedSchemeId,
    setCanvasTargetSelectedSchemeId,
    canvasTargetTargetItemCount,
    canvasTargetUserIntent,
    setCanvasTargetUserIntent,
    canvasTargetControlProfileId,
    setCanvasTargetControlProfileId,
    canvasTargetStageProfiles,
    setCanvasTargetStageProfiles,
    canvasTargetQuickAppOptions,
    canvasTargetQuickApps,
    setCanvasTargetQuickApps,
    canvasTargetControlProfileSelectOptions,
    canvasTargetStageProfileSelectOptions,
    canvasTargetReport,
    handleCloseCanvasTargetDialog,
    handleBeginCanvasTargetSelection,
    handleOpenCanvasTargetDialog,
    handleCancelCanvasTarget,
    handleApplyCanvasTargetHistoryTarget,
    handleRenameCanvasTargetHistoryTarget,
    handleDeleteCanvasTargetHistoryTarget,
    handleRunCanvasTarget,
    openTargetManager
  } = useCanvasTargetWorkflow({
    canvasId,
    projectName,
    isChineseUi,
    items,
    selectedIds,
    selectedIdsRef,
    groups,
    buildCanvasAssetMetadata,
    resolveCanvasTargetItemBounds,
    renderCanvasItemsImageDataUrl,
    setSelectionRect,
    setItemsWithHistory,
    setSelectedIds,
    setGroups,
    setTool,
    handleBgColorChange,
    setShowGrid,
    setAnnoTool,
    setAnnotationColor,
    setAnnotationStrokeWidth,
    setAnnotationFillOpacity,
    nextZIndexRef: nextZIndex,
    notifySuccess,
    notifyError,
    notifyWarning,
    notifyInfo,
    resolveDefaultProfileId: () => resolveActiveAgentProfileId(canvasId),
    resolveActiveAgentScope: () => resolveActiveAgentScope(canvasId),
    openTargetManager: handleOpenTargetSchemeManager
  })
  const { scheduleSelectionInfoDispatch } = useCanvasSelectionInfo({
    canvasId,
    projectName,
    items,
    groups,
    selectedIds,
    stageRef,
    getOverlayStageRect,
    stageRectToCanvasBounds,
    resolveCanvasTargetItemBounds,
    buildCanvasAssetMetadata
  })

  const tryHandleCanvasExternalDropRef = useRef<
    (itemId: string, clientX: number, clientY: number) => boolean
  >(() => false)

  const {
    agentSendMenuAnchor,
    agentSendMenuItemIds,
    dccExportMenuAnchor,
    dccExportMenuItemId,
    handleSendCanvasItemsToAgent,
    handleOpenAgentSendMenu,
    handleCloseAgentSendMenu,
    handleSelectAgentTargetApp,
    handleSendCanvasItemsSnapshotToPhotoshop,
    handleOpenDccExportMenu,
    handleCloseDccExportMenu,
    handleSelectDccExportTarget
  } = useCanvasBridgeActions({
    canvasId,
    projectName,
    items,
    groups,
    notifySuccess,
    notifyError,
    extractPromptTextFromCanvasItems,
    renderCanvasItemsImageDataUrl,
    renderCanvasItemsSvgMarkup
  })

  const {
    handleCopyCanvasItemsAsImage,
    handleDownloadBlobItem,
    handleDownloadCanvasItemsAsImage,
    handleOpenMediaCaptionEditor,
    handleSendCanvasItemsToAgentForGeneration,
    handleSendSelectionToAgent,
    mediaCaptionActionLabel,
    mediaCaptionPlaceholder
  } = useCanvasSelectionActions({
    items,
    selectedIds,
    setSelectedIds,
    setTool,
    setInlineTextEdit,
    getCanvasItemVisualBounds,
    handleSendCanvasItemsToAgent,
    notifySuccess,
    notifyError,
    renderCanvasItemsImageBytes
  })

  const {
    generationTaskDialogOpen,
    generationTaskPack,
    handleCloseGenerationTaskDialog,
    handleConfirmGenerationTaskPack,
    handleGenerateCanvasItems
  } = useCanvasGenerationWorkflow({
    canvasId,
    projectName,
    items,
    notifySuccess,
    notifyWarning,
    sendCanvasItemsToAgent: handleSendCanvasItemsToAgentForGeneration
  })

  const {
    generationTraceHistoryDialogOpen,
    generationTraceRecentRecords,
    handleAppendGenerationTraceCandidate,
    handleCloseGenerationTraceHistory,
    handleConfirmGenerationTaskPackWithTraceRefresh,
    handleContinueGenerationTraceRecord,
    handleDeleteGenerationTraceHistoryRecord,
    handleOpenGenerationTraceHistory,
    handleUpdateGenerationTraceDecision
  } = useCanvasGenerationTrace({
    canvasId,
    items,
    isChineseUi,
    notifyWarning,
    setSelectedIds,
    handleGenerateCanvasItems,
    handleConfirmGenerationTaskPack
  })

  const focusCanvasStage = useCallback(() => {
    canvasActiveRef.current = true
    canvasContainerRef.current?.focus({ preventScroll: true })
  }, [canvasActiveRef, canvasContainerRef])

  const { handleDrop, handleDragOver, handleImportFiles, handleFile, handleToolbarImportClick } =
    useCanvasFileIntake({
      canvasId,
      canvasContainerRef,
      canvasActiveRef,
      notifyWarning,
      addImageToCanvas,
      addImagesToCanvas,
      addModel3DToCanvas,
      addModel3DUrlToCanvas,
      addVideoToCanvas,
      addFileToCanvas,
      addOcrResultToCanvas,
      addTextToCanvas,
      handleImportCanvasSceneFile,
      handleImportPsdFile,
      focusCanvasStage,
      onImageBatchImportProgress: handleImageBatchImportProgress
    })

  useCanvasCustomAddEvents({
    canvasId,
    addImageToCanvas,
    addImagesToCanvas,
    addModel3DUrlToCanvas,
    addVideoToCanvas,
    addTextToCanvas,
    handleAppendGenerationTraceCandidate
  })

  useCanvasKeyboardShortcuts({
    canvasActiveRef,
    toolShortcuts,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleExportScopeWithFormat,
    handleUndo,
    handleRedo,
    items,
    selectedIds,
    setSelectedIds,
    setItemsWithHistory,
    setTool,
    setAnnoTool,
    setSelectionRect,
    setCroppingImageId,
    setExtractingImageId
  })

  const {
    clearConfirmOpen,
    closeClearConfirmDialog,
    focusCanvasBounds,
    handleConfirmClearDialog,
    handleFileSelect,
    handleFitAll,
    handleModelSelect,
    handleVideoSelect,
    openClearConfirmDialog,
    setStageScaleAroundViewportCenter
  } = useCanvasViewportPersistence({
    config,
    canvasId,
    items,
    groups,
    groupBranches,
    selectedIds,
    figmaBinding,
    stagePos,
    stageScale,
    stageSize,
    maxFitStageScale: MAX_FIT_STAGE_SCALE,
    clampStageScale,
    getCanvasItemsVisualBounds,
    hydrateCanvasImageItemForCanvas,
    nextZIndexRef: nextZIndex,
    setItems,
    setItemsWithHistory,
    setGroups,
    setGroupBranches,
    setSelectedIds,
    setStagePos,
    setStageScale,
    setFigmaBinding,
    handleImportFiles,
    addModel3DToCanvas,
    addVideoToCanvas,
    suspendAutoSave: isImageBatchImportActive
  })

  useEffect(() => {
    return installProjectCanvasBenchmarkViewportSetter((viewport) => {
      const result = resolveProjectCanvasBenchmarkViewport(viewport, {
        items,
        stagePos: stagePosRef.current,
        stageScale: stageScaleRef.current,
        stageSize,
        clampStageScale
      })
      const nextPos = { x: result.x, y: result.y }
      if (result.focusedImageId && result.shouldSelectFocusedImage) {
        setSelectedIds(new Set([result.focusedImageId]))
      }
      stageScaleRef.current = result.scale
      stagePosRef.current = nextPos
      setStageScale(result.scale)
      setStagePos(nextPos)
      return {
        scale: result.scale,
        x: result.x,
        y: result.y,
        ...(result.focusedImageId ? { focusedImageId: result.focusedImageId } : {})
      }
    })
  }, [items, setSelectedIds, setStagePos, setStageScale, stagePosRef, stageScaleRef, stageSize])

  const inlineTextAreaRef = useRef<HTMLTextAreaElement>(null)
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items])
  useCanvasInlineTextEffects({
    getCanvasItemVisualBounds,
    inlineTextAreaRef,
    inlineTextEdit,
    itemIdSet,
    items,
    setInlineTextEdit,
    setItems,
    setStagePos,
    stagePos,
    stageScale,
    stageSize
  })
  const { handleResize } = useCanvasStageResize({
    setStageSize,
    stageRef
  })

  const dragContextRef = useRef<{
    draggingId: string | null
    startPositions: Map<string, { x: number; y: number; type?: string }>
  }>({
    draggingId: null,
    startPositions: new Map()
  })

  // Imperative selection rect updates avoid React renders during drag.
  const {
    suppressSelectionChromeAfterMarquee,
    handleSelectionRectElementsChange,
    handleSelectionRectChange,
    handleSelectionMarqueeActiveChange
  } = useCanvasSelectionRectDomDriver({
    canvasContainerRef,
    isDebugEnabled: isCanvasInteractionDebugEnabled
  })

  // Viewport transform driver: drives DOM directly during pan/zoom (zero React renders).
  // Instantiated here so applyViewportTransform can be passed to the interaction hook.
  const {
    registerViewportLayer,
    registerViewportCallback,
    registerViewportInteractionCallback,
    applyViewportTransform,
    applyViewportInteractionState
  } = useStageViewportTransformDriver()

  const shouldCommitViewportInteractionState = useMemo(
    () =>
      items.some(
        (item) =>
          item.type === 'image' ||
          item.type === 'video' ||
          item.type === 'model3d' ||
          item.type === 'html' ||
          item.type === 'file' ||
          item.type === 'text' ||
          item.type === 'annotation'
      ),
    [items]
  )
  const shouldCommitViewportInteractionStateRef = useRef(shouldCommitViewportInteractionState)
  useEffect(() => {
    shouldCommitViewportInteractionStateRef.current = shouldCommitViewportInteractionState
    if (!shouldCommitViewportInteractionState) {
      setIsViewportInteracting(false)
    }
  }, [shouldCommitViewportInteractionState])

  useLayoutEffect(() => {
    applyViewportTransform(stagePos, stageScale)
  }, [applyViewportTransform, stagePos, stageScale])

  const { handleStageMouseDown, handleStageMouseMove, handleStageMouseUp, handleStageWheel } =
    useCanvasStageInteraction({
      annotationColor,
      annotationFillOpacity,
      annotationStrokeWidth,
      annoTool,
      canvasContainerRef,
      clampStageScale,
      cropOverlayRef,
      dragContextRef,
      drawingState,
      getCanvasItemBounds,
      handleOpenCanvasTargetDialog,
      isChineseUi,
      isFillableAnnotationShape,
      isMiddleMouseRef,
      isPanning,
      items,
      lastPanPosRef,
      nextZIndex,
      notifyWarning,
      selectedIds,
      selectionRect,
      setDrawingState,
      setInlineTextEdit,
      setIsPanning,
      setItemsWithHistory,
      setSelectedIds,
      setSelectionRect,
      setStagePos,
      setStageScale,
      setTool,
      stagePos,
      stagePosRef,
      stageRef,
      stageScale,
      stageScaleRef,
      tool,
      onViewportInteractionStart: () => {
        applyViewportInteractionState(true)
        if (shouldCommitViewportInteractionStateRef.current) {
          setIsViewportInteracting(true)
        }
      },
      onViewportInteractionEnd: () => {
        applyViewportInteractionState(false)
        setIsViewportInteracting(false)
      },
      onViewportChange: applyViewportTransform,
      onSelectionRectChange: handleSelectionRectChange,
      onSelectionMarqueeActiveChange: handleSelectionMarqueeActiveChange
    })

  const {
    handleDeleteHtmlItem,
    handleDragEnd,
    handleToggleVideoPlayback,
    handleTransformEnd,
    handleUpdateHtmlItem,
    handleUpdateVideoItem
  } = useCanvasLayerRuntime({
    canvasContainerRef,
    lastViewportPointRef,
    selectedIds,
    setItems,
    setItemsWithHistory,
    setSelectedIds,
    tryHandleCanvasExternalDropRef
  })

  const cursorStyle = getCanvasCursorStyle(tool, isPanning)
  const shouldForceShapeCreationCrosshair = shouldForceCanvasCrosshair(tool, annoTool)
  const {
    groupMenuAnchor,
    groupRenameDraft,
    groupRenameId,
    groupRenameInputRef,
    handleAutoArrangeGroup,
    handleCancelGroupRename,
    handleCloseGroupMenu,
    handleCommitGroupRename,
    handleCreateGroup,
    handleCreateGroupBranch,
    handleDeleteGroup,
    handleDeleteGroupBranch,
    handleFocusGroup,
    handleFocusGroupBranch,
    handleMoveGroupToBranch,
    handleOpenGroupMenu,
    handleRenameGroup,
    handleRenameGroupBranch,
    handleStartGroupRename,
    setGroupRenameDraft
  } = useCanvasGroupManagement({
    groups,
    groupBranches,
    items,
    selectedIds,
    setGroups,
    setGroupBranches,
    setSelectedIds,
    setTool,
    setSelectionRect,
    setItemsWithHistory,
    focusCanvasBounds,
    lastClickedIdRef,
    language: i18n.language,
    notifyError,
    notifyWarning,
    t
  })
  const { handleExtractImageRegion } = useCanvasImageExtract({
    items,
    groups,
    isChineseUi,
    nextZIndexRef: nextZIndex,
    lastClickedIdRef,
    setGroups,
    setItemsWithHistory,
    setSelectedIds,
    hydrateCanvasImageItemForCanvas,
    loadImageFromSrc,
    notifySuccess,
    notifyError,
    notifyInfo
  })
  const {
    activeGroupPlaybackCanvasBounds,
    activeGroupPlaybackGroup,
    activeGroupPlaybackItem,
    activeGroupPlaybackScreenBounds,
    exactSelectedGroup,
    groupPlayback,
    groupSummaries,
    handleExportGroupPlaybackAsGif,
    handleGroupPlaybackVideoEnded,
    pauseGroupPlayback,
    resumeGroupPlayback,
    selectionOverlayGroups,
    startGroupPlayback,
    stopGroupPlayback
  } = useCanvasGroupPlayback({
    groups,
    items,
    selectedIds,
    language: i18n.language,
    getCanvasItemsVisualBounds,
    canvasBoundsToStageRect,
    focusCanvasBounds,
    handleCloseGroupMenu,
    lastClickedIdRef,
    setItems,
    setModel3DViewerItemId,
    setSelectedIds,
    setSelectionRect,
    setTool,
    notifyInfo,
    notifySuccess,
    notifyError,
    t,
    isChineseUi
  })

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.zIndex - b.zIndex), [items])

  const { selectedItems } = useCanvasDuplicateCheckRuntimeBridge({
    canvasId,
    projectName,
    items,
    selectedIds,
    setSelectedIds,
    focusCanvasStage,
    focusCanvasBounds
  })

  useProjectTraceCanvasEvents({
    canvasId,
    projectName,
    items,
    selectedIds,
    isChineseUi
  })

  const {
    activeModel3DItem,
    handleCloseModel3DViewer,
    handleCloseTextureImportDialog,
    handleOpenModel3DViewer,
    handleOpenTextureImportInput,
    handleRequestModel3DTextureImport,
    handleSkipTextureImportDialog,
    handleTextureFilesSelected,
    handleUpdateModel3DTextures,
    htmlItems,
    renderedModel3DItems,
    videoItems,
    visibleItems
  } = useCanvasViewerPlayback({
    canvasActiveRef,
    forceRenderAllItemsForExport,
    groupPlayback,
    isViewportInteracting,
    items,
    lastClickedIdRef,
    notifyError,
    selectedIds,
    setItems,
    setItemsWithHistory,
    setSelectedIds,
    setTool,
    sortedItems,
    stagePos,
    stageScale,
    stageSize,
    model3DViewerItemId,
    pendingTextureModelId,
    textureImportDialogOpen,
    setModel3DViewerItemId,
    setPendingTextureModelId,
    setTextureImportDialogOpen,
    textureInputRef
  })
  const {
    annotationFillEnabled,
    annotationToolbarBorderColor,
    annotationToolbarHoverSurface,
    annotationToolbarIdleSurface,
    annotationToolbarMutedText,
    annotationToolbarShadow,
    annotationToolbarStrongText,
    annotationToolbarSurface,
    buildCanvasDragPayload,
    countLabel,
    getCanvasImageDragObjectUrl,
    handleBringForward,
    handleBringToFront,
    handleCloseImageContextMenu,
    handleConfirmLabelDialog,
    handleCopyCanvasImage,
    handleCropImage,
    handleExtractImage,
    handleDownloadCanvasImage,
    handleFlipImage,
    handleImageContextMenu,
    handleOpenTextureImportFromContextMenu,
    handleSendBackward,
    handleSendToBack,
    handleSendToPhotoshop,
    handleSmartCleanup,
    handleToggleAnnotationFillMode,
    hasSelectedTextItem,
    isLightCanvasTheme,
    resetDraggedItemNode,
    scalePercent,
    setCanvasDragPayload,
    showAnnotationFillToggle,
    showAnnotationStrokeControl
  } = useCanvasSelectionUiActions({
    alpha,
    annoTool,
    annotationColor,
    annotationFillOpacity,
    annotationStrokeWidth,
    canvasContainerRef,
    canvasId,
    contextMenuTarget,
    extractPromptTextFromCanvasItems,
    getCanvasItemsBounds,
    handleCopyCanvasItemsAsImage,
    handleDownloadCanvasItemsAsImage,
    handleSendCanvasItemsSnapshotToPhotoshop,
    handleSendSelectionToAgent,
    isChineseUi,
    isFillableAnnotationShape,
    items,
    labelDialogItemId,
    labelDialogText,
    nextZIndex,
    notifyError,
    notifySuccess,
    selectedIds,
    setAnnotationFillOpacity,
    setContextMenuTarget,
    setCroppingImageId,
    setExtractingImageId,
    setImageContextMenu,
    setItems,
    setItemsWithHistory,
    setLabelDialogOpen,
    setPendingTextureModelId,
    setSelectedIds,
    setTextureImportDialogOpen,
    setTool,
    stagePos,
    stageRef,
    stageScale,
    t,
    theme,
    tool,
    tryHandleCanvasExternalDropRef,
    actionMessageKeyRef
  })
  const shellProps = buildProjectCanvasPageShellProps({
    CANVAS_IMPORT_ACCEPT,
    DccExportIcon,
    MODEL_IMPORT_EXTENSIONS,
    Model3DIcon,
    activeFileDialogItem,
    activeGroupPlaybackCanvasBounds,
    activeGroupPlaybackGroup,
    activeGroupPlaybackItem,
    activeGroupPlaybackScreenBounds,
    activeModel3DItem,
    activeOcrHover,
    agentSendMenuAnchor,
    agentSendMenuItemIds,
    alpha,
    annoTool,
    annotationColor,
    annotationFillEnabled,
    annotationFillOpacity,
    annotationStrokeWidth,
    annotationToolbarBorderColor,
    annotationToolbarHoverSurface,
    annotationToolbarIdleSurface,
    annotationToolbarMutedText,
    annotationToolbarShadow,
    annotationToolbarStrongText,
    annotationToolbarSurface,
    bgColor,
    bgColorPickerAnchor,
    brushWidthAnchor,
    buildCanvasDragPayload,
    canPlayGroupSummary,
    canvasAgentSessionKey,
    canvasTargetControlProfileId,
    canvasTargetDialogOpen,
    canvasTargetError,
    canvasTargetHistoryTargets,
    canvasTargetReferenceTraces,
    canvasTargetSelectedTraceIds,
    canvasTargetEvidenceMode,
    canvasTargetLoading,
    canvasTargetControlProfileSelectOptions,
    canvasTargetQuickAppOptions,
    canvasTargetQuickApps,
    canvasTargetStageProfileSelectOptions,
    canvasTargetReport,
    canvasTargetSelectedHistoryTargetId,
    canvasTargetSelectedSchemeId,
    canvasTargetStageProfiles,
    canvasTargetTargetName,
    canvasTargetTargetItemCount,
    canvasTargetUserIntent,
    canvasActiveRef,
    canvasContainerRef,
    clampStageScale,
    clearConfirmOpen,
    colorPickerAnchor,
    contextMenuTarget,
    countLabel,
    cropOverlayRef,
    croppingImageId,
    extractingImageId,
    currentShortcut,
    cursorStyle,
    targetSchemes,
    dccExportMenuAnchor,
    dccExportMenuItemId,
    dragContextRef,
    drawingState,
    exactSelectedGroup,
    exportCtxMenuPos,
    exportMenuAnchor,
    exportSubmenuAnchor,
    exportSubmenuPlacement,
    exportableItems,
    forceRenderAllItemsForExport,
    figmaAccessToken,
    figmaAutoCheckIntervalMinutes,
    figmaBindingDialogOpen,
    figmaBindingError,
    figmaBusyAction,
    figmaDialogBinding,
    figmaFileKeyOrUrlInput,
    figmaGlobalAutoCheckEnabled,
    fileDialogDraftContent,
    fileDialogDraftSheets,
    fileInputRef,
    generationTaskDialogOpen,
    generationTaskPack,
    generationTraceHistoryDialogOpen,
    generationTraceRecentRecords,
    getQuickCanvasItemsImageUrl,
    prepareQuickCanvasItemsImageUrl,
    gridColor,
    groupBranches,
    groupMenuAnchor,
    groupPlayback,
    groupRenameDraft,
    groupRenameId,
    groupRenameInputRef,
    groupSummaries,
    hasSelectedTextItem,
    htmlItems,
    imageContextMenu,
    imageBatchImportProgress,
    inlineTextAreaRef,
    inlineTextEdit,
    isChineseUi,
    isFillableAnnotationShape,
    isLegacySelectionToolbarEnabled,
    isLightCanvasTheme,
    isMiddleMouseRef,
    isViewportInteracting,
    isCanvasPerformanceThrottled,
    suppressSelectionChromeAfterMarquee,
    itemIdSet,
    items,
    labelDialogOpen,
    labelDialogText,
    lastClickedIdRef,
    linePickerAnchor,
    mediaCaptionActionLabel,
    mediaCaptionPlaceholder,
    modelInputRef,
    nextZIndex,
    notifyError,
    openTargetManager,
    openClearConfirmDialog,
    openExportSubmenu,
    onSelectionRectElementsChange: handleSelectionRectElementsChange,
    pauseGroupPlayback,
    recordedShortcut,
    renderedModel3DItems,
    resumeGroupPlayback,
    scalePercent,
    selectedExportableItems,
    selectedIds,
    selectionOverlayGroups,
    selectionRect,
    selectionRectRenderMode: 'imperative',
    shapePickerAnchor,
    shortcutDialogOpen,
    shouldForceShapeCreationCrosshair,
    showAnnotationFillToggle,
    showAnnotationStrokeControl,
    showGrid,
    stagePos,
    stageRef,
    stageScale,
    stageSize,
    t,
    textureImportDialogOpen,
    textureInputRef,
    theme,
    tool,
    toolShortcutCtxMenu,
    toolShortcutRecorded,
    toolShortcuts,
    transparentPattern,
    videoInputRef,
    videoItems,
    visibleItems,
    closeClearConfirmDialog,
    closeExportMenus,
    handleAutoArrangeGroup,
    handleBgColorChange,
    handleBringForward,
    handleBringToFront,
    handleCancelCanvasTarget,
    setCanvasTargetSelectedTraceIds,
    setCanvasTargetEvidenceMode,
    handleCancelGroupRename,
    handleCheckFigmaUpdate,
    handleCloseAgentSendMenu,
    handleCloseCanvasTargetDialog,
    handleCloseDccExportMenu,
    handleCloseExportContextMenu,
    handleCloseExportSubmenu,
    handleCloseFigmaBindingDialog,
    handleCloseFileDialog,
    handleCloseGenerationTaskDialog,
    handleCloseGenerationTraceHistory,
    handleCloseGroupMenu,
    handleCloseImageContextMenu,
    handleCloseModel3DViewer,
    handleCloseTextureImportDialog,
    handleCommitGroupRename,
    handleConfirmClearDialog,
    handleConfirmGenerationTaskPackWithTraceRefresh,
    handleConfirmLabelDialog,
    handleContinueGenerationTraceRecord,
    handleCopyCanvasImage,
    handleCopyCanvasItemsAsImage,
    handleCreateGroup,
    handleCreateGroupBranch,
    handleApplyCanvasTargetHistoryTarget,
    handleCropImage,
    handleExtractImage,
    handleExtractImageRegion,
    handleDeleteCanvasTargetHistoryTarget,
    handleDeleteGenerationTraceHistoryRecord,
    handleDeleteGroup,
    handleDeleteGroupBranch,
    handleDeleteHtmlItem,
    handleDownloadBlobItem,
    handleDownloadCanvasImage,
    handleDownloadCanvasItemsAsImage,
    handleDragEnd,
    handleDragOver,
    handleDrop,
    handleExportGroupPlaybackAsGif,
    handleExportScopeWithFormat,
    handleFigmaDraftAutoCheckUpdatesChange,
    handleFigmaDraftPageChange,
    handleFileSelect,
    handleFitAll,
    handleFlipImage,
    handleFocusGroup,
    handleFocusGroupBranch,
    handleMoveGroupToBranch,
    handleGenerateCanvasItems,
    handleGroupPlaybackVideoEnded,
    handleImageContextMenu,
    handleModelSelect,
    handleOpenAgentSendMenu,
    handleOpenDccExportMenu,
    handleOpenExportContextMenu,
    handleOpenExportMenu,
    handleOpenFileDialog,
    handleOpenGenerationTraceHistory,
    handleOpenGroupMenu,
    handleOpenMediaCaptionEditor,
    handleOpenModel3DViewer,
    handleOpenTextureImportFromContextMenu,
    handleOpenTextureImportInput,
    handleRequestModel3DTextureImport,
    handleResize,
    handleRenameCanvasTargetHistoryTarget,
    handleRenameGroup,
    handleRenameGroupBranch,
    handleResolveFigmaBinding,
    handleRunCanvasTarget,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleSaveCanvasAsFromContextMenu,
    handleExportCanvasProjectFile,
    handleSaveFigmaBinding,
    handleSaveFileDialog,
    handleSelectAgentTargetApp,
    handleSelectDccExportTarget,
    handleSendBackward,
    handleSendCanvasItemsToAgent,
    handleSendToBack,
    handleSkipTextureImportDialog,
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageWheel,
    handleStartGroupRename,
    handleSyncFigmaBinding,
    handleTextureFilesSelected,
    handleToggleAnnotationFillMode,
    handleToggleVideoPlayback,
    handleToolbarImportClick,
    handleTransformEnd,
    handleUnbindFigmaBinding,
    handleUpdateGenerationTraceDecision,
    handleUpdateHtmlItem,
    handleUpdateModel3DTextures,
    handleUpdateVideoItem,
    handleVideoSelect,
    startGroupPlayback,
    stopGroupPlayback,
    setActiveOcrHover,
    setAnnoTool,
    setAnnotationColor,
    setAnnotationStrokeWidth,
    setBgColorPickerAnchor,
    setBgCustomColor,
    setBrushWidthAnchor,
    setCanvasTargetControlProfileId,
    setCanvasTargetTargetName,
    setCanvasTargetSelectedSchemeId,
    setCanvasTargetStageProfiles,
    setCanvasTargetQuickApps,
    setCanvasTargetUserIntent,
    setCanvasDragPayload,
    setColorPickerAnchor,
    setCroppingImageId,
    setExtractingImageId,
    setCurrentShortcut,
    setFigmaFileKeyOrUrlInput,
    setFileDialogDraftContent,
    setFileDialogDraftSheets,
    setGroupRenameDraft,
    setInlineTextEdit,
    setItems,
    setItemsWithHistory,
    setGroupBranches,
    setLabelDialogItemId,
    setLabelDialogOpen,
    setLabelDialogText,
    setLinePickerAnchor,
    setRecordedShortcut,
    setSelectedIds,
    setShapePickerAnchor,
    setShortcutDialogOpen,
    setStagePos,
    setStageScale,
    setStageScaleAroundViewportCenter,
    setTool,
    setToolShortcutCtxMenu,
    setToolShortcutRecorded,
    updateToolShortcut
  })

  return (
    <ProjectCanvasPageShell
      {...shellProps}
      registerViewportLayer={registerViewportLayer}
      registerViewportCallback={registerViewportCallback}
      registerViewportInteractionCallback={registerViewportInteractionCallback}
    />
  )
}

const ProjectCanvasPage: React.FC = () => {
  const location = useLocation()
  const canvasId = new URLSearchParams(location.search).get('id') || 'default'

  return <ProjectCanvasPageContent key={canvasId} canvasId={canvasId} />
}

export default ProjectCanvasPage
