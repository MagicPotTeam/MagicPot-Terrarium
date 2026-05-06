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
  Slider
} from '@mui/material'
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
  FormatBold as FormatBoldIcon,
  LocalOfferOutlined as LocalOfferOutlinedIcon
} from '@mui/icons-material'
import {
  DatabaseIconSVG,
  DocumentIconSVG,
  DoubleLineRectIconSVG,
  ParallelogramIconSVG,
  RhombusIconSVG,
  RoundedRectIconSVG
} from './projectCanvasPageShared'
import ProjectCanvasGroupTreePopover from './ProjectCanvasGroupTreePopover'
import ProjectCanvasPageExportMenus from './ProjectCanvasPageExportMenus'
import { getCanvasItemFocusBounds, type CanvasFocusBounds } from './canvasFitBoundsUtils'
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

const noop = () => {}

type CanvasViewportPoint = {
  x: number
  y: number
}

type CanvasViewportSize = {
  width: number
  height: number
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function getCanvasFocusBoundsCenter(bounds: CanvasFocusBounds): CanvasViewportPoint | null {
  const x = (bounds.minX + bounds.maxX) / 2
  const y = (bounds.minY + bounds.maxY) / 2

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  return { x, y }
}

function resolveZoomResetAnchor(options: {
  items: CanvasItem[]
  selectedIds: Set<string>
  stagePos: CanvasViewportPoint
  stageScale: number
  stageSize: CanvasViewportSize
}): CanvasViewportPoint | null {
  const { items, selectedIds, stagePos, stageScale, stageSize } = options
  const selectedItems = selectedIds.size > 0 ? items.filter((item) => selectedIds.has(item.id)) : []
  const candidateItems = selectedItems.length > 0 ? selectedItems : items

  if (candidateItems.length === 0) {
    return null
  }

  const safeScale =
    typeof stageScale === 'number' && Number.isFinite(stageScale) && stageScale !== 0
      ? stageScale
      : 1
  const stageCenter = {
    x: getFiniteNumber(stageSize.width, 0) / 2,
    y: getFiniteNumber(stageSize.height, 0) / 2
  }
  const viewportCenter = {
    x: (stageCenter.x - getFiniteNumber(stagePos.x, 0)) / safeScale,
    y: (stageCenter.y - getFiniteNumber(stagePos.y, 0)) / safeScale
  }
  let best: {
    anchor: CanvasViewportPoint
    distance: number
    zIndex: number
  } | null = null

  for (const item of candidateItems) {
    const anchor = getCanvasFocusBoundsCenter(getCanvasItemFocusBounds(item))

    if (!anchor) continue

    const dx = anchor.x - viewportCenter.x
    const dy = anchor.y - viewportCenter.y
    const distance = dx * dx + dy * dy
    const zIndex = getFiniteNumber(item.zIndex, 0)

    if (!best || distance < best.distance || (distance === best.distance && zIndex > best.zIndex)) {
      best = { anchor, distance, zIndex }
    }
  }

  return best?.anchor ?? null
}

function ProjectCanvasPageTopToolbar(props: any) {
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
    canvasTargetControlProfileId,
    canvasTargetDialogOpen,
    canvasTargetError,
    canvasTargetLoading,
    canvasTargetProfileSelectOptions,
    canvasTargetReport,
    canvasTargetSelectedSchemeId,
    canvasTargetStageProfiles,
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
    figmaAccessToken,
    figmaAutoCheckIntervalMinutes,
    figmaBindingDialogOpen,
    figmaBindingError,
    figmaBusyAction,
    figmaDialogBinding,
    figmaFileKeyOrUrlInput,
    figmaGlobalAutoCheckEnabled,
    fileDialogDraftContent,
    fileInputRef,
    generationTaskDialogOpen,
    generationTaskPack,
    generationTraceHistoryDialogOpen,
    generationTraceRecentRecords,
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
    handleExportCanvasProjectFile,
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
    handleRunCanvasTarget,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleSaveCanvasAsFromContextMenu,
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
    inlineTextAreaRef,
    inlineTextEdit,
    isChineseUi,
    isFillableAnnotationShape,
    isLegacySelectionToolbarEnabled,
    isLightCanvasTheme,
    isMiddleMouseRef,
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
    setCanvasTargetSelectedSchemeId,
    setCanvasTargetStageProfiles,
    setCanvasTargetUserIntent,
    setCanvasDragPayload,
    setColorPickerAnchor,
    setCroppingImageId,
    setCurrentShortcut,
    setFigmaFileKeyOrUrlInput,
    setFileDialogDraftContent,
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
  const groupTreePopoverProps = {
    groupBranches: Array.isArray(props.groupBranches) ? props.groupBranches : [],
    handleCreateGroupBranch:
      typeof props.handleCreateGroupBranch === 'function' ? props.handleCreateGroupBranch : noop,
    handleDeleteGroupBranch:
      typeof props.handleDeleteGroupBranch === 'function' ? props.handleDeleteGroupBranch : noop,
    handleFocusGroupBranch:
      typeof props.handleFocusGroupBranch === 'function' ? props.handleFocusGroupBranch : noop,
    handleMoveGroupToBranch:
      typeof props.handleMoveGroupToBranch === 'function' ? props.handleMoveGroupToBranch : noop,
    handleRenameGroup:
      typeof props.handleRenameGroup === 'function' ? props.handleRenameGroup : noop,
    handleRenameGroupBranch:
      typeof props.handleRenameGroupBranch === 'function' ? props.handleRenameGroupBranch : noop
  }
  const groupPlaybackStartLabel = isChineseUi ? '播放' : 'Play'
  const groupPlaybackPauseLabel = isChineseUi ? '暂停' : 'Pause'
  const groupPlaybackResumeLabel = isChineseUi ? '继续' : 'Resume'
  const startGroupPlaybackTooltip = isChineseUi ? '开始播放' : 'Start playback'
  const pauseGroupPlaybackTooltip = isChineseUi ? '暂停播放' : 'Pause playback'
  const resumeGroupPlaybackTooltip = isChineseUi ? '继续播放' : 'Resume playback'
  const stopGroupPlaybackTooltip = isChineseUi ? '停止播放' : 'Stop playback'
  const resetZoomToCanvasContentAnchor = React.useCallback(() => {
    if (!stageSize) {
      setStageScaleAroundViewportCenter(1)
      return
    }

    const anchor = resolveZoomResetAnchor({
      items: Array.isArray(items) ? items : [],
      selectedIds: selectedIds instanceof Set ? selectedIds : new Set<string>(),
      stagePos: {
        x: getFiniteNumber(stagePos?.x, 0),
        y: getFiniteNumber(stagePos?.y, 0)
      },
      stageScale,
      stageSize: {
        width: getFiniteNumber(stageSize.width, 0),
        height: getFiniteNumber(stageSize.height, 0)
      }
    })

    if (!anchor) {
      setStageScaleAroundViewportCenter(1)
      return
    }

    setStageScale(1)
    setStagePos({
      x: stageSize.width / 2 - anchor.x,
      y: stageSize.height / 2 - anchor.y
    })
  }, [
    items,
    selectedIds,
    setStagePos,
    setStageScale,
    setStageScaleAroundViewportCenter,
    stagePos?.x,
    stagePos?.y,
    stageScale,
    stageSize
  ])
  return (
    <Box
      sx={(theme) => ({
        display: 'flex',
        position: 'relative',
        zIndex: 1,
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 0.5,
        px: 1.5,
        py: 0.75,
        minHeight: 48,
        borderBottom: `1px solid ${theme.palette.divider} `,
        backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.paper : '#eaecf5',
        flexShrink: 0,
        userSelect: 'none',
        '& .MuiIconButton-root': {
          width: 34,
          height: 34
        },
        '& .MuiSvgIcon-root': {
          fontSize: 20
        },
        '& .MuiChip-root': {
          minHeight: 30,
          height: 30
        },
        '& .MuiChip-label': {
          fontSize: 12,
          fontWeight: 700,
          px: 1.25
        }
      })}
    >
      <Tooltip title={t('canvas.tool_import')}>
        <IconButton size="small" onClick={handleToolbarImportClick}>
          <ImportIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Tooltip title={`${t('canvas.tool_select')} (${toolShortcuts.select})`}>
        <IconButton
          size="small"
          onClick={() => setTool('select')}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'select' })
          }}
          color={tool === 'select' ? 'primary' : 'default'}
          sx={{ borderRadius: 1 }}
        >
          <SelectIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={`${t('canvas.tool_hand')} (${toolShortcuts.hand})`}>
        <IconButton
          size="small"
          onClick={() => setTool('hand')}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'hand' })
          }}
          color={tool === 'hand' ? 'primary' : 'default'}
          sx={{ borderRadius: 1 }}
        >
          <HandIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Tooltip
        title={`${
          annoTool === 'ellipse'
            ? t('canvas.shape_ellipse')
            : annoTool === 'rect'
              ? t('canvas.shape_rect')
              : annoTool === 'rhombus'
                ? t('canvas.shape_rhombus')
                : annoTool === 'parallelogram'
                  ? t('canvas.shape_parallelogram')
                  : annoTool === 'double-line-rect'
                    ? t('canvas.shape_double_line_rect')
                    : annoTool === 'circle'
                      ? t('canvas.shape_circle')
                      : annoTool === 'document'
                        ? t('canvas.shape_document')
                        : annoTool === 'cylinder'
                          ? t('canvas.shape_cylinder')
                          : annoTool === 'rounded-rect'
                            ? t('canvas.shape_rounded_rect')
                            : t('canvas.shape_rect')
        } (${toolShortcuts.rect})`}
      >
        <IconButton
          size="small"
          onClick={(e) => setShapePickerAnchor(e.currentTarget)}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'rect' })
          }}
          color={
            tool === 'annotate' &&
            [
              'rect',
              'ellipse',
              'circle',
              'rhombus',
              'parallelogram',
              'double-line-rect',
              'document',
              'cylinder',
              'rounded-rect'
            ].includes(annoTool)
              ? 'primary'
              : 'default'
          }
          sx={{ borderRadius: 1 }}
        >
          {(() => {
            if (annoTool === 'ellipse') return <EllipseIcon fontSize="small" />
            if (annoTool === 'circle') return <EllipseIcon fontSize="small" /> // logic difference internally
            if (annoTool === 'rhombus') return <RhombusIconSVG fontSize="small" />
            if (annoTool === 'parallelogram') return <ParallelogramIconSVG fontSize="small" />
            if (annoTool === 'double-line-rect') return <DoubleLineRectIconSVG fontSize="small" />
            if (annoTool === 'document') return <DocumentIconSVG fontSize="small" />
            if (annoTool === 'cylinder') return <DatabaseIconSVG fontSize="small" />
            if (annoTool === 'rounded-rect') return <RoundedRectIconSVG fontSize="small" />
            return <RectIcon fontSize="small" />
          })()}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={shapePickerAnchor}
        open={Boolean(shapePickerAnchor)}
        onClose={() => setShapePickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{ '& .MuiPaper-root': { mt: 1, borderRadius: 2 } }}
      >
        {[
          {
            shape: 'ellipse',
            label: t('canvas.shape_ellipse'),
            icon: <EllipseIcon fontSize="small" />
          },
          { shape: 'rect', label: t('canvas.shape_rect'), icon: <RectIcon fontSize="small" /> },
          {
            shape: 'rhombus',
            label: t('canvas.shape_rhombus'),
            icon: <RhombusIconSVG fontSize="small" />
          },
          {
            shape: 'parallelogram',
            label: t('canvas.shape_parallelogram'),
            icon: <ParallelogramIconSVG fontSize="small" />
          },
          {
            shape: 'double-line-rect',
            label: t('canvas.shape_double_line_rect'),
            icon: <DoubleLineRectIconSVG fontSize="small" />
          },
          {
            shape: 'circle',
            label: t('canvas.shape_circle'),
            icon: <EllipseIcon fontSize="small" />
          },
          {
            shape: 'document',
            label: t('canvas.shape_document'),
            icon: <DocumentIconSVG fontSize="small" />
          },
          {
            shape: 'cylinder',
            label: t('canvas.shape_cylinder'),
            icon: <DatabaseIconSVG fontSize="small" />
          },
          {
            shape: 'rounded-rect',
            label: t('canvas.shape_rounded_rect'),
            icon: <RoundedRectIconSVG fontSize="small" />
          }
        ].map((item) => (
          <MenuItem
            key={item.shape}
            selected={tool === 'annotate' && annoTool === item.shape}
            onClick={() => {
              setTool('annotate')
              setAnnoTool(item.shape as AnnotationShape)
              setShapePickerAnchor(null)
            }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText>{item.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>

      <Tooltip
        title={`${annoTool === 'line' ? t('canvas.shape_line') : t('canvas.shape_arrow')} (${toolShortcuts.arrow})`}
      >
        <IconButton
          size="small"
          onClick={(e) => setLinePickerAnchor(e.currentTarget)}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'arrow' })
          }}
          color={
            tool === 'annotate' && (annoTool === 'arrow' || annoTool === 'line')
              ? 'primary'
              : 'default'
          }
          sx={{ borderRadius: 1 }}
        >
          {annoTool === 'line' ? (
            <LineIcon fontSize="small" sx={{ transform: 'rotate(-45deg)' }} />
          ) : (
            <ArrowIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={linePickerAnchor}
        open={Boolean(linePickerAnchor)}
        onClose={() => setLinePickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{ '& .MuiPaper-root': { mt: 1, borderRadius: 2 } }}
      >
        <MenuItem
          selected={tool === 'annotate' && annoTool === 'arrow'}
          onClick={() => {
            setTool('annotate')
            setAnnoTool('arrow')
            setLinePickerAnchor(null)
          }}
        >
          <ListItemIcon>
            <ArrowIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('canvas.shape_arrow')}</ListItemText>
        </MenuItem>
        <MenuItem
          selected={tool === 'annotate' && annoTool === 'line'}
          onClick={() => {
            setTool('annotate')
            setAnnoTool('line')
            setLinePickerAnchor(null)
          }}
        >
          <ListItemIcon>
            <LineIcon fontSize="small" sx={{ transform: 'rotate(-45deg)' }} />
          </ListItemIcon>
          <ListItemText>{t('canvas.shape_line')}</ListItemText>
        </MenuItem>
      </Menu>

      <Tooltip title={t('canvas.tool_freedraw') + ` (${toolShortcuts.freedraw})`}>
        <IconButton
          size="small"
          onClick={() => {
            if (tool === 'annotate' && annoTool === 'freedraw') {
              setTool('select')
            } else {
              setTool('annotate')
              setAnnoTool('freedraw')
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'freedraw' })
          }}
          color={tool === 'annotate' && annoTool === 'freedraw' ? 'primary' : 'default'}
          sx={{ borderRadius: 1 }}
        >
          <BrushIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={`${t('canvas.tool_text')} (${toolShortcuts.text})`}>
        <IconButton
          size="small"
          onClick={() => {
            if (tool === 'annotate' && annoTool === 'text-anno') {
              setTool('select')
            } else {
              setTool('annotate')
              setAnnoTool('text-anno')
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setToolShortcutRecorded('')
            setToolShortcutCtxMenu({ x: e.clientX, y: e.clientY, toolKey: 'text' })
          }}
          color={tool === 'annotate' && annoTool === 'text-anno' ? 'primary' : 'default'}
          sx={{ borderRadius: 1 }}
        >
          <TextAnnoIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          ml: 0.75,
          mr: 0.25,
          px: 0.75,
          py: 0.25,
          height: 38,
          boxSizing: 'border-box',
          borderRadius: 2.5,
          border: '1px solid',
          borderColor: annotationToolbarBorderColor,
          bgcolor: annotationToolbarSurface,
          boxShadow: annotationToolbarShadow,
          backdropFilter: 'blur(12px)',
          flexShrink: 0,
          overflow: 'hidden'
        }}
      >
        {showAnnotationFillToggle && (
          <Tooltip
            title={
              isChineseUi
                ? annotationFillEnabled
                  ? '切换为仅描边'
                  : '切换为填充'
                : annotationFillEnabled
                  ? 'Disable fill'
                  : 'Enable fill'
            }
          >
            <Box
              onClick={handleToggleAnnotationFillMode}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 42,
                height: 28,
                px: 1.2,
                borderRadius: 999,
                border: '1px solid',
                borderColor: annotationFillEnabled
                  ? alpha(annotationColor, 0.52)
                  : annotationToolbarBorderColor,
                bgcolor: annotationFillEnabled
                  ? alpha(annotationColor, 0.18)
                  : annotationToolbarIdleSurface,
                color: annotationFillEnabled ? annotationColor : annotationToolbarStrongText,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '0.02em',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'transform 120ms ease, background-color 120ms ease',
                '&:hover': {
                  transform: 'translateY(-1px)',
                  bgcolor: annotationFillEnabled
                    ? alpha(annotationColor, 0.24)
                    : annotationToolbarHoverSurface
                }
              }}
            >
              {isChineseUi
                ? annotationFillEnabled
                  ? '填充'
                  : '描边'
                : annotationFillEnabled
                  ? 'Fill'
                  : 'Outline'}
            </Box>
          </Tooltip>
        )}

        {showAnnotationFillToggle && (
          <Divider
            orientation="vertical"
            flexItem
            sx={{ my: 0.5, borderColor: annotationToolbarBorderColor }}
          />
        )}

        {showAnnotationStrokeControl &&
          (() => {
            const isTextMode =
              (tool === 'annotate' && annoTool === 'text-anno') || hasSelectedTextItem
            const currentValue = annotationStrokeWidth
            const minVal = 1
            const maxVal = 20
            const tooltipTitle = isTextMode
              ? t('canvas.size_font', { val: currentValue })
              : t('canvas.size_stroke', { val: currentValue })

            if (isTextMode) {
              const anySelectedTextNodes = items.filter(
                (i) =>
                  selectedIds.has(i.id) &&
                  (i.type === 'text' || (i.type === 'annotation' && i.shape === 'text-anno'))
              )
              const isAnySelectedBold = anySelectedTextNodes.some(
                (i) => (i as CanvasTextItem | CanvasAnnotationItem).fontWeight === 'bold'
              )

              return (
                <Tooltip title="Toggle bold" placement="bottom">
                  <IconButton
                    size="small"
                    sx={{
                      color: isAnySelectedBold
                        ? theme.palette.primary.main
                        : annotationToolbarStrongText,
                      bgcolor: isAnySelectedBold
                        ? alpha(theme.palette.primary.main, 0.16)
                        : 'transparent',
                      '&:hover': {
                        color: isLightCanvasTheme ? theme.palette.text.primary : '#fff',
                        bgcolor: annotationToolbarHoverSurface
                      }
                    }}
                    onPointerDownCapture={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (selectedIds.size > 0) {
                        setItemsWithHistory(
                          (prev) =>
                            prev.map((item) => {
                              if (!selectedIds.has(item.id)) return item
                              if (
                                item.type === 'text' ||
                                (item.type === 'annotation' && item.shape === 'text-anno')
                              ) {
                                return {
                                  ...item,
                                  fontWeight: isAnySelectedBold ? 'normal' : 'bold'
                                }
                              }
                              return item
                            }) as CanvasItem[]
                        )
                      }
                    }}
                  >
                    <FormatBoldIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )
            }

            return (
              <Tooltip title={tooltipTitle} placement="bottom">
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 0.5,
                    minWidth: 132
                  }}
                  onPointerDownCapture={(e) => e.stopPropagation()}
                >
                  <Typography
                    component="span"
                    sx={{
                      minWidth: 16,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textAlign: 'center',
                      color: annotationToolbarMutedText
                    }}
                  >
                    {isChineseUi ? '\u5bbd' : 'W'}
                  </Typography>
                  <Slider
                    value={currentValue}
                    onChange={(_, v) => {
                      const val = v as number
                      setAnnotationStrokeWidth(val)
                      if (selectedIds.size > 0) {
                        setItemsWithHistory(
                          (prev) =>
                            prev.map((item) => {
                              if (!selectedIds.has(item.id)) return item
                              if (item.type === 'annotation') {
                                return { ...item, strokeWidth: val }
                              }
                              return item
                            }) as CanvasItem[]
                        )
                      }
                    }}
                    min={minVal}
                    max={maxVal}
                    step={1}
                    size="small"
                    sx={{
                      width: 74,
                      color: annotationColor,
                      py: 0,
                      '& .MuiSlider-track, & .MuiSlider-rail': {
                        height: 4,
                        borderRadius: 999
                      },
                      '& .MuiSlider-thumb': {
                        width: 10,
                        height: 10,
                        bgcolor: annotationColor,
                        boxShadow: isLightCanvasTheme
                          ? '0 0 0 2px rgba(255,255,255,0.92), 0 1px 4px rgba(15,23,42,0.18)'
                          : '0 0 0 2px rgba(12,12,15,0.72)',
                        '&:hover, &.Mui-focusVisible': {
                          boxShadow: `0 0 0 5px ${alpha(annotationColor, 0.26)}`
                        }
                      },
                      '& .MuiSlider-track': { bgcolor: annotationColor },
                      '& .MuiSlider-rail': {
                        opacity: 1,
                        bgcolor: isLightCanvasTheme
                          ? alpha(theme.palette.text.primary, 0.14)
                          : alpha(theme.palette.common.white, 0.14)
                      }
                    }}
                  />
                  <Box
                    sx={{
                      minWidth: 24,
                      height: 20,
                      px: 0.75,
                      borderRadius: 999,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: alpha(annotationColor, 0.16),
                      color: annotationColor,
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: 1
                    }}
                  >
                    {currentValue}
                  </Box>
                </Box>
              </Tooltip>
            )
          })()}

        {(showAnnotationFillToggle || showAnnotationStrokeControl) && (
          <Divider
            orientation="vertical"
            flexItem
            sx={{ my: 0.5, borderColor: annotationToolbarBorderColor }}
          />
        )}

        <Tooltip title={`${t('canvas.action_color_picker')} / ${t('canvas.action_bg_color')}`}>
          <Box
            sx={{
              position: 'relative',
              width: 28,
              height: 28,
              cursor: 'pointer',
              flexShrink: 0
            }}
            onPointerDownCapture={(e) => e.stopPropagation()}
          >
            {/* Background color square (behind, offset bottom-right) */}
            <Box
              onClick={(e) => setBgColorPickerAnchor(e.currentTarget)}
              sx={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 16,
                height: 16,
                borderRadius: '2px',
                border: '1.5px solid',
                borderColor: isLightCanvasTheme
                  ? alpha(theme.palette.common.black, 0.24)
                  : alpha(theme.palette.common.white, 0.72),
                bgcolor:
                  bgColor === 'transparent'
                    ? isLightCanvasTheme
                      ? alpha(theme.palette.common.black, 0.08)
                      : alpha(theme.palette.common.white, 0.08)
                    : bgColor,
                backgroundImage:
                  bgColor === 'transparent'
                    ? `linear-gradient(135deg, transparent 0 42%, ${
                        isLightCanvasTheme ? 'rgba(15,23,42,0.24)' : 'rgba(255,255,255,0.32)'
                      } 42% 58%, transparent 58% 100%)`
                    : 'none',
                boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
                cursor: 'pointer',
                transition: 'transform 120ms ease, box-shadow 120ms ease',
                '&:hover': {
                  transform: 'scale(1.08)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.28)'
                }
              }}
            />
            {/* Annotation color square (front, offset top-left) */}
            <Box
              onClick={(e) => setColorPickerAnchor(e.currentTarget)}
              sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 16,
                height: 16,
                borderRadius: '2px',
                border: '1.5px solid',
                borderColor: isLightCanvasTheme
                  ? alpha(theme.palette.common.black, 0.32)
                  : alpha(theme.palette.common.white, 0.88),
                bgcolor: annotationColor,
                boxShadow: '0 2px 6px rgba(0,0,0,0.22)',
                cursor: 'pointer',
                zIndex: 1,
                transition: 'transform 120ms ease, box-shadow 120ms ease',
                '&:hover': {
                  transform: 'scale(1.08)',
                  boxShadow: '0 3px 10px rgba(0,0,0,0.32)'
                }
              }}
            />
          </Box>
        </Tooltip>
      </Box>

      <Tooltip title={t('canvas.action_screenshot', { shortcut: currentShortcut })}>
        <IconButton
          size="small"
          onClick={() => {
            try {
              window.electron?.ipcRenderer?.invoke?.('screenshot:capture')
            } catch (err) {
              console.error('[Canvas] 启动系统截图失败', err)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setShortcutDialogOpen(true)
          }}
        >
          <ScreenshotIcon fontSize="small" sx={{ transform: 'rotate(270deg)' }} />
        </IconButton>
      </Tooltip>

      <Chip
        label={`${scalePercent}% `}
        size="small"
        variant="outlined"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const target = e.currentTarget
          target.setPointerCapture(e.pointerId)

          const startX = e.clientX
          const startScale = stageScale
          const startPos = { ...stagePos }
          let hasDragged = false

          const handleMove = (moveEv: PointerEvent) => {
            if (Math.abs(moveEv.clientX - startX) > 2) {
              hasDragged = true
            }
            if (!hasDragged) return

            const dx = moveEv.clientX - startX
            const zoomFactor = Math.pow(1.005, dx)
            let newScale = startScale * zoomFactor

            newScale = clampStageScale(newScale)

            if (stageSize) {
              const cx = (stageSize.width / 2 - startPos.x) / startScale
              const cy = (stageSize.height / 2 - startPos.y) / startScale

              setStageScale(newScale)
              setStagePos({
                x: stageSize.width / 2 - cx * newScale,
                y: stageSize.height / 2 - cy * newScale
              })
            } else {
              setStageScale(newScale)
            }
          }

          const handleUp = (upEv: PointerEvent) => {
            window.removeEventListener('pointermove', handleMove)
            window.removeEventListener('pointerup', handleUp)
            target.releasePointerCapture?.(upEv.pointerId)

            if (!hasDragged) {
              resetZoomToCanvasContentAnchor()
            }
          }

          window.addEventListener('pointermove', handleMove)
          window.addEventListener('pointerup', handleUp)
        }}
        sx={{
          minWidth: 48,
          cursor: 'zoom-in',
          fontWeight: 600,
          userSelect: 'none',
          touchAction: 'none'
        }}
      />
      <Tooltip title={t('canvas.action_fit_all')}>
        <IconButton size="small" onClick={handleFitAll}>
          <FitIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={isChineseUi ? '打开打标任务' : 'Open tagging job'}>
        <Chip
          icon={<LocalOfferOutlinedIcon sx={{ fontSize: '16px !important' }} />}
          label={isChineseUi ? '打标' : 'Tagging'}
          variant="outlined"
          onClick={() => {
            void props.handleOpenCanvasTaggingDialog?.()
          }}
          sx={{
            display: props.handleOpenCanvasTaggingDialog ? undefined : 'none',
            ml: 1,
            cursor: 'pointer',
            flexShrink: 0
          }}
        />
      </Tooltip>

      <Box sx={{ flex: 1 }} />

      <Tooltip title={countLabel} placement="bottom">
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            opacity: 0.5,
            fontSize: 11,
            mr: 1,
            maxWidth: 'clamp(72px, 16vw, 180px)',
            minWidth: 0,
            flexShrink: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'right'
          }}
        >
          <span id="live-bounds-display">{countLabel}</span>
        </Typography>
      </Tooltip>
      <Tooltip title={t('canvas.group_toolbar')}>
        <Chip
          icon={<LayersOutlinedIcon sx={{ fontSize: '16px !important' }} />}
          label={t('canvas.group_toolbar')}
          variant="outlined"
          onClick={(e) => handleOpenGroupMenu(e.currentTarget)}
          sx={{
            mr: 1,
            maxWidth: 140,
            cursor: 'pointer',
            flexShrink: 0,
            '& .MuiChip-label': {
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }
          }}
        />
      </Tooltip>
      <ProjectCanvasGroupTreePopover
        anchorEl={groupMenuAnchor}
        open={Boolean(groupMenuAnchor)}
        onClose={handleCloseGroupMenu}
        t={t}
        groupSummaries={groupSummaries}
        groupBranches={groupTreePopoverProps.groupBranches}
        exactSelectedGroup={exactSelectedGroup}
        groupPlayback={groupPlayback}
        canPlayGroupSummary={canPlayGroupSummary}
        startGroupPlayback={startGroupPlayback}
        pauseGroupPlayback={pauseGroupPlayback}
        resumeGroupPlayback={resumeGroupPlayback}
        handleAutoArrangeGroup={handleAutoArrangeGroup}
        handleDeleteGroup={handleDeleteGroup}
        handleFocusGroup={handleFocusGroup}
        handleCreateGroupBranch={groupTreePopoverProps.handleCreateGroupBranch}
        handleDeleteGroupBranch={groupTreePopoverProps.handleDeleteGroupBranch}
        handleFocusGroupBranch={groupTreePopoverProps.handleFocusGroupBranch}
        handleMoveGroupToBranch={groupTreePopoverProps.handleMoveGroupToBranch}
        handleRenameGroup={groupTreePopoverProps.handleRenameGroup}
        handleRenameGroupBranch={groupTreePopoverProps.handleRenameGroupBranch}
      />
      {generationTraceRecentRecords.length > 0 && (
        <Tooltip
          title={
            isChineseUi
              ? '\u67e5\u770b\u5f53\u524d\u9879\u76ee\u7684\u51fa\u56fe\u8bb0\u5f55'
              : 'Open generation history'
          }
        >
          <Chip
            icon={<AutoAwesomeIcon sx={{ fontSize: '16px !important' }} />}
            label={
              isChineseUi
                ? `\u51fa\u56fe\u8bb0\u5f55 ${generationTraceRecentRecords.length}`
                : `Generation ${generationTraceRecentRecords.length}`
            }
            variant="outlined"
            onClick={handleOpenGenerationTraceHistory}
            sx={{
              mr: 1,
              maxWidth: 180,
              cursor: 'pointer',
              flexShrink: 0,
              '& .MuiChip-label': {
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }
            }}
          />
        </Tooltip>
      )}
      {groupPlayback && (
        <Box
          sx={{
            mr: 1,
            px: 1,
            py: 0.5,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            border: '1px solid',
            borderColor: groupPlayback.paused ? 'warning.main' : 'success.main',
            bgcolor: 'rgba(15,23,42,0.42)',
            flexShrink: 0
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
            {`${groupPlayback.groupName} ${groupPlayback.currentIndex + 1}/${groupPlayback.itemIds.length}`}
          </Typography>
          <Tooltip title={groupPlayback.paused ? 'Resume playback' : 'Pause playback'}>
            <IconButton
              size="small"
              onClick={() => (groupPlayback.paused ? resumeGroupPlayback() : pauseGroupPlayback())}
            >
              {groupPlayback.paused ? (
                <PlayArrowIcon fontSize="small" />
              ) : (
                <PauseIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="Stop playback">
            <IconButton size="small" color="error" onClick={stopGroupPlayback}>
              <ClearIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      <Tooltip title={t('canvas.action_save_with_shortcut', { shortcut: toolShortcuts.export })}>
        <span>
          <IconButton
            size="small"
            onClick={() => void handleSaveCanvas()}
            onContextMenu={(e) => {
              e.preventDefault()
              if (items.length === 0) return
              handleOpenExportContextMenu({ x: e.clientX, y: e.clientY })
            }}
            disabled={items.length === 0}
          >
            <ExportIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('canvas.action_export')}>
        <span>
          <IconButton
            size="small"
            onClick={(e) => handleOpenExportMenu(e.currentTarget)}
            disabled={items.length === 0}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <ProjectCanvasPageExportMenus
        closeExportMenus={closeExportMenus}
        exportCtxMenuPos={exportCtxMenuPos}
        exportMenuAnchor={exportMenuAnchor}
        exportSubmenuAnchor={exportSubmenuAnchor}
        exportSubmenuPlacement={exportSubmenuPlacement}
        exportableItems={exportableItems}
        handleCloseExportContextMenu={handleCloseExportContextMenu}
        handleCloseExportSubmenu={handleCloseExportSubmenu}
        handleExportCanvasProjectFile={handleExportCanvasProjectFile}
        handleExportScopeWithFormat={handleExportScopeWithFormat}
        handleSaveCanvas={handleSaveCanvas}
        handleSaveCanvasAs={handleSaveCanvasAs}
        handleSaveCanvasAsFromContextMenu={handleSaveCanvasAsFromContextMenu}
        openExportSubmenu={openExportSubmenu}
        selectedExportableItems={selectedExportableItems}
        selectedIds={selectedIds}
        setToolShortcutCtxMenu={setToolShortcutCtxMenu}
        setToolShortcutRecorded={setToolShortcutRecorded}
        t={t}
        toolShortcutCtxMenu={toolShortcutCtxMenu}
        toolShortcutRecorded={toolShortcutRecorded}
        toolShortcuts={toolShortcuts}
        updateToolShortcut={updateToolShortcut}
      />

      <Tooltip title={t('canvas.action_clear')}>
        <span>
          <IconButton
            size="small"
            onClick={openClearConfirmDialog}
            disabled={items.length === 0}
            color="error"
          >
            <ClearIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  )
}

export default React.memo(ProjectCanvasPageTopToolbar)
