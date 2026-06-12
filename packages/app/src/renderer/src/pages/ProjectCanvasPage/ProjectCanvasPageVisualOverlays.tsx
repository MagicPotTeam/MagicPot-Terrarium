import React from 'react'
import { createPortal } from 'react-dom'
import { Box, Typography } from '@mui/material'
import type { DragEvent as ReactDragEvent } from 'react'
import { PhotoLibrary as PhotoIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import Canvas3DStage, { type Canvas3DStageViewportSync } from './components/Canvas3DStage'
import type { CanvasSyncDetail } from './components/canvasSync'
import VideoOverlay from './components/VideoOverlay'
import HtmlOverlay from './components/HtmlOverlay'
import GroupPlaybackOverlay from './components/GroupPlaybackOverlay'
import CanvasTextOverlay from './components/CanvasTextOverlay'
import CanvasFileOverlay from './components/CanvasFileOverlay'
import CanvasAnnotationOverlay from './components/CanvasAnnotationOverlay'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from './projectCanvasViewportScale'
import { createProjectCanvasRuntime, type ProjectCanvasRuntime } from './projectCanvasRuntime'
import {
  STAGE_VIEWPORT_LAYER_BASE_STYLE,
  useStageViewportTransformDriver
} from './useStageViewportTransformDriver'
import {
  resolveProjectCanvasRenderBoundary,
  summarizeProjectCanvasVideoBudget
} from './projectCanvasRenderBoundary'
import { getCanvasItemBounds, type CanvasTool } from './projectCanvasPageShared'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasOcrHoverDetail } from './ocrCanvasUtils'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasHtmlItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

type StagePosition = {
  x: number
  y: number
}

type GroupPlaybackInfo = {
  currentIndex: number
  totalCount: number
  paused: boolean
} | null

const PROJECT_CANVAS_DOM_OVERLAY_VISIBLE_OVERSCAN_PX = 240
const MODEL3D_NAME_BADGE_MIN_WIDTH_PX = 72
const MODEL3D_NAME_BADGE_MAX_WIDTH_PX = 420

type ProjectCanvasDomOverlayEntry =
  | {
      kind: 'video'
      item: CanvasVideoItem
      mode: 'active-playing' | 'visible-paused' | 'poster-frame' | 'unmounted'
      originalIndex: number
    }
  | {
      kind: 'html'
      item: CanvasHtmlItem
      originalIndex: number
    }
  | {
      kind: 'file'
      item: CanvasFileItem
      originalIndex: number
    }
  | {
      kind: 'text'
      item: CanvasTextItem
      originalIndex: number
    }
  | {
      kind: 'annotation'
      item: CanvasAnnotationItem
      originalIndex: number
    }

type MountedDomOverlayItems = {
  htmlItems: CanvasHtmlItem[]
  fileItems: CanvasFileItem[]
  textItems: CanvasTextItem[]
  annotationItems: CanvasAnnotationItem[]
  mountedTextOrFileIdSet: Set<string>
}

type ProjectCanvasPageVisualOverlaysProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  canvasContainerElement?: HTMLDivElement | null
  sessionKey?: string
  renderedModel3DItems: CanvasModel3DItem[]
  videoItems: CanvasVideoItem[]
  htmlItems: CanvasHtmlItem[]
  annotationItems: CanvasAnnotationItem[]
  textItems: CanvasTextItem[]
  fileItems: CanvasFileItem[]
  items?: CanvasItem[]
  editingTextItemId: string | null
  activeOcrHover: CanvasOcrHoverDetail | null
  selectedIds: Set<string>
  tool: CanvasTool
  stagePos: StagePosition
  stageScale: number
  stageSize: { width: number; height: number }
  itemsLength: number
  isViewportInteracting?: boolean
  isCanvasPerformanceThrottled?: boolean
  forceRenderAllItemsForExport?: boolean
  onSelectItem: (itemId: string) => void
  onDragOver: (event: ReactDragEvent) => void
  onDrop: (event: ReactDragEvent) => void
  onDragVideoEnd: (itemId: string, x: number, y: number, event?: PointerEvent) => void
  onUpdateVideoItem: (itemId: string, updates: Partial<CanvasVideoItem>) => void
  onVideoContextMenu?: (event: MouseEvent | PointerEvent, item: CanvasVideoItem) => void
  onUpdateHtmlItem: (itemId: string, updates: Partial<CanvasHtmlItem>) => void
  onDeleteHtmlItem: (itemId: string) => void
  groupPlaybackInfo: GroupPlaybackInfo
  activeGroupPlaybackItem: CanvasImageItem | CanvasVideoItem | CanvasModel3DItem | null
  activeGroupPlaybackCanvasBounds: CanvasExportBounds | null
  activeGroupPlaybackScreenBounds: CanvasExportBounds | null
  activeGroupPlaybackGroupName: string | null
  onToggleGroupPlaybackPause: () => void
  onStopGroupPlayback: () => void
  onGroupPlaybackVideoEnded: () => void
  onExportGroupPlaybackAsGif: () => void
  registerViewportLayer?: (element: HTMLElement | null) => void
  registerViewportCallback?: (
    fn: (pos: { x: number; y: number }, scale: number) => void
  ) => () => void
}

