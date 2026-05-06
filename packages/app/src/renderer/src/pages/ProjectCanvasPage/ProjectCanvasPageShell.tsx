/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
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
  Slider,
  LinearProgress
} from '@mui/material'
import { alpha as muiAlpha } from '@mui/material/styles'
import {
  BackHand as HandIcon,
  NearMe as SelectIcon,
  PlayArrow as PlayArrowIcon,
  PauseCircleFilled as PauseIcon,
  CenterFocusStrong as FitIcon,
  DeleteSweep as ClearIcon,
  ViewInAr as Model3DIcon,
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
  AutoAwesome as AutoAwesomeIcon,
  AppsOutlined as AppsOutlinedIcon,
  LayersOutlined as LayersOutlinedIcon,
  ChevronRight as ChevronRightIcon,
  FormatBold as FormatBoldIcon
} from '@mui/icons-material'
import {
  DatabaseIconSVG,
  DocumentIconSVG,
  DoubleLineRectIconSVG,
  ParallelogramIconSVG,
  RhombusIconSVG,
  RoundedRectIconSVG
} from './projectCanvasPageShared'
import {
  buildReservedCanvasShortcuts,
  conflictsWithCanvasShortcut,
  toElectronAccelerator
} from '@shared/shortcutConflictUtils'
import ProjectCanvasPageTopToolbar from './ProjectCanvasPageTopToolbar'
import ProjectCanvasPageOverlayDialogAssembly from './ProjectCanvasPageOverlayDialogAssembly'
import ProjectCanvasPageStageScene from './ProjectCanvasPageStageScene'
import { resolveProjectCanvasRenderBoundary } from './projectCanvasRenderBoundary'
import type {
  AnnotationShape,
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import type { AttachedCaptionAnnotation } from './canvasAttachedCaptionUtils'

const MemoizedProjectCanvasPageStageScene = React.memo(ProjectCanvasPageStageScene)
const IMAGE_BATCH_IMPORT_PREPARING_DISPLAY_WEIGHT = 0.35

function clampImageBatchImportRatio(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function resolveImageBatchImportDisplay(progress: {
  phase: string
  total: number
  processed: number
  imported: number
}) {
  const total = Math.max(0, Number(progress.total) || 0)
  if (total <= 0) {
    return { percent: 0, displayCount: 0 }
  }

  const processedRatio = clampImageBatchImportRatio((Number(progress.processed) || 0) / total)
  const importedRatio = clampImageBatchImportRatio((Number(progress.imported) || 0) / total)
  const progressRatio =
    progress.phase === 'preparing'
      ? processedRatio * IMAGE_BATCH_IMPORT_PREPARING_DISPLAY_WEIGHT
      : progress.phase === 'complete'
        ? 1
        : IMAGE_BATCH_IMPORT_PREPARING_DISPLAY_WEIGHT +
          Math.max(processedRatio, importedRatio) *
            (1 - IMAGE_BATCH_IMPORT_PREPARING_DISPLAY_WEIGHT)
  const percent = Math.max(0, Math.min(100, Math.round(progressRatio * 100)))
  const displayCount =
    progress.phase === 'complete'
      ? Math.max(0, Math.min(total, Number(progress.imported) || 0))
      : Math.max(0, Math.min(total, Math.round(progressRatio * total)))

  return { percent, displayCount }
}

export default function ProjectCanvasPageShell(props: any) {
  const { imageBatchImportProgress: _imageBatchImportProgress, ...stageSceneProps } = props
  const toolbarProps = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(props).filter(
          ([key]) =>
            key !== 'selectionOverlayGroups' &&
            key !== 'selectionRect' &&
            key !== 'imageBatchImportProgress'
        )
      ),
    [props]
  )
  const {
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
    canvasContainerRef,
    clampStageScale,
    clearConfirmOpen,
    closeClearConfirmDialog,
    closeExportMenus,
    colorPickerAnchor,
    contextMenuTarget,
    countLabel,
    cropOverlayRef,
    croppingImageId,
    currentShortcut,
    cursorStyle,
    targetSchemes,
    dccExportMenuAnchor,
    dccExportMenuItemId,
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
    groupMenuAnchor,
    groupPlayback,
    groupRenameDraft,
    groupRenameId,
    groupRenameInputRef,
    groupSummaries,
    handleAutoArrangeGroup,
    handleBgColorChange,
    handleBringForward,
    handleBringToFront,
    handleCancelCanvasTarget,
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
    handleCropImage,
    handleExtractImage,
    handleApplyCanvasTargetHistoryTarget,
    handleDeleteCanvasTargetHistoryTarget,
    handleDeleteGenerationTraceHistoryRecord,
    handleDeleteGroup,
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
    handleResolveFigmaBinding,
    handleRenameCanvasTargetHistoryTarget,
    handleRunCanvasTarget,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleSaveCanvasAsFromContextMenu,
    handleSaveFigmaBinding,
    handleExportCanvasFile,
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
    pauseGroupPlayback,
    recordedShortcut,
    renderedModel3DItems,
    resumeGroupPlayback,
    scalePercent,
    selectedExportableItems,
    selectedIds,
    selectionOverlayGroups,
    selectionRect,
    setActiveOcrHover,
    setAnnoTool,
    setAnnotationColor,
    setAnnotationStrokeWidth,
    setBgColorPickerAnchor,
    setBgCustomColor,
    setBrushWidthAnchor,
    setCanvasTargetControlProfileId,
    setCanvasTargetSelectedTraceIds,
    setCanvasTargetEvidenceMode,
    setCanvasTargetTargetName,
    setCanvasTargetSelectedSchemeId,
    setCanvasTargetStageProfiles,
    setCanvasTargetQuickApps,
    setCanvasTargetUserIntent,
    setCanvasDragPayload,
    setColorPickerAnchor,
    setCroppingImageId,
    setCurrentShortcut,
    setFigmaFileKeyOrUrlInput,
    setFileDialogDraftContent,
    setFileDialogDraftSheets,
    setGroupRenameDraft,
    setInlineTextEdit,
    setItems,
    setItemsWithHistory,
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
    registerViewportLayer,
    registerViewportCallback,
    registerViewportInteractionCallback,
    shapePickerAnchor,
    shortcutDialogOpen,
    shouldForceShapeCreationCrosshair,
    showAnnotationFillToggle,
    showAnnotationStrokeControl,
    showGrid,
    stagePos,
    stagePosRef,
    stageRef,
    stageScale,
    stageScaleRef,
    stageSize,
    startGroupPlayback,
    stopGroupPlayback,
    t,
    textureImportDialogOpen,
    textureInputRef,
    theme,
    tool,
    toolShortcutCtxMenu,
    toolShortcutRecorded,
    toolShortcuts,
    transparentPattern,
    updateToolShortcut,
    videoInputRef,
    videoItems,
    visibleItems
  } = props
  const deferredStagePos = React.useDeferredValue(stagePos)
  const deferredStageScale = React.useDeferredValue(stageScale)
  const deferredStageSize = React.useDeferredValue(stageSize)
  const [canvasContainerElement, setCanvasContainerElement] = React.useState<HTMLDivElement | null>(
    canvasContainerRef.current
  )
  const [liveMultiSelectionBounds, setLiveMultiSelectionBounds] = React.useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)

  React.useEffect(() => {
    if (tool !== 'select' || selectedIds.size <= 1) {
      setLiveMultiSelectionBounds(null)
    }
  }, [selectedIds.size, tool])
  const resolvedVideoBudgetModeById = React.useMemo<
    ReadonlyMap<string, 'active-playing' | 'visible-paused' | 'poster-frame' | 'unmounted'>
  >(() => {
    if (isViewportInteracting) {
      return new Map()
    }

    const renderableVideoItems = resolveProjectCanvasRenderBoundary({
      items: videoItems,
      webglReady: true,
      loadedImageIds: new Set(),
      selectedIds,
      stagePos: deferredStagePos,
      stageScale: deferredStageScale,
      stageSize: deferredStageSize,
      forceRenderAllItemsForExport
    })
    return new Map<string, 'active-playing' | 'visible-paused' | 'poster-frame' | 'unmounted'>(
      renderableVideoItems
        .filter((item) => item.kind === 'video')
        .map((item) => [item.id, item.videoBudgetMode ?? 'visible-paused'])
    )
  }, [
    deferredStagePos,
    deferredStageScale,
    deferredStageSize,
    forceRenderAllItemsForExport,
    isViewportInteracting,
    selectedIds,
    videoItems
  ])
  const visibleOverlayItems = React.useMemo(() => {
    const annotationItems: CanvasAnnotationItem[] = []
    const textItems: CanvasTextItem[] = []
    const fileItems: CanvasFileItem[] = []

    for (const item of visibleItems as CanvasItem[]) {
      if (item.type === 'annotation') {
        annotationItems.push(item)
        continue
      }

      if (item.type === 'text') {
        textItems.push(item)
        continue
      }

      if (item.type === 'file') {
        fileItems.push(item)
      }
    }

    return {
      annotationItems,
      textItems,
      fileItems
    }
  }, [visibleItems])

  const overlayRenderedModel3DItems = renderedModel3DItems
  const overlayVideoItems = videoItems
  const overlayHtmlItems = htmlItems
  const imageBatchImportDisplay = React.useMemo(
    () =>
      imageBatchImportProgress
        ? resolveImageBatchImportDisplay(imageBatchImportProgress)
        : { percent: 0, displayCount: 0 },
    [imageBatchImportProgress]
  )
  const imageBatchImportPercent = imageBatchImportDisplay.percent
  const imageBatchImportDisplayCount = imageBatchImportDisplay.displayCount
  const imageBatchImportLabel = imageBatchImportProgress
    ? isChineseUi
      ? `正在导入图片 ${imageBatchImportDisplayCount}/${imageBatchImportProgress.total}`
      : `Importing images ${imageBatchImportDisplayCount}/${imageBatchImportProgress.total}`
    : ''
  const imageBatchImportFailedLabel =
    imageBatchImportProgress?.failed > 0
      ? isChineseUi
        ? `失败 ${imageBatchImportProgress.failed}`
        : `${imageBatchImportProgress.failed} failed`
      : null

  return (
    <Box
      sx={{
        position: 'relative',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: 'background.default',
        minHeight: 0
      }}
      onDragEnterCapture={handleDragOver}
      onDragOverCapture={handleDragOver}
      onDropCapture={handleDrop}
    >
      <ProjectCanvasPageTopToolbar {...toolbarProps} />
      {imageBatchImportProgress ? (
        <Box
          data-testid="canvas-image-batch-import-progress"
          sx={{
            position: 'absolute',
            top: 52,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 80,
            width: 'min(420px, calc(100% - 160px))',
            minWidth: 260,
            px: 1.5,
            py: 1,
            borderRadius: 2,
            border: `1px solid ${muiAlpha(theme.palette.divider, 0.45)}`,
            bgcolor: muiAlpha(theme.palette.background.paper, 0.92),
            boxShadow: theme.shadows[8],
            pointerEvents: 'none'
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 0.75 }}>
            <Typography
              variant="caption"
              sx={{ flex: 1, minWidth: 0, color: 'text.primary', fontWeight: 700 }}
              noWrap
            >
              {imageBatchImportLabel}
            </Typography>
            {imageBatchImportFailedLabel ? (
              <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 700 }}>
                {imageBatchImportFailedLabel}
              </Typography>
            ) : null}
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
              {imageBatchImportPercent}%
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={imageBatchImportPercent}
            sx={{
              height: 6,
              borderRadius: 999,
              bgcolor: muiAlpha(theme.palette.primary.main, 0.16)
            }}
          />
        </Box>
      ) : null}
      <MemoizedProjectCanvasPageStageScene
        {...stageSceneProps}
        isViewportInteracting={isViewportInteracting}
        onLiveMultiSelectionBoundsChange={setLiveMultiSelectionBounds}
        setCanvasContainerElement={setCanvasContainerElement}
      />

      <ProjectCanvasPageOverlayDialogAssembly
        suspendViewportChrome={false}
        selectionOverlaysProps={{
          tool,
          selectionOverlayGroups,
          exactSelectedGroup,
          liveMultiSelectionBounds,
          stagePos,
          stagePosRef,
          stageScale,
          stageScaleRef,
          stageSize,
          selectedIds,
          items,
          stageRef,
          canvasContainerRef,
          canvasContainerElement,
          registerViewportCallback,
          registerViewportInteractionCallback,
          lastClickedId: lastClickedIdRef.current,
          mediaCaptionActionLabel,
          legacySelectionToolbarEnabled: isLegacySelectionToolbarEnabled(),
          suppressSelectionChrome: Boolean(suppressSelectionChromeAfterMarquee),
          groupCreateLabel: t('canvas.group_create_button'),
          handleFocusGroup,
          buildCanvasDragPayload,
          setCanvasDragPayload,
          handleFlipImage,
          handleCropImage,
          handleExtractImage,
          handleCopyCanvasImage,
          handleDownloadCanvasImage,
          handleOpenAgentSendMenu,
          handleOpenMediaCaptionEditor,
          handleSendCanvasItemsToAgent,
          handleToggleVideoPlayback,
          resolvedVideoBudgetModeById,
          handleOpenModel3DViewer,
          handleOpenDccExportMenu,
          handleDownloadBlobItem,
          handleExportCanvasFile,
          handleCopyCanvasItemsAsImage,
          handleDownloadCanvasItemsAsImage,
          getQuickCanvasItemsImageUrl,
          prepareQuickCanvasItemsImageUrl,
          handleGenerateCanvasItems,
          handleCreateGroup,
          fileExportActionLabel: isChineseUi ? '导出文件' : 'Export file',
          Model3DIcon,
          ExportIcon: DccExportIcon
        }}
        visualOverlaysProps={{
          canvasContainerRef,
          canvasContainerElement,
          sessionKey: canvasAgentSessionKey,
          renderedModel3DItems: overlayRenderedModel3DItems,
          videoItems: overlayVideoItems,
          htmlItems: overlayHtmlItems,
          annotationItems: visibleOverlayItems.annotationItems,
          textItems: visibleOverlayItems.textItems,
          fileItems: visibleOverlayItems.fileItems,
          items,
          editingTextItemId: inlineTextEdit?.id ?? null,
          activeOcrHover,
          selectedIds,
          tool,
          stagePos,
          stageScale,
          stageSize,
          itemsLength: items.length,
          isViewportInteracting,
          forceRenderAllItemsForExport,
          onSelectItem: (itemId) => setSelectedIds(new Set([itemId])),
          onDragOver: handleDragOver,
          onDrop: handleDrop,
          onDragVideoEnd: handleDragEnd,
          onUpdateVideoItem: handleUpdateVideoItem,
          onVideoContextMenu: handleImageContextMenu,
          onUpdateHtmlItem: handleUpdateHtmlItem,
          onDeleteHtmlItem: handleDeleteHtmlItem,
          groupPlaybackInfo: groupPlayback
            ? {
                currentIndex: groupPlayback.currentIndex,
                totalCount: groupPlayback.itemIds.length,
                paused: groupPlayback.paused
              }
            : null,
          activeGroupPlaybackItem,
          activeGroupPlaybackCanvasBounds,
          activeGroupPlaybackScreenBounds,
          activeGroupPlaybackGroupName: activeGroupPlaybackGroup?.name ?? null,
          onToggleGroupPlaybackPause: () => {
            if (!groupPlayback) return
            groupPlayback.paused ? resumeGroupPlayback() : pauseGroupPlayback()
          },
          onStopGroupPlayback: stopGroupPlayback,
          onGroupPlaybackVideoEnded: handleGroupPlaybackVideoEnded,
          onExportGroupPlaybackAsGif: handleExportGroupPlaybackAsGif,
          registerViewportLayer,
          registerViewportCallback
        }}
        inlineTextEditorProps={{
          canvasContainerRef,
          canvasContainerElement,
          inlineTextEdit,
          setInlineTextEdit,
          inlineTextAreaRef,
          mediaCaptionPlaceholder,
          stageScale,
          stagePos,
          annotationColor,
          items,
          nextZIndexRef: nextZIndex,
          setItemsWithHistory,
          setSelectedIds,
          setTool
        }}
        hiddenInputsProps={{
          fileInputRef,
          modelInputRef,
          videoInputRef,
          allAccept: CANVAS_IMPORT_ACCEPT,
          modelImportExtensions: MODEL_IMPORT_EXTENSIONS,
          onFileSelect: handleFileSelect,
          onModelSelect: handleModelSelect,
          onVideoSelect: handleVideoSelect
        }}
        shortcutDialogProps={{
          open: shortcutDialogOpen,
          currentShortcut,
          recordedShortcut,
          onRecordedShortcutChange: setRecordedShortcut,
          onClose: () => setShortcutDialogOpen(false),
          onSave: async () => {
            if (!recordedShortcut) return

            if (conflictsWithCanvasShortcut(recordedShortcut, toolShortcuts)) {
              notifyError(`截图快捷键 ${recordedShortcut} 与画布快捷键冲突，请换一个组合键。`)
              return
            }

            const invoke = window.electron?.ipcRenderer?.invoke
            if (!invoke) {
              notifyError('当前环境不支持修改截图快捷键。')
              return
            }

            try {
              const result = await invoke(
                'screenshot:setShortcut',
                toElectronAccelerator(recordedShortcut),
                buildReservedCanvasShortcuts(toolShortcuts)
              )

              if (result?.success === false) {
                notifyError(result.error || '截图快捷键设置失败。')
                return
              }

              setCurrentShortcut(recordedShortcut)
              setRecordedShortcut('')
              setShortcutDialogOpen(false)
            } catch (err) {
              console.error('[Canvas] Failed to update screenshot shortcut.', err)
              notifyError('截图快捷键设置失败。')
            }
          }
        }}
        canvasTargetDialogProps={{
          open: canvasTargetDialogOpen,
          isChineseUi,
          loading: canvasTargetLoading,
          error: canvasTargetError,
          schemes: targetSchemes,
          historyTargets: canvasTargetHistoryTargets,
          selectedHistoryTargetId: canvasTargetSelectedHistoryTargetId,
          traceDocuments: canvasTargetReferenceTraces,
          selectedTraceIds: canvasTargetSelectedTraceIds,
          evidenceMode: canvasTargetEvidenceMode,
          selectedSchemeId: canvasTargetSelectedSchemeId,
          targetItemCount: canvasTargetTargetItemCount,
          targetName: canvasTargetTargetName,
          userIntent: canvasTargetUserIntent,
          controlProfileId: canvasTargetControlProfileId,
          stageProfiles: canvasTargetStageProfiles,
          quickApps: canvasTargetQuickApps,
          profileOptions: canvasTargetStageProfileSelectOptions,
          controlProfileOptions: canvasTargetControlProfileSelectOptions,
          quickAppOptions: canvasTargetQuickAppOptions,
          report: canvasTargetReport,
          onTargetNameChange: setCanvasTargetTargetName,
          onSelectedSchemeIdChange: setCanvasTargetSelectedSchemeId,
          onUserIntentChange: setCanvasTargetUserIntent,
          onControlProfileIdChange: setCanvasTargetControlProfileId,
          onStageProfilesChange: setCanvasTargetStageProfiles,
          onQuickAppsChange: setCanvasTargetQuickApps,
          onApplyHistoryTarget: handleApplyCanvasTargetHistoryTarget,
          onDeleteHistoryTarget: (targetId) => {
            void handleDeleteCanvasTargetHistoryTarget(targetId)
          },
          onRenameHistoryTarget: (targetId, name) => {
            void handleRenameCanvasTargetHistoryTarget(targetId, name)
          },
          onSelectedTraceIdsChange: setCanvasTargetSelectedTraceIds,
          onEvidenceModeChange: setCanvasTargetEvidenceMode,
          onOpenSchemeManager: openTargetManager,
          onRun: () => void handleRunCanvasTarget(),
          onCancelRun: handleCancelCanvasTarget,
          onClose: handleCloseCanvasTargetDialog
        }}
        figmaBindingDialogProps={{
          open: figmaBindingDialogOpen,
          accessTokenConfigured: Boolean(figmaAccessToken),
          busyAction: figmaBusyAction,
          error: figmaBindingError,
          fileKeyOrUrl: figmaFileKeyOrUrlInput,
          binding: figmaDialogBinding,
          globalAutoCheckEnabled: figmaGlobalAutoCheckEnabled,
          globalAutoCheckIntervalMinutes: figmaAutoCheckIntervalMinutes,
          onFileKeyOrUrlChange: setFigmaFileKeyOrUrlInput,
          onPageNodeIdChange: handleFigmaDraftPageChange,
          onAutoCheckUpdatesChange: handleFigmaDraftAutoCheckUpdatesChange,
          onResolve: () => void handleResolveFigmaBinding(),
          onBind: handleSaveFigmaBinding,
          onSync: () => void handleSyncFigmaBinding(),
          onCheck: () => void handleCheckFigmaUpdate(),
          onUnbind: handleUnbindFigmaBinding,
          onClose: handleCloseFigmaBindingDialog
        }}
        dialogsProps={{
          dccExportMenuAnchor,
          dccExportMenuItemId,
          onCloseDccExportMenu: handleCloseDccExportMenu,
          onSelectDccExportTarget: handleSelectDccExportTarget,
          agentSendMenuAnchor,
          agentSendMenuItemIds,
          onCloseAgentSendMenu: handleCloseAgentSendMenu,
          onSelectAgentTargetApp: handleSelectAgentTargetApp,
          generationTaskPackDialogProps: {
            open: generationTaskDialogOpen,
            taskPack: generationTaskPack,
            onClose: handleCloseGenerationTaskDialog,
            onConfirm: handleConfirmGenerationTaskPackWithTraceRefresh
          },
          generationTraceHistoryDialogProps: {
            open: generationTraceHistoryDialogOpen,
            records: generationTraceRecentRecords,
            onContinueRecord: (record) => {
              void handleContinueGenerationTraceRecord(record)
            },
            onApproveRecord: (record) => handleUpdateGenerationTraceDecision(record, 'approved'),
            onDiscardRecord: (record) => handleUpdateGenerationTraceDecision(record, 'discarded'),
            onDeleteRecord: handleDeleteGenerationTraceHistoryRecord,
            onClose: handleCloseGenerationTraceHistory
          },
          filePreviewDialogProps: {
            open: Boolean(activeFileDialogItem),
            item: activeFileDialogItem,
            draftContent: fileDialogDraftContent,
            draftSheets: fileDialogDraftSheets,
            activeOcrHover,
            onDraftChange: setFileDialogDraftContent,
            onDraftSheetsChange: setFileDialogDraftSheets,
            onClose: handleCloseFileDialog,
            onSave: handleSaveFileDialog,
            onExport: (item, format) => {
              void handleExportCanvasFile(item, format)
            }
          },
          clearConfirmDialogProps: {
            open: clearConfirmOpen,
            onClose: closeClearConfirmDialog,
            onConfirm: handleConfirmClearDialog
          },
          model3DViewerDialogProps: {
            open: Boolean(activeModel3DItem),
            item: activeModel3DItem,
            sessionKey: canvasAgentSessionKey,
            bgColor,
            transparentPattern,
            onClose: handleCloseModel3DViewer,
            onDownload: (item) => handleDownloadBlobItem(item),
            onImportTextures: handleRequestModel3DTextureImport
          },
          textureImportDialogProps: {
            open: textureImportDialogOpen,
            onClose: handleCloseTextureImportDialog,
            onSkip: handleSkipTextureImportDialog,
            onImport: handleOpenTextureImportInput
          },
          textureInputRef,
          onTextureFilesSelected: handleTextureFilesSelected,
          labelEditorDialogProps: {
            open: labelDialogOpen,
            text: labelDialogText,
            onTextChange: (text) => setLabelDialogText(text),
            onClose: () => setLabelDialogOpen(false),
            onConfirm: handleConfirmLabelDialog
          },
          imageContextMenu,
          contextMenuTarget,
          onCloseImageContextMenu: handleCloseImageContextMenu,
          onBringToFront: handleBringToFront,
          onSendToBack: handleSendToBack,
          onBringForward: handleBringForward,
          onSendBackward: handleSendBackward,
          onOpenTextureImportFromContextMenu: handleOpenTextureImportFromContextMenu
        }}
        colorPopoversProps={{
          legacyAnnotationPaletteOpen: Boolean(colorPickerAnchor) && selectedIds.size < 0,
          annotationWheelOpen: Boolean(colorPickerAnchor),
          legacyBackgroundPaletteOpen: Boolean(bgColorPickerAnchor) && items.length < 0,
          backgroundWheelOpen: Boolean(bgColorPickerAnchor),
          colorPickerAnchor,
          bgColorPickerAnchor,
          brushWidthAnchor,
          annotationColor,
          annotationStrokeWidth,
          bgColor,
          onCloseColorPicker: () => setColorPickerAnchor(null),
          onCloseBackgroundColorPicker: () => setBgColorPickerAnchor(null),
          onCloseBrushWidthPicker: () => setBrushWidthAnchor(null),
          onSelectAnnotationColor: (color) => {
            setAnnotationColor(color)
            setInlineTextEdit((prev) => (prev ? { ...prev, fill: color } : null))
            if (selectedIds.size > 0) {
              setItemsWithHistory(
                (prev) =>
                  prev.map((item) => {
                    if (!selectedIds.has(item.id)) return item
                    if (item.type === 'annotation') return { ...item, stroke: color }
                    if (item.type === 'text') return { ...item, fill: color }
                    return item
                  }) as CanvasItem[]
              )
            }
          },
          onUseEyeDropper: async () => {
            if (!(window as any).EyeDropper) {
              notifyError(
                isChineseUi
                  ? '\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u7cfb\u7edf\u53d6\u8272\u5668\u3002'
                  : 'The system eye dropper is not supported in this environment.'
              )
              return
            }
            try {
              const eyeDropper = new (window as any).EyeDropper()
              const result = await eyeDropper.open()
              const color = result.sRGBHex
              setBgCustomColor(color)
              setAnnotationColor(color)
              setInlineTextEdit((prev) => (prev ? { ...prev, fill: color } : null))
              if (selectedIds.size > 0) {
                setItemsWithHistory(
                  (prev) =>
                    prev.map((item) => {
                      if (!selectedIds.has(item.id)) return item
                      if (item.type === 'annotation') return { ...item, stroke: color }
                      if (item.type === 'text') return { ...item, fill: color }
                      return item
                    }) as CanvasItem[]
                )
              }
            } catch {
              // The native eye dropper throws when the user cancels.
            }
          },
          onSelectAnnotationStrokeWidth: (size) => setAnnotationStrokeWidth(size),
          onDraftBackgroundCustomColor: (color) => setBgCustomColor(color),
          onSelectBackgroundColor: (color) => {
            setBgCustomColor(color)
            handleBgColorChange(color)
          }
        }}
      />
    </Box>
  )
}