const rotateModelOverlayOffset = (point: { x: number; y: number }, rotation: number) => {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

const getModel3DOverlayBounds = (item: CanvasModel3DItem) => {
  const scaledWidth = item.width * item.scaleX
  const scaledHeight = item.height * item.scaleY
  const width = Math.max(1, Math.abs(scaledWidth))
  const height = Math.max(1, Math.abs(scaledHeight))
  const offset = rotateModelOverlayOffset(
    {
      x: Math.min(0, scaledWidth),
      y: Math.min(0, scaledHeight)
    },
    item.rotation
  )

  return {
    x: item.x + offset.x,
    y: item.y + offset.y,
    width,
    height
  }
}

const resolveModel3DPreviewItem = (
  item: CanvasModel3DItem,
  preview: CanvasSyncDetail | null
): CanvasModel3DItem => {
  if (!preview) {
    return item
  }

  return {
    ...item,
    x: preview.x,
    y: preview.y,
    rotation: preview.rotation,
    scaleX: preview.scaleX,
    scaleY: preview.scaleY
  }
}

const applyModel3DNameBadgeLayout = (
  node: HTMLElement,
  item: CanvasModel3DItem,
  preview: CanvasSyncDetail | null
) => {
  const bounds = getModel3DOverlayBounds(resolveModel3DPreviewItem(item, preview))
  const badgeWidth = Math.min(
    MODEL3D_NAME_BADGE_MAX_WIDTH_PX,
    Math.max(MODEL3D_NAME_BADGE_MIN_WIDTH_PX, bounds.width - 12)
  )

  node.style.left = `${bounds.x + 6}px`
  node.style.top = `${bounds.y + 6}px`
  node.style.maxWidth = `${badgeWidth}px`
}

const Model3DNameBadge: React.FC<{
  item: CanvasModel3DItem
}> = ({ item }) => {
  const badgeRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const badgeNode = badgeRef.current
    if (!badgeNode) {
      return
    }

    applyModel3DNameBadgeLayout(badgeNode, item, null)

    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<CanvasSyncDetail>).detail
      if (!detail || !badgeRef.current) {
        return
      }

      applyModel3DNameBadgeLayout(badgeRef.current, item, detail)
    }

    const handleCanvasReset = () => {
      if (!badgeRef.current) {
        return
      }

      applyModel3DNameBadgeLayout(badgeRef.current, item, null)
    }

    window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    window.addEventListener(`canvas-reset-${item.id}`, handleCanvasReset)

    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
      window.removeEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
    }
  }, [item])

  return (
    <Box
      ref={badgeRef}
      data-canvas-overlay="model3d-name"
      data-canvas-item-id={item.id}
      title={item.fileName}
      sx={{
        position: 'absolute',
        width: 'max-content',
        px: 0.8,
        py: 0.35,
        borderRadius: '4px',
        bgcolor: 'rgba(2, 6, 23, 0.78)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
        backdropFilter: 'blur(4px)',
        pointerEvents: 'none',
        zIndex: item.zIndex + 1
      }}
    >
      <Typography
        variant="caption"
        sx={{
          color: '#e2e8f0',
          fontSize: 10,
          lineHeight: 1.25,
          display: 'block',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {item.fileName}
      </Typography>
    </Box>
  )
}

const ProjectCanvasPageVisualOverlays: React.FC<ProjectCanvasPageVisualOverlaysProps> = ({
  canvasContainerRef,
  canvasContainerElement,
  sessionKey,
  renderedModel3DItems,
  videoItems,
  htmlItems,
  annotationItems,
  textItems,
  fileItems,
  items = [],
  editingTextItemId,
  activeOcrHover,
  selectedIds,
  tool,
  stagePos,
  stageScale,
  stageSize,
  itemsLength,
  isViewportInteracting = false,
  isCanvasPerformanceThrottled = false,
  forceRenderAllItemsForExport = false,
  onSelectItem,
  onDragOver,
  onDrop,
  onDragVideoEnd,
  onUpdateVideoItem,
  onVideoContextMenu,
  onUpdateHtmlItem,
  onDeleteHtmlItem,
  groupPlaybackInfo,
  activeGroupPlaybackItem,
  activeGroupPlaybackCanvasBounds,
  activeGroupPlaybackScreenBounds,
  activeGroupPlaybackGroupName,
  onToggleGroupPlaybackPause,
  onStopGroupPlayback,
  onGroupPlaybackVideoEnded,
  onExportGroupPlaybackAsGif,
  registerViewportLayer: registerViewportLayerProp,
  registerViewportCallback
}) => {
  const { t } = useTranslation()
  const portalHost = canvasContainerElement ?? canvasContainerRef.current
  const localDriver = useStageViewportTransformDriver()
  const registerViewportLayer = registerViewportLayerProp ?? localDriver.registerViewportLayer
  const canvas3DViewportSyncRef = React.useRef<Canvas3DStageViewportSync | null>(null)

  React.useLayoutEffect(() => {
    if (!registerViewportLayerProp) {
      localDriver.applyViewportTransform(stagePos, stageScale)
    }
  }, [localDriver, registerViewportLayerProp, stagePos, stageScale])
  React.useEffect(() => {
    if (!registerViewportCallback) {
      return
    }

    return registerViewportCallback((pos, scale) => {
      canvas3DViewportSyncRef.current?.(pos, scale)
    })
  }, [registerViewportCallback])
  const handleCanvas3DViewportSyncReady = React.useCallback(
    (sync: Canvas3DStageViewportSync | null) => {
      canvas3DViewportSyncRef.current = sync
    },
    []
  )

  const itemById = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const renderableItems = React.useMemo(
    () =>
      resolveProjectCanvasRenderBoundary({
        items: [...renderedModel3DItems, ...videoItems, ...htmlItems],
        webglReady: true,
        loadedImageIds: new Set(),
        selectedIds,
        stagePos,
        stageScale,
        stageSize,
        forceRenderAllItemsForExport
      }),
    [
      forceRenderAllItemsForExport,
      htmlItems,
      renderedModel3DItems,
      selectedIds,
      stagePos,
      stageScale,
      stageSize,
      videoItems
    ]
  )
  const {
    canvas3DStageItems,
    renderableHtmlCanvasItems,
    renderableModel3DItems,
    renderableVideoCanvasItems,
    renderableVideoOrModel3DIdSet
  } = React.useMemo(() => {
    const nextCanvas3DStageItems: CanvasModel3DItem[] = []
    const nextRenderableHtmlCanvasItems: CanvasHtmlItem[] = []
    const nextRenderableModel3DItems: Array<
      Extract<(typeof renderableItems)[number], { kind: 'model3d' }>
    > = []
    const nextRenderableVideoCanvasItems: Array<
      Extract<(typeof renderableItems)[number], { kind: 'video' }>
    > = []
    const nextRenderableVideoOrModel3DIdSet = new Set<string>()

    for (const renderableItem of renderableItems) {
      if (renderableItem.kind === 'model3d') {
        nextRenderableModel3DItems.push(renderableItem)
        nextCanvas3DStageItems.push(renderableItem.item)
        nextRenderableVideoOrModel3DIdSet.add(renderableItem.id)
        continue
      }

      if (renderableItem.kind === 'video') {
        nextRenderableVideoCanvasItems.push(renderableItem)
        nextRenderableVideoOrModel3DIdSet.add(renderableItem.id)
        continue
      }

      if (renderableItem.kind === 'html') {
        nextRenderableHtmlCanvasItems.push(renderableItem.item)
      }
    }

    return {
      canvas3DStageItems: nextCanvas3DStageItems,
      renderableHtmlCanvasItems: nextRenderableHtmlCanvasItems,
      renderableModel3DItems: nextRenderableModel3DItems,
      renderableVideoCanvasItems: nextRenderableVideoCanvasItems,
      renderableVideoOrModel3DIdSet: nextRenderableVideoOrModel3DIdSet
    }
  }, [renderableItems])
  const budgetedVideoItems = React.useMemo(
    () =>
      renderableVideoCanvasItems.map((renderableItem) => ({
        item: renderableItem.item,
        isVisible: renderableItem.isVisible,
        mode: isCanvasPerformanceThrottled
          ? 'poster-frame'
          : (renderableItem.videoBudgetMode ?? 'visible-paused')
      })),
    [isCanvasPerformanceThrottled, renderableVideoCanvasItems]
  )
  const videoBudgetSummary = React.useMemo(
    () => summarizeProjectCanvasVideoBudget(budgetedVideoItems),
    [budgetedVideoItems]
  )
  const mountedVideoCount = React.useMemo(
    () => videoBudgetSummary.totalVideos - videoBudgetSummary.unmountedCount,
    [videoBudgetSummary]
  )
  const shouldPassthroughCanvasItemInteractions = tool !== 'select'
  const mountedDomOverlayItemsRef = React.useRef<MountedDomOverlayItems | null>(null)
  const domOverlayVisibilityRuntimeRef = React.useRef<ProjectCanvasRuntime | null>(null)
  const domOverlayVisibilityItemsRef = React.useRef<CanvasItem[] | null>(null)
  const domCanvasItems = React.useMemo<CanvasItem[]>(
    () => [...renderableHtmlCanvasItems, ...fileItems, ...textItems, ...annotationItems],
    [annotationItems, fileItems, renderableHtmlCanvasItems, textItems]
  )
  const mountedDomOverlayItems = React.useMemo(() => {
    if (
      isViewportInteracting &&
      !forceRenderAllItemsForExport &&
      mountedDomOverlayItemsRef.current
    ) {
      return mountedDomOverlayItemsRef.current
    }

    const nextHtmlItems: CanvasHtmlItem[] = []
    const nextFileItems: CanvasFileItem[] = []
    const nextTextItems: CanvasTextItem[] = []
    const nextAnnotationItems: CanvasAnnotationItem[] = []
    const nextMountedTextOrFileIdSet = new Set<string>()

    let mountedIds: Set<string> | null = null

    if (!forceRenderAllItemsForExport && domCanvasItems.length > 0) {
      const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
      let runtime = domOverlayVisibilityRuntimeRef.current
      if (!runtime) {
        runtime = createProjectCanvasRuntime({ getItemBounds: getCanvasItemBounds })
        domOverlayVisibilityRuntimeRef.current = runtime
      }
      if (domOverlayVisibilityItemsRef.current !== domCanvasItems) {
        runtime.setItems(domCanvasItems)
        domOverlayVisibilityItemsRef.current = domCanvasItems
      }
      runtime.setViewport({ x: stagePos.x, y: stagePos.y, scale: safeScale })
      const queriedItems = runtime.getVisibleItems({
        stageSize,
        overscanPx: PROJECT_CANVAS_DOM_OVERLAY_VISIBLE_OVERSCAN_PX
      })
      mountedIds = new Set<string>(queriedItems.map((item) => item.id))
      selectedIds.forEach((itemId) => mountedIds?.add(itemId))
      if (editingTextItemId) {
        mountedIds.add(editingTextItemId)
      }
    }

    for (const item of domCanvasItems) {
      if (mountedIds && !mountedIds.has(item.id)) {
        continue
      }

      switch (item.type) {
        case 'html':
          nextHtmlItems.push(item)
          break
        case 'file':
          nextFileItems.push(item)
          nextMountedTextOrFileIdSet.add(item.id)
          break
        case 'text':
          nextTextItems.push(item)
          nextMountedTextOrFileIdSet.add(item.id)
          break
        case 'annotation':
          nextAnnotationItems.push(item)
          break
      }
    }

    const nextMountedDomOverlayItems = {
      htmlItems: nextHtmlItems,
      fileItems: nextFileItems,
      textItems: nextTextItems,
      annotationItems: nextAnnotationItems,
      mountedTextOrFileIdSet: nextMountedTextOrFileIdSet
    }
    mountedDomOverlayItemsRef.current = nextMountedDomOverlayItems
    return nextMountedDomOverlayItems
  }, [
    domCanvasItems,
    editingTextItemId,
    forceRenderAllItemsForExport,
    isViewportInteracting,
    selectedIds,
    stagePos,
    stageScale,
    stageSize
  ])
  const mountedHtmlItems = mountedDomOverlayItems.htmlItems
  const mountedFileItems = mountedDomOverlayItems.fileItems
  const mountedTextItems = mountedDomOverlayItems.textItems
  const mountedAnnotationItems = mountedDomOverlayItems.annotationItems
  const mountedTextOrFileIdSet = mountedDomOverlayItems.mountedTextOrFileIdSet
  const domOverlayCount =
    mountedVideoCount +
    mountedHtmlItems.length +
    mountedFileItems.length +
    mountedTextItems.length +
    mountedAnnotationItems.length
  const selectedSingleSelectionOverlaySuppressedItemId = React.useMemo(() => {
    if (tool !== 'select' || selectedIds.size !== 1) {
      return null
    }

    const selectedId = Array.from(selectedIds)[0]
    if (renderableVideoOrModel3DIdSet.has(selectedId)) {
      return selectedId
    }
    if (mountedTextOrFileIdSet.has(selectedId)) {
      return selectedId
    }
    return null
  }, [mountedTextOrFileIdSet, renderableVideoOrModel3DIdSet, selectedIds, tool])
  const mountedBudgetedVideoItems = React.useMemo(
    () => budgetedVideoItems.filter(({ mode }) => mode !== 'unmounted'),
    [budgetedVideoItems]
  )
  const orderedDomOverlayEntries = React.useMemo<ProjectCanvasDomOverlayEntry[]>(() => {
    const nextEntries: ProjectCanvasDomOverlayEntry[] = []
    let originalIndex = 0

    mountedBudgetedVideoItems.forEach(({ item, mode }) => {
      nextEntries.push({
        kind: 'video',
        item,
        mode,
        originalIndex: originalIndex++
      })
    })
    mountedHtmlItems.forEach((item) => {
      nextEntries.push({
        kind: 'html',
        item,
        originalIndex: originalIndex++
      })
    })
    mountedFileItems.forEach((item) => {
      nextEntries.push({
        kind: 'file',
        item,
        originalIndex: originalIndex++
      })
    })
    mountedTextItems.forEach((item) => {
      nextEntries.push({
        kind: 'text',
        item,
        originalIndex: originalIndex++
      })
    })
    mountedAnnotationItems.forEach((item) => {
      nextEntries.push({
        kind: 'annotation',
        item,
        originalIndex: originalIndex++
      })
    })

    nextEntries.sort((left, right) => {
      if (left.item.zIndex === right.item.zIndex) {
        return left.originalIndex - right.originalIndex
      }
      return left.item.zIndex - right.item.zIndex
    })

    return nextEntries
  }, [
    mountedAnnotationItems,
    mountedBudgetedVideoItems,
    mountedFileItems,
    mountedHtmlItems,
    mountedTextItems
  ])
  const canvas3DStageSelectedIds = React.useMemo(() => {
    if (tool !== 'select') {
      return new Set<string>()
    }

    const nextSelectedIds = new Set<string>()
    for (const { item } of renderableModel3DItems) {
      if (selectedIds.has(item.id)) {
        nextSelectedIds.add(item.id)
      }
    }

    if (
      selectedSingleSelectionOverlaySuppressedItemId &&
      nextSelectedIds.has(selectedSingleSelectionOverlaySuppressedItemId)
    ) {
      nextSelectedIds.delete(selectedSingleSelectionOverlaySuppressedItemId)
    }

    return nextSelectedIds
  }, [renderableModel3DItems, selectedIds, selectedSingleSelectionOverlaySuppressedItemId, tool])

  if (!portalHost) {
    return null
  }

  const overlay = (
    <>
      <div
        data-project-canvas-overlay-total-count={canvas3DStageItems.length + domOverlayCount}
        data-project-canvas-dom-overlay-count={domOverlayCount}
        data-project-canvas-canvas3d-overlay-count={canvas3DStageItems.length}
        data-project-canvas-mounted-video-overlay-count={mountedVideoCount}
        data-project-canvas-html-overlay-count={mountedHtmlItems.length}
        data-project-canvas-file-overlay-count={mountedFileItems.length}
        data-project-canvas-text-overlay-count={mountedTextItems.length}
        data-project-canvas-annotation-overlay-count={mountedAnnotationItems.length}
        data-project-canvas-video-total-count={videoBudgetSummary.totalVideos}
        data-project-canvas-video-active-playing-count={videoBudgetSummary.activePlayingCount}
        data-project-canvas-video-visible-paused-count={videoBudgetSummary.visiblePausedCount}
        data-project-canvas-video-poster-frame-count={videoBudgetSummary.posterFrameCount}
        data-project-canvas-video-unmounted-count={videoBudgetSummary.unmountedCount}
        data-project-canvas-overlay-performance-throttled={String(isCanvasPerformanceThrottled)}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          overflow: 'visible',
          pointerEvents: 'none'
        }}
        onDragEnterCapture={onDragOver}
        onDragOverCapture={onDragOver}
        onDropCapture={onDrop}
      >
        <Canvas3DStage
          items={canvas3DStageItems}
          selectedIds={canvas3DStageSelectedIds}
          stagePos={stagePos}
          stageScale={stageScale}
          stageSize={stageSize}
          sessionKey={sessionKey}
          isViewportInteracting={isViewportInteracting}
          isPerformanceThrottled={isCanvasPerformanceThrottled}
          onViewportSyncReady={handleCanvas3DViewportSyncReady}
        />
        <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
          {renderableModel3DItems.map(({ item }) => {
            return <Model3DNameBadge key={`model3d-name-${item.id}`} item={item} />
          })}
          {orderedDomOverlayEntries.map((entry) => {
            if (entry.kind === 'video') {
              const { item, mode } = entry
              return (
                <VideoOverlay
                  key={item.id}
                  canvasContainerRef={canvasContainerRef}
                  item={item}
                  budgetMode={mode}
                  isSelected={selectedIds.has(item.id) && tool === 'select'}
                  showSelectionOutline={
                    selectedIds.has(item.id) &&
                    tool === 'select' &&
                    item.id !== selectedSingleSelectionOverlaySuppressedItemId
                  }
                  stagePos={stagePos}
                  stageScale={stageScale}
                  allowPointerPassthrough={shouldPassthroughCanvasItemInteractions}
                  onSelect={() => {
                    if (tool === 'select') onSelectItem(item.id)
                  }}
                  onDragEnd={onDragVideoEnd}
                  onContextMenu={
                    onVideoContextMenu ? (event) => onVideoContextMenu(event, item) : undefined
                  }
                  onUpdateItem={onUpdateVideoItem}
                />
              )
            }

            if (entry.kind === 'html') {
              const { item } = entry
              return (
                <HtmlOverlay
                  key={item.id}
                  item={item}
                  isSelected={selectedIds.has(item.id) && tool === 'select'}
                  stagePos={stagePos}
                  stageScale={stageScale}
                  activeOcrHover={activeOcrHover}
                  allowPointerPassthrough={shouldPassthroughCanvasItemInteractions}
                  onSelect={() => {
                    if (tool === 'select') onSelectItem(item.id)
                  }}
                  onUpdateItem={onUpdateHtmlItem}
                  onDelete={onDeleteHtmlItem}
                />
              )
            }

            if (entry.kind === 'file') {
              const { item } = entry
              return (
                <CanvasFileOverlay
                  key={item.id}
                  item={item}
                  isSelected={selectedIds.has(item.id) && tool === 'select'}
                  showSelectionOutline={
                    selectedIds.has(item.id) &&
                    tool === 'select' &&
                    item.id !== selectedSingleSelectionOverlaySuppressedItemId
                  }
                />
              )
            }

            if (entry.kind === 'text') {
              const { item } = entry
              return (
                <CanvasTextOverlay
                  key={item.id}
                  item={item}
                  isSelected={selectedIds.has(item.id) && tool === 'select'}
                  showSelectionOutline={
                    selectedIds.has(item.id) &&
                    tool === 'select' &&
                    item.id !== selectedSingleSelectionOverlaySuppressedItemId
                  }
                  isEditing={
                    editingTextItemId === item.id ||
                    selectedSingleSelectionOverlaySuppressedItemId === item.id
                  }
                />
              )
            }

            const { item } = entry
            const isEmphasized =
              Boolean(item.ocrBundleId) &&
              Boolean(item.ocrBoxId) &&
              activeOcrHover?.bundleId === item.ocrBundleId &&
              Boolean(activeOcrHover?.bboxIds.includes(item.ocrBoxId as string))

            return (
              <CanvasAnnotationOverlay
                key={item.id}
                item={item}
                attachedParentItem={
                  item.attachedToId ? (itemById.get(item.attachedToId) ?? null) : null
                }
                isEditing={editingTextItemId === item.id}
                isEmphasized={isEmphasized}
                stageScale={stageScale}
              />
            )
          })}
        </div>
      </div>

      {groupPlaybackInfo &&
        activeGroupPlaybackGroupName &&
        activeGroupPlaybackItem &&
        activeGroupPlaybackCanvasBounds &&
        activeGroupPlaybackScreenBounds && (
          <GroupPlaybackOverlay
            item={activeGroupPlaybackItem}
            bounds={activeGroupPlaybackScreenBounds}
            canvasBounds={activeGroupPlaybackCanvasBounds}
            viewportSize={stageSize}
            sessionKey={sessionKey}
            groupName={activeGroupPlaybackGroupName}
            currentIndex={groupPlaybackInfo.currentIndex}
            totalCount={groupPlaybackInfo.totalCount}
            paused={groupPlaybackInfo.paused}
            onPauseToggle={onToggleGroupPlaybackPause}
            onStop={onStopGroupPlayback}
            onVideoEnded={onGroupPlaybackVideoEnded}
            onExportGif={onExportGroupPlaybackAsGif}
          />
        )}

      {itemsLength === 0 && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            pointerEvents: 'none',
            opacity: 0.3
          }}
        >
          <PhotoIcon sx={{ fontSize: 64, mb: 1 }} />
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
            {t('project_canvas.empty_state_title')}
          </Typography>
          <Typography variant="body2">{t('project_canvas.empty_state_desc')}</Typography>
        </Box>
      )}
    </>
  )

  return createPortal(overlay, portalHost)
}

export default ProjectCanvasPageVisualOverlays
