import React from 'react'
import { createPortal } from 'react-dom'
import { Box, Divider, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material'
import {
  ChatBubbleOutline as ChatBubbleOutlineIcon,
  ContentCopy,
  Crop as CropIcon,
  DragIndicator as DragIndicatorIcon,
  Download,
  FilterCenterFocus as FilterCenterFocusIcon,
  Flip as FlipIcon,
  LayersOutlined as LayersOutlinedIcon,
  PauseCircleFilled as PauseIcon,
  PlayArrow as PlayArrowIcon,
  Send as SendIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

import CanvasMultiSelectionOverlay from './components/CanvasMultiSelectionOverlay'
import { useLiveSelectionOverlayGroups } from './canvasLiveOverlayBounds'
import { getCanvasFileExportOptions, type CanvasFileExportFormat } from './canvasFileExportUtils'
import { findCanvasItemOverlayElement } from './canvasDomOverlayLookup'
import { resolveSelectionActionToolbarPosition } from './canvasSelectionLayoutUtils'
import {
  getCanvasItemBounds,
  getCanvasItemsBounds,
  type CanvasDragPayload,
  type CanvasTool
} from './projectCanvasPageShared'
import type { ProjectCanvasVideoBudgetMode } from './projectCanvasRenderBoundary'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasGroup,
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

type StageSize = {
  width: number
  height: number
}

type SelectionBounds = {
  height: number
  width: number
  x: number
  y: number
}

type SelectionOverlayGroup = CanvasGroup & {
  bounds: { x: number; y: number; width: number; height: number }
  validItems: CanvasItem[]
}

type DragPayloadOptions = {
  objectUrl?: string
  previewImageUrl?: string
  promptId?: string
}

type ClientRectLike = {
  x: number
  y: number
  width: number
  height: number
}

type StageNodeLike = {
  getClientRect?: () => ClientRectLike
}

type StageLike = {
  findOne?: (selector: string) => StageNodeLike | null | undefined
}

type StageRefLike = {
  getStage?: () => StageLike | null
}

const stopCanvasToolbarPointerPropagation = (
  event:
    | React.MouseEvent<HTMLElement>
    | React.PointerEvent<HTMLElement>
    | React.TouchEvent<HTMLElement>
) => {
  event.stopPropagation()
  event.nativeEvent.stopImmediatePropagation?.()
}

type SelectionToolbarKind = 'blob' | 'file' | 'group' | 'image' | 'multi' | 'textlike'
type GroupChipPlacement =
  | 'above-toolbar'
  | 'below-toolbar'
  | 'default'
  | 'left-of-toolbar'
  | 'right-of-toolbar'
type GroupChipLayout = {
  contentWidth: number
  height: number
  id: string
  placement: GroupChipPlacement
  scale: number
  width: number
  x: number
  y: number
}

const SELECTION_TOOLBAR_SIZE_ESTIMATES: Record<
  SelectionToolbarKind,
  { width: number; height: number }
> = {
  blob: { width: 392, height: 44 },
  file: { width: 220, height: 44 },
  group: { width: 320, height: 44 },
  image: { width: 404, height: 44 },
  multi: { width: 360, height: 44 },
  textlike: { width: 268, height: 44 }
}

const GROUP_CHIP_HEIGHT_ESTIMATE = 34
const GROUP_CHIP_MARGIN = 8
const GROUP_CHIP_MIN_WIDTH = 88
const GROUP_CHIP_MAX_WIDTH = 220
const GROUP_CHIP_MAX_SCALE = 1.08
const GROUP_CHIP_MIN_GAP = 6
const GROUP_CHIP_MIN_SCALE = 0.58

function clampGroupChipValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function estimateGroupChipWidth(name: string) {
  return Math.min(GROUP_CHIP_MAX_WIDTH, Math.max(GROUP_CHIP_MIN_WIDTH, 44 + name.length * 14))
}

function getGroupChipVisualScale(stageScale: number) {
  const normalizedScale = Math.max(Math.abs(stageScale), 0.0001)
  return clampGroupChipValue(
    Math.pow(normalizedScale, 0.35),
    GROUP_CHIP_MIN_SCALE,
    GROUP_CHIP_MAX_SCALE
  )
}

function resolveDefaultGroupChipLayout(options: {
  bounds: SelectionBounds
  id: string
  name: string
  stagePos: StagePosition
  stageScale: number
  viewportHeight: number
  viewportWidth: number
}): GroupChipLayout {
  const { bounds, id, name, stagePos, stageScale, viewportHeight, viewportWidth } = options
  const contentWidth = estimateGroupChipWidth(name)
  const scale = getGroupChipVisualScale(stageScale)
  const width = contentWidth * scale
  const height = GROUP_CHIP_HEIGHT_ESTIMATE * scale
  const gap = Math.max(GROUP_CHIP_MIN_GAP, 12 * scale)
  const x = clampGroupChipValue(
    stagePos.x + bounds.x * stageScale,
    GROUP_CHIP_MARGIN,
    viewportWidth - GROUP_CHIP_MARGIN - width
  )
  const y = clampGroupChipValue(
    stagePos.y + bounds.y * stageScale - height - gap,
    GROUP_CHIP_MARGIN,
    viewportHeight - GROUP_CHIP_MARGIN - height
  )

  return {
    contentWidth,
    height,
    id,
    placement: 'default',
    scale,
    width,
    x,
    y
  }
}

function resolveAdaptiveExactGroupChipLayout(options: {
  defaultLayout: GroupChipLayout
  toolbarHeight: number
  toolbarLeft: number
  toolbarTop: number
  toolbarWidth: number
  viewportHeight: number
  viewportWidth: number
}) {
  const {
    defaultLayout,
    toolbarHeight,
    toolbarLeft,
    toolbarTop,
    toolbarWidth,
    viewportHeight,
    viewportWidth
  } = options
  const margin = 16
  const gap = 12
  const centeredTop = toolbarTop + (toolbarHeight - defaultLayout.height) / 2
  const toolbarMinX = toolbarLeft - toolbarWidth / 2
  const toolbarMaxX = toolbarLeft + toolbarWidth / 2

  const candidates: GroupChipLayout[] = [
    {
      ...defaultLayout,
      placement: 'left-of-toolbar',
      x: toolbarMinX - defaultLayout.width - gap,
      y: centeredTop
    },
    {
      ...defaultLayout,
      placement: 'right-of-toolbar',
      x: toolbarMaxX + gap,
      y: centeredTop
    },
    {
      ...defaultLayout,
      placement: 'above-toolbar',
      x: clampGroupChipValue(
        toolbarLeft - defaultLayout.width / 2,
        margin,
        viewportWidth - margin - defaultLayout.width
      ),
      y: toolbarTop - defaultLayout.height - gap
    },
    {
      ...defaultLayout,
      placement: 'below-toolbar',
      x: clampGroupChipValue(
        toolbarLeft - defaultLayout.width / 2,
        margin,
        viewportWidth - margin - defaultLayout.width
      ),
      y: toolbarTop + toolbarHeight + gap
    }
  ]

  const validCandidate = candidates.find(
    (candidate) =>
      candidate.x >= margin &&
      candidate.x + candidate.width <= viewportWidth - margin &&
      candidate.y >= margin &&
      candidate.y + candidate.height <= viewportHeight - margin
  )

  return validCandidate ?? defaultLayout
}

type ProjectCanvasPageSelectionOverlaysProps = {
  tool: CanvasTool
  selectionOverlayGroups: SelectionOverlayGroup[]
  exactSelectedGroup: SelectionOverlayGroup | null
  liveMultiSelectionBounds?: SelectionBounds | null
  stagePos: StagePosition
  stagePosRef?: { current: StagePosition }
  stageScale: number
  stageScaleRef?: { current: number }
  stageSize: StageSize
  selectedIds: Set<string>
  items: CanvasItem[]
  stageRef: React.RefObject<StageRefLike | null>
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  canvasContainerElement?: HTMLDivElement | null
  registerViewportCallback?: (
    callback: (pos: StagePosition, scale: number) => void
  ) => (() => void) | void
  registerViewportInteractionCallback?: (callback: (active: boolean) => void) => (() => void) | void
  lastClickedId: string | null
  mediaCaptionActionLabel: string
  legacySelectionToolbarEnabled: boolean
  groupCreateLabel: string
  handleFocusGroup: (group: SelectionOverlayGroup) => void
  buildCanvasDragPayload: (
    targetItems: CanvasItem[],
    options?: DragPayloadOptions
  ) => CanvasDragPayload
  setCanvasDragPayload: (dataTransfer: DataTransfer, payload: CanvasDragPayload) => void
  handleFlipImage: (item: CanvasImageItem) => void
  handleCropImage: (item: CanvasImageItem) => void
  handleExtractImage?: (item: CanvasImageItem) => void | Promise<void>
  handleExplodeImage?: (item: CanvasImageItem) => void | Promise<void>
  handleCopyCanvasImage: (item?: CanvasItem) => void | Promise<void>
  handleDownloadCanvasImage: (item?: CanvasItem) => void | Promise<void>
  handleOpenAgentSendMenu: (anchor: HTMLElement, items: CanvasItem[]) => void
  handleOpenMediaCaptionEditor: (
    item: CanvasImageItem | CanvasModel3DItem | CanvasVideoItem
  ) => void
  handleSendCanvasItemsToAgent: (items: CanvasItem[]) => void | Promise<void>
  handleToggleVideoPlayback: (item: CanvasVideoItem, nextPlaying?: boolean) => void
  resolvedVideoBudgetModeById?: ReadonlyMap<string, ProjectCanvasVideoBudgetMode>
  handleOpenModel3DViewer: (itemId: string) => void
  handleOpenDccExportMenu: (anchor: HTMLElement, itemId: string) => void
  handleDownloadBlobItem: (item: CanvasModel3DItem | CanvasVideoItem) => void | Promise<void>
  handleExportCanvasFile?: (
    item: CanvasFileItem,
    format?: CanvasFileExportFormat
  ) => void | Promise<void>
  handleCopyCanvasItemsAsImage: (items: CanvasItem[]) => void | Promise<void>
  handleDownloadCanvasItemsAsImage: (items: CanvasItem[], fileName: string) => void | Promise<void>
  getQuickCanvasItemsImageUrl: (items: CanvasItem[]) => string | null
  prepareQuickCanvasItemsImageUrl: (items: CanvasItem[]) => Promise<string | null>
  handleGenerateCanvasItems: (items: CanvasItem[]) => void | Promise<void>
  handleCreateGroup: () => void
  suppressSelectionChrome?: boolean
  fileExportActionLabel?: string
  Model3DIcon: React.ComponentType<{ fontSize?: 'inherit' | 'small' | 'medium' | 'large' }>
  ExportIcon: React.ComponentType<{ fontSize?: 'inherit' | 'small' | 'medium' | 'large' }>
}

export default function ProjectCanvasPageSelectionOverlays({
  tool,
  selectionOverlayGroups,
  exactSelectedGroup,
  liveMultiSelectionBounds = null,
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
  lastClickedId: _lastClickedId,
  mediaCaptionActionLabel,
  legacySelectionToolbarEnabled,
  groupCreateLabel,
  handleFocusGroup,
  buildCanvasDragPayload,
  setCanvasDragPayload,
  handleFlipImage,
  handleCropImage,
  handleExtractImage,
  handleExplodeImage,
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
  handleExportCanvasFile = () => {},
  handleCopyCanvasItemsAsImage,
  handleDownloadCanvasItemsAsImage,
  getQuickCanvasItemsImageUrl,
  prepareQuickCanvasItemsImageUrl,
  handleGenerateCanvasItems,
  handleCreateGroup,
  suppressSelectionChrome = false,
  fileExportActionLabel = 'Export file',
  Model3DIcon,
  ExportIcon
}: ProjectCanvasPageSelectionOverlaysProps) {
  const { i18n } = useTranslation()
  const portalHost = canvasContainerElement ?? canvasContainerRef.current
  const viewportInteractionActiveRef = React.useRef(false)
  const pendingViewportChromeSyncRef = React.useRef(false)
  const deferredViewportChromeSyncFrameRef = React.useRef<number | null>(null)
  const [fileExportMenuAnchor, setFileExportMenuAnchor] = React.useState<HTMLElement | null>(null)
  const imageToolbarRef = React.useRef<HTMLDivElement | null>(null)
  const blobToolbarRef = React.useRef<HTMLDivElement | null>(null)
  const textToolbarRef = React.useRef<HTMLDivElement | null>(null)
  const fileToolbarRef = React.useRef<HTMLDivElement | null>(null)
  const selectedItemsRef = React.useRef<CanvasItem[]>([])
  const handleImageExtractAction = handleExtractImage ?? handleExplodeImage ?? (() => {})
  const liveSelectionOverlayGroups = useLiveSelectionOverlayGroups({
    canvasContainerRef,
    selectionOverlayGroups,
    stagePos,
    stageRef,
    stageScale
  })
  React.useEffect(() => {
    setFileExportMenuAnchor(null)
  }, [selectedIds, tool])

  const getLiveStageSnapshot = React.useCallback(
    () => ({
      pos: stagePosRef?.current ?? stagePos,
      scale: stageScaleRef?.current ?? stageScale
    }),
    [stagePos, stagePosRef, stageScale, stageScaleRef]
  )

  const getViewportSize = React.useCallback(
    () => ({
      width: portalHost?.clientWidth || stageSize.width,
      height: portalHost?.clientHeight || stageSize.height
    }),
    [portalHost, stageSize.height, stageSize.width]
  )

  const hasRenderableClientRect = React.useCallback(
    (clientRect: ClientRectLike | null | undefined): clientRect is ClientRectLike =>
      Boolean(clientRect && clientRect.width > 0 && clientRect.height > 0),
    []
  )

  const getFallbackClientRect = React.useCallback(
    (item: CanvasItem): ClientRectLike => {
      const { pos, scale } = getLiveStageSnapshot()
      const bounds = getCanvasItemBounds(item)
      const scaledWidth = (bounds.maxX - bounds.minX) * Math.abs(scale)
      const scaledHeight = (bounds.maxY - bounds.minY) * Math.abs(scale)

      return {
        x: pos.x + bounds.minX * scale,
        y: pos.y + bounds.minY * scale,
        width: Math.max(1, scaledWidth),
        height: Math.max(1, scaledHeight)
      }
    },
    [getLiveStageSnapshot]
  )
  const getOverlayClientRect = React.useCallback(
    (item: CanvasItem): ClientRectLike | null => {
      const container = portalHost ?? canvasContainerRef.current
      if (!container) return null

      const element = findCanvasItemOverlayElement(container, item)
      if (!element) return null

      const containerRect = container.getBoundingClientRect()
      const elementRect = element.getBoundingClientRect()
      return {
        x: elementRect.left - containerRect.left,
        y: elementRect.top - containerRect.top,
        width: elementRect.width,
        height: elementRect.height
      }
    },
    [canvasContainerRef, portalHost]
  )

  const scaleCanvasBoundsToClientRect = React.useCallback(
    (
      bounds: SelectionBounds,
      stageTransform: { pos: StagePosition; scale: number } = getLiveStageSnapshot()
    ): ClientRectLike => ({
      x: stageTransform.pos.x + bounds.x * stageTransform.scale,
      y: stageTransform.pos.y + bounds.y * stageTransform.scale,
      width: Math.max(1, Math.abs(bounds.width * stageTransform.scale)),
      height: Math.max(1, Math.abs(bounds.height * stageTransform.scale))
    }),
    [getLiveStageSnapshot]
  )

  const isActiveSelectedGroup = React.useCallback(
    (group: SelectionOverlayGroup | null | undefined) => {
      if (!group) {
        return false
      }

      if (exactSelectedGroup?.id === group.id) {
        return true
      }

      if (selectedIds.size === 0 || group.itemIds.length !== selectedIds.size) {
        return false
      }

      return group.itemIds.every((itemId) => selectedIds.has(itemId))
    },
    [exactSelectedGroup?.id, selectedIds]
  )

  const resolveGroupChipAnchorBounds = React.useCallback(
    (group: SelectionOverlayGroup): SelectionBounds => {
      if (!isActiveSelectedGroup(group)) {
        return group.bounds
      }

      if (liveMultiSelectionBounds) {
        return liveMultiSelectionBounds
      }

      const selectedCanvasBounds = getCanvasItemsBounds(selectedItemsRef.current)
      if (selectedCanvasBounds) {
        return {
          x: selectedCanvasBounds.minX,
          y: selectedCanvasBounds.minY,
          width: Math.max(selectedCanvasBounds.maxX - selectedCanvasBounds.minX, 1),
          height: Math.max(selectedCanvasBounds.maxY - selectedCanvasBounds.minY, 1)
        }
      }

      return group.bounds
    },
    [isActiveSelectedGroup, liveMultiSelectionBounds]
  )

  const getGroupChipLayouts = React.useCallback((): GroupChipLayout[] => {
    const container = portalHost ?? canvasContainerRef.current
    const containerRect = container?.getBoundingClientRect()
    const { pos, scale } = getLiveStageSnapshot()
    const viewportWidth = container?.clientWidth ?? stageSize.width
    const viewportHeight = container?.clientHeight ?? stageSize.height

    return liveSelectionOverlayGroups.map((group) => {
      const chipElement = container?.querySelector(
        `[data-canvas-group-chip-id="${group.id}"]`
      ) as HTMLElement | null

      if (chipElement && containerRect) {
        const chipRect = chipElement.getBoundingClientRect()
        const elementScale = Number(chipElement.dataset.canvasGroupChipScale)
        const resolvedScale =
          Number.isFinite(elementScale) && elementScale > 0
            ? elementScale
            : getGroupChipVisualScale(scale)
        const elementContentWidth = Number(chipElement.dataset.canvasGroupChipBaseWidth)
        return {
          contentWidth:
            Number.isFinite(elementContentWidth) && elementContentWidth > 0
              ? elementContentWidth
              : chipRect.width / resolvedScale,
          id: group.id,
          placement:
            (chipElement.dataset.canvasGroupChipPlacement as GroupChipPlacement | undefined) ??
            'default',
          scale: resolvedScale,
          x: chipRect.left - containerRect.left,
          y: chipRect.top - containerRect.top,
          width: chipRect.width,
          height: chipRect.height
        }
      }

      return resolveDefaultGroupChipLayout({
        bounds: resolveGroupChipAnchorBounds(group),
        id: group.id,
        name: group.name,
        stagePos: pos,
        stageScale: scale,
        viewportHeight,
        viewportWidth
      })
    })
  }, [
    canvasContainerRef,
    getLiveStageSnapshot,
    liveSelectionOverlayGroups,
    portalHost,
    resolveGroupChipAnchorBounds,
    stageSize.height,
    stageSize.width
  ])

  const resolveItemClientRect = React.useCallback(
    (item: CanvasItem, stage: StageLike | null | undefined): ClientRectLike => {
      const overlayRect = getOverlayClientRect(item)
      if (hasRenderableClientRect(overlayRect)) {
        return overlayRect
      }

      const stageRect = stage?.findOne?.(`#${item.id}`)?.getClientRect?.()
      if (hasRenderableClientRect(stageRect)) {
        return stageRect
      }

      return getFallbackClientRect(item)
    },
    [getFallbackClientRect, getOverlayClientRect, hasRenderableClientRect]
  )

  const buildToolbarAvoidRects = React.useCallback(
    (
      stage: StageLike | null | undefined,
      options: {
        excludedItemIds?: ReadonlySet<string>
        excludedGroupChipIds?: ReadonlySet<string>
        includeGroupChips?: boolean
        protectedItemTypes?: ReadonlySet<CanvasItem['type']>
      } = {}
    ) => {
      const excludedItemIds = options.excludedItemIds ?? new Set<string>()
      const excludedGroupChipIds = options.excludedGroupChipIds ?? new Set<string>()
      const protectedItemTypes = options.protectedItemTypes ?? null
      const itemRects = items
        .filter(
          (item) =>
            !excludedItemIds.has(item.id) &&
            (!protectedItemTypes || protectedItemTypes.has(item.type))
        )
        .map((item) => resolveItemClientRect(item, stage))
        .filter(hasRenderableClientRect)

      const groupChipRects =
        options.includeGroupChips === false
          ? []
          : getGroupChipLayouts().filter((layout) => !excludedGroupChipIds.has(layout.id))

      return [...itemRects, ...groupChipRects].filter(hasRenderableClientRect).map((rect) => ({
        minX: rect.x,
        minY: rect.y,
        maxX: rect.x + rect.width,
        maxY: rect.y + rect.height
      }))
    },
    [getGroupChipLayouts, hasRenderableClientRect, items, resolveItemClientRect]
  )

  const getFloatingToolbarPosition = React.useCallback(
    (
      clientRect: ClientRectLike,
      options: {
        ownerId: string
        stage: StageLike | null | undefined
        preferredPlacement?: 'auto' | 'above' | 'below'
        toolbarKind: SelectionToolbarKind
      }
    ) => {
      const protectedRects = buildToolbarAvoidRects(options.stage, {
        excludedItemIds: new Set([options.ownerId]),
        includeGroupChips: false,
        protectedItemTypes: new Set<CanvasItem['type']>(['annotation', 'text'])
      })

      return resolveSelectionActionToolbarPosition(
        {
          minX: clientRect.x,
          minY: clientRect.y,
          maxX: clientRect.x + clientRect.width,
          maxY: clientRect.y + clientRect.height
        },
        getViewportSize(),
        {
          avoidRects: protectedRects,
          lockHorizontalAnchor: true,
          preferredPlacement: options.preferredPlacement ?? 'auto',
          toolbarHeight: SELECTION_TOOLBAR_SIZE_ESTIMATES[options.toolbarKind].height,
          toolbarWidth: SELECTION_TOOLBAR_SIZE_ESTIMATES[options.toolbarKind].width
        }
      )
    },
    [buildToolbarAvoidRects, getViewportSize]
  )

  const syncToolbarPosition = React.useCallback(
    (
      item: CanvasItem | null,
      toolbar: HTMLDivElement | null,
      options: {
        preferredPlacement?: 'auto' | 'above' | 'below'
        toolbarKind: SelectionToolbarKind
      }
    ) => {
      if (!item || !toolbar) {
        return
      }

      const stage = stageRef.current?.getStage?.()
      const clientRect = resolveItemClientRect(item, stage)
      if (!hasRenderableClientRect(clientRect)) {
        return
      }

      const toolbarPosition = getFloatingToolbarPosition(clientRect, {
        ownerId: item.id,
        preferredPlacement: options.preferredPlacement,
        stage,
        toolbarKind: options.toolbarKind
      })

      toolbar.style.left = `${toolbarPosition.left}px`
      toolbar.style.top = `${toolbarPosition.top}px`
    },
    [getFloatingToolbarPosition, hasRenderableClientRect, resolveItemClientRect, stageRef]
  )

  const {
    selectedItems,
    selectedSingleBlobItem,
    selectedSingleFileItem,
    selectedSingleImageItem,
    selectedSingleTextLikeItem
  } = React.useMemo(() => {
    if (suppressSelectionChrome) {
      return {
        selectedItems: [] as CanvasItem[],
        selectedSingleBlobItem: null,
        selectedSingleFileItem: null,
        selectedSingleImageItem: null,
        selectedSingleTextLikeItem: null
      }
    }

    const nextSelectedItems: CanvasItem[] = []

    for (const item of items) {
      if (!selectedIds.has(item.id)) {
        continue
      }

      nextSelectedItems.push(item)
    }

    const selectedSingleItem =
      tool === 'select' && selectedIds.size === 1 ? (nextSelectedItems[0] ?? null) : null

    return {
      selectedItems: nextSelectedItems,
      selectedSingleBlobItem:
        selectedSingleItem &&
        (selectedSingleItem.type === 'model3d' || selectedSingleItem.type === 'video')
          ? (selectedSingleItem as CanvasModel3DItem | CanvasVideoItem)
          : null,
      selectedSingleFileItem:
        selectedSingleItem?.type === 'file' ? (selectedSingleItem as CanvasFileItem) : null,
      selectedSingleImageItem:
        selectedSingleItem?.type === 'image' ? (selectedSingleItem as CanvasImageItem) : null,
      selectedSingleTextLikeItem:
        selectedSingleItem &&
        (selectedSingleItem.type === 'text' || selectedSingleItem.type === 'annotation')
          ? (selectedSingleItem as CanvasTextItem | CanvasAnnotationItem)
          : null
    }
  }, [items, selectedIds, suppressSelectionChrome, tool])
  selectedItemsRef.current = selectedItems

  React.useLayoutEffect(() => {
    if (!selectedSingleImageItem || tool !== 'select') {
      return
    }

    syncToolbarPosition(selectedSingleImageItem, imageToolbarRef.current, {
      preferredPlacement: 'above',
      toolbarKind: 'image'
    })
    const frameId = window.requestAnimationFrame(() => {
      syncToolbarPosition(selectedSingleImageItem, imageToolbarRef.current, {
        preferredPlacement: 'above',
        toolbarKind: 'image'
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [selectedSingleImageItem, syncToolbarPosition, tool])

  React.useLayoutEffect(() => {
    if (!selectedSingleBlobItem || tool !== 'select') {
      return
    }

    syncToolbarPosition(selectedSingleBlobItem, blobToolbarRef.current, {
      toolbarKind: 'blob'
    })
    const frameId = window.requestAnimationFrame(() => {
      syncToolbarPosition(selectedSingleBlobItem, blobToolbarRef.current, {
        toolbarKind: 'blob'
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [selectedSingleBlobItem, syncToolbarPosition, tool])

  React.useLayoutEffect(() => {
    if (!selectedSingleTextLikeItem || tool !== 'select') {
      return
    }

    syncToolbarPosition(selectedSingleTextLikeItem, textToolbarRef.current, {
      preferredPlacement: 'below',
      toolbarKind: 'textlike'
    })
    const frameId = window.requestAnimationFrame(() => {
      syncToolbarPosition(selectedSingleTextLikeItem, textToolbarRef.current, {
        preferredPlacement: 'below',
        toolbarKind: 'textlike'
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [selectedSingleTextLikeItem, syncToolbarPosition, tool])

  React.useLayoutEffect(() => {
    if (!selectedSingleFileItem || tool !== 'select') {
      return
    }

    syncToolbarPosition(selectedSingleFileItem, fileToolbarRef.current, {
      preferredPlacement: 'below',
      toolbarKind: 'file'
    })
    const frameId = window.requestAnimationFrame(() => {
      syncToolbarPosition(selectedSingleFileItem, fileToolbarRef.current, {
        preferredPlacement: 'below',
        toolbarKind: 'file'
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [selectedSingleFileItem, syncToolbarPosition, tool])

  const syncSingleSelectionToolbars = React.useCallback(() => {
    if (tool !== 'select') {
      return
    }

    syncToolbarPosition(selectedSingleImageItem, imageToolbarRef.current, {
      preferredPlacement: 'above',
      toolbarKind: 'image'
    })
    syncToolbarPosition(selectedSingleBlobItem, blobToolbarRef.current, {
      toolbarKind: 'blob'
    })
    syncToolbarPosition(selectedSingleTextLikeItem, textToolbarRef.current, {
      preferredPlacement: 'below',
      toolbarKind: 'textlike'
    })
    syncToolbarPosition(selectedSingleFileItem, fileToolbarRef.current, {
      preferredPlacement: 'below',
      toolbarKind: 'file'
    })
  }, [
    selectedSingleBlobItem,
    selectedSingleFileItem,
    selectedSingleImageItem,
    selectedSingleTextLikeItem,
    syncToolbarPosition,
    tool
  ])

  const selectedBlobItemVideoBudgetMode =
    selectedSingleBlobItem?.type === 'video'
      ? (resolvedVideoBudgetModeById?.get(selectedSingleBlobItem.id) ??
        (selectedSingleBlobItem.playing ? 'active-playing' : 'visible-paused'))
      : null
  const selectedBlobItemVideoIsActivelyPlaying =
    selectedBlobItemVideoBudgetMode === 'active-playing'

  const quickDragPreviewItems = React.useMemo(() => {
    if (tool !== 'select') return [] as CanvasItem[]

    if (selectedIds.size > 1) {
      return selectedItems
    }

    if (!selectedSingleTextLikeItem) {
      return [] as CanvasItem[]
    }

    return [selectedSingleTextLikeItem]
  }, [selectedIds.size, selectedItems, selectedSingleTextLikeItem, tool])

  React.useEffect(() => {
    if (quickDragPreviewItems.length === 0) return
    void prepareQuickCanvasItemsImageUrl(quickDragPreviewItems)
  }, [prepareQuickCanvasItemsImageUrl, quickDragPreviewItems])

  const fallbackExactSelectedLiveGroup = React.useMemo(
    () => liveSelectionOverlayGroups.find((group) => isActiveSelectedGroup(group)) ?? null,
    [isActiveSelectedGroup, liveSelectionOverlayGroups]
  )

  const exactSelectedLiveGroup = React.useMemo(
    () =>
      exactSelectedGroup
        ? (liveSelectionOverlayGroups.find((group) => group.id === exactSelectedGroup.id) ??
          exactSelectedGroup)
        : fallbackExactSelectedLiveGroup,
    [exactSelectedGroup, fallbackExactSelectedLiveGroup, liveSelectionOverlayGroups]
  )

  const resolveMultiSelectionLayout = React.useCallback(
    (stageTransform: { pos: StagePosition; scale: number } = getLiveStageSnapshot()) => {
      if (selectedIds.size <= 1 || tool !== 'select') return null

      const stage = stageRef.current?.getStage?.()
      if (selectedItems.length === 0) return null

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let hasVisible = false

      const liveSelectionClientRect = liveMultiSelectionBounds
        ? scaleCanvasBoundsToClientRect(liveMultiSelectionBounds, stageTransform)
        : null

      if (hasRenderableClientRect(liveSelectionClientRect)) {
        hasVisible = true
        minX = liveSelectionClientRect.x
        minY = liveSelectionClientRect.y
        maxX = liveSelectionClientRect.x + liveSelectionClientRect.width
        maxY = liveSelectionClientRect.y + liveSelectionClientRect.height
      } else {
        const canvasBounds = getCanvasItemsBounds(selectedItems)
        if (!canvasBounds) return null

        const selectionClientRect = scaleCanvasBoundsToClientRect(
          {
            x: canvasBounds.minX,
            y: canvasBounds.minY,
            width: canvasBounds.maxX - canvasBounds.minX,
            height: canvasBounds.maxY - canvasBounds.minY
          },
          stageTransform
        )

        if (hasRenderableClientRect(selectionClientRect)) {
          hasVisible = true
          minX = selectionClientRect.x
          minY = selectionClientRect.y
          maxX = selectionClientRect.x + selectionClientRect.width
          maxY = selectionClientRect.y + selectionClientRect.height
        }
      }

      if (!hasVisible || maxX === -Infinity) return null

      const toolbarKind: SelectionToolbarKind = exactSelectedLiveGroup ? 'group' : 'multi'
      const selectionActionStackPosition = resolveSelectionActionToolbarPosition(
        { minX, minY, maxX, maxY },
        getViewportSize(),
        {
          avoidRects: buildToolbarAvoidRects(stage, {
            excludedItemIds: selectedIds,
            excludedGroupChipIds: exactSelectedLiveGroup
              ? new Set<string>([exactSelectedLiveGroup.id])
              : undefined,
            includeGroupChips: false,
            protectedItemTypes: new Set<CanvasItem['type']>([
              'annotation',
              'file',
              'html',
              'image',
              'model3d',
              'text',
              'video'
            ])
          }),
          lockHorizontalAnchor: true,
          preferredPlacement: 'above',
          toolbarHeight: SELECTION_TOOLBAR_SIZE_ESTIMATES[toolbarKind].height,
          toolbarWidth: SELECTION_TOOLBAR_SIZE_ESTIMATES[toolbarKind].width
        }
      )

      return {
        selectionActionStackPosition,
        toolbarKind
      }
    },
    [
      buildToolbarAvoidRects,
      exactSelectedLiveGroup,
      getLiveStageSnapshot,
      getViewportSize,
      hasRenderableClientRect,
      liveMultiSelectionBounds,
      scaleCanvasBoundsToClientRect,
      selectedIds,
      selectedItems,
      stageRef,
      tool
    ]
  )

  const multiSelectionLayout = React.useMemo(
    () => resolveMultiSelectionLayout(),
    [resolveMultiSelectionLayout]
  )

  const resolveRenderedGroupChipLayout = React.useCallback(
    (
      group: SelectionOverlayGroup,
      stageTransform: { pos: StagePosition; scale: number } = getLiveStageSnapshot()
    ): GroupChipLayout => {
      const viewportSize = getViewportSize()
      const currentMultiSelectionLayout = resolveMultiSelectionLayout(stageTransform)
      const defaultLayout = resolveDefaultGroupChipLayout({
        bounds: resolveGroupChipAnchorBounds(group),
        id: group.id,
        name: group.name,
        stagePos: stageTransform.pos,
        stageScale: stageTransform.scale,
        viewportHeight: viewportSize.height,
        viewportWidth: viewportSize.width
      })
      const toolbarMetrics = currentMultiSelectionLayout
        ? SELECTION_TOOLBAR_SIZE_ESTIMATES[currentMultiSelectionLayout.toolbarKind]
        : null

      return exactSelectedLiveGroup?.id === group.id &&
        currentMultiSelectionLayout &&
        toolbarMetrics &&
        defaultLayout.y <= GROUP_CHIP_MARGIN + 0.5
        ? resolveAdaptiveExactGroupChipLayout({
            defaultLayout,
            toolbarHeight: toolbarMetrics.height,
            toolbarLeft: currentMultiSelectionLayout.selectionActionStackPosition.left,
            toolbarTop: currentMultiSelectionLayout.selectionActionStackPosition.top,
            toolbarWidth: toolbarMetrics.width,
            viewportHeight: viewportSize.height,
            viewportWidth: viewportSize.width
          })
        : defaultLayout
    },
    [
      exactSelectedLiveGroup?.id,
      getLiveStageSnapshot,
      getViewportSize,
      resolveMultiSelectionLayout,
      resolveGroupChipAnchorBounds
    ]
  )

  const syncGroupChipPositions = React.useCallback(() => {
    if (tool !== 'select') {
      return
    }

    const container = portalHost ?? canvasContainerRef.current
    if (!container) {
      return
    }

    const stageTransform = getLiveStageSnapshot()

    liveSelectionOverlayGroups.forEach((group) => {
      const chipElement = container.querySelector(
        `[data-canvas-group-chip-id="${group.id}"]`
      ) as HTMLElement | null

      if (!chipElement) {
        return
      }

      const chipLayout = resolveRenderedGroupChipLayout(group, stageTransform)
      chipElement.style.left = `${chipLayout.x}px`
      chipElement.style.top = `${chipLayout.y}px`
      chipElement.style.width = `${chipLayout.width}px`
      chipElement.style.height = `${chipLayout.height}px`
      chipElement.style.setProperty('--canvas-group-chip-scale', `${chipLayout.scale}`)
      chipElement.dataset.canvasGroupChipPlacement = chipLayout.placement
    })
  }, [
    canvasContainerRef,
    getLiveStageSnapshot,
    liveSelectionOverlayGroups,
    portalHost,
    resolveRenderedGroupChipLayout,
    tool
  ])

  const syncMultiSelectionToolbarPosition = React.useCallback(() => {
    if (tool !== 'select') {
      return
    }

    const container = portalHost ?? canvasContainerRef.current
    if (!container) {
      return
    }

    const toolbar = container.querySelector(
      '.group-action-toolbar, .selection-action-stack'
    ) as HTMLDivElement | null
    if (!toolbar) {
      return
    }

    const nextLayout = resolveMultiSelectionLayout()
    if (!nextLayout) {
      return
    }

    toolbar.style.left = `${nextLayout.selectionActionStackPosition.left}px`
    toolbar.style.top = `${nextLayout.selectionActionStackPosition.top}px`
    toolbar.style.zIndex = '130'
  }, [canvasContainerRef, portalHost, resolveMultiSelectionLayout, tool])

  const syncViewportChrome = React.useCallback(
    (options: { force?: boolean } = {}) => {
      if (viewportInteractionActiveRef.current && !options.force) {
        pendingViewportChromeSyncRef.current = true
        return
      }

      pendingViewportChromeSyncRef.current = false
      syncSingleSelectionToolbars()
      syncMultiSelectionToolbarPosition()
      syncGroupChipPositions()
    },
    [syncGroupChipPositions, syncMultiSelectionToolbarPosition, syncSingleSelectionToolbars]
  )

  const scheduleDeferredViewportChromeSync = React.useCallback(() => {
    if (deferredViewportChromeSyncFrameRef.current !== null) {
      return
    }

    deferredViewportChromeSyncFrameRef.current = window.requestAnimationFrame(() => {
      deferredViewportChromeSyncFrameRef.current = null
      syncViewportChrome({ force: true })
    })
  }, [syncViewportChrome])

  React.useEffect(() => {
    if (!registerViewportCallback) {
      return
    }

    const dispose = registerViewportCallback(() => {
      syncViewportChrome()
    })

    return typeof dispose === 'function' ? dispose : undefined
  }, [registerViewportCallback, syncViewportChrome])

  React.useEffect(() => {
    if (!registerViewportInteractionCallback) {
      return
    }

    const dispose = registerViewportInteractionCallback((active) => {
      viewportInteractionActiveRef.current = active
      if (!active && pendingViewportChromeSyncRef.current) {
        scheduleDeferredViewportChromeSync()
      }
    })

    return typeof dispose === 'function' ? dispose : undefined
  }, [registerViewportInteractionCallback, scheduleDeferredViewportChromeSync])

  React.useEffect(() => {
    return () => {
      if (deferredViewportChromeSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(deferredViewportChromeSyncFrameRef.current)
        deferredViewportChromeSyncFrameRef.current = null
      }
    }
  }, [])

  React.useLayoutEffect(() => {
    if (tool !== 'select' || liveSelectionOverlayGroups.length === 0) {
      return
    }

    syncMultiSelectionToolbarPosition()
    syncGroupChipPositions()
    const frameId = window.requestAnimationFrame(() => {
      syncMultiSelectionToolbarPosition()
      syncGroupChipPositions()
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [
    liveMultiSelectionBounds,
    liveSelectionOverlayGroups,
    selectedItems,
    syncGroupChipPositions,
    syncMultiSelectionToolbarPosition,
    tool
  ])

  const renderGroupChips = () => {
    if (suppressSelectionChrome) return null
    if (tool !== 'select') return null

    return liveSelectionOverlayGroups.map((group) => {
      const chipLayout = resolveRenderedGroupChipLayout(group)

      return (
        <Box
          key={`group-chip-${group.id}`}
          data-canvas-group-chip-id={group.id}
          data-canvas-group-chip-base-width={chipLayout.contentWidth}
          data-canvas-group-chip-placement={chipLayout.placement}
          data-canvas-overlay="group-chip"
          data-canvas-group-chip-scale={chipLayout.scale}
          sx={{
            '--canvas-group-chip-scale': chipLayout.scale,
            position: 'absolute',
            left: chipLayout.x,
            top: chipLayout.y,
            width: chipLayout.width,
            height: chipLayout.height,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            pointerEvents: 'auto',
            zIndex: 140
          }}
          onPointerDownCapture={stopCanvasToolbarPointerPropagation}
          onMouseDownCapture={stopCanvasToolbarPointerPropagation}
          onTouchStartCapture={stopCanvasToolbarPointerPropagation}
        >
          <Box
            onClick={() => handleFocusGroup(group)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              boxSizing: 'border-box',
              height: GROUP_CHIP_HEIGHT_ESTIMATE,
              gap: 0.75,
              px: 1.25,
              py: 0.75,
              borderRadius: 999,
              bgcolor: isActiveSelectedGroup(group)
                ? 'rgba(34,197,94,0.16)'
                : 'rgba(15,23,42,0.82)',
              border: '1px solid',
              borderColor: isActiveSelectedGroup(group) ? 'rgba(34,197,94,0.45)' : '#60a5fa',
              color: '#f8fafc',
              boxShadow: '0 6px 18px rgba(15,23,42,0.28)',
              cursor: 'pointer',
              maxWidth: chipLayout.contentWidth,
              transform: 'scale(var(--canvas-group-chip-scale, 1))',
              transformOrigin: 'top left',
              width: chipLayout.contentWidth
            }}
          >
            <LayersOutlinedIcon sx={{ fontSize: 16, color: 'inherit', flexShrink: 0 }} />
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                color: 'inherit',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {group.name}
            </Typography>
          </Box>
        </Box>
      )
    })
  }

  const renderImageActionToolbar = () => {
    if (suppressSelectionChrome) return null
    if (!selectedSingleImageItem || tool !== 'select') return null

    const stage = stageRef.current?.getStage?.()
    const selectedImg = selectedSingleImageItem

    const clientRect = resolveItemClientRect(selectedImg, stage)
    const toolbarPosition = getFloatingToolbarPosition(clientRect, {
      ownerId: selectedImg.id,
      preferredPlacement: 'above',
      stage,
      toolbarKind: 'image'
    })

    return (
      <Box
        ref={imageToolbarRef}
        className="image-action-toolbar"
        data-selection-toolbar-height-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.image.height}
        data-selection-toolbar-owner-id={selectedImg.id}
        data-selection-toolbar-preferred-placement="above"
        data-selection-toolbar-width-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.image.width}
        sx={{
          position: 'absolute',
          left: toolbarPosition.left,
          top: toolbarPosition.top,
          transform: 'translate(-50%, 0)',
          display: 'flex',
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          border: '1px solid',
          borderColor: 'divider',
          pointerEvents: 'auto',
          zIndex: 100,
          p: 0.5,
          gap: 0.5
        }}
        onPointerDownCapture={stopCanvasToolbarPointerPropagation}
        onMouseDownCapture={stopCanvasToolbarPointerPropagation}
        onTouchStartCapture={stopCanvasToolbarPointerPropagation}
      >
        <Tooltip title={'\u62d6\u62fd\u63d0\u53d6\u8d44\u6e90'}>
          <IconButton
            className="canvas-image-drag-button"
            size="small"
            draggable
            onDragStart={(event) => {
              setCanvasDragPayload(
                event.dataTransfer,
                buildCanvasDragPayload([selectedImg], {
                  objectUrl: selectedImg.src || '',
                  promptId: (selectedImg as CanvasImageItem & { promptId?: string }).promptId
                })
              )
            }}
            sx={{ cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
          >
            <DragIndicatorIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u6c34\u5e73\u7ffb\u8f6c\u56fe\u7247'}>
          <IconButton
            className="canvas-image-flip-button"
            size="small"
            onClick={() => handleFlipImage(selectedImg)}
          >
            <FlipIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u88c1\u526a\u56fe\u7247'}>
          <IconButton
            className="canvas-image-crop-button"
            size="small"
            onClick={() => handleCropImage(selectedImg)}
          >
            <CropIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={i18n.resolvedLanguage?.startsWith('zh') ? '提取元素' : 'Extract element'}>
          <IconButton size="small" onClick={() => void handleImageExtractAction(selectedImg)}>
            <FilterCenterFocusIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />
        <Tooltip title="复制该图片">
          <IconButton size="small" onClick={() => handleCopyCanvasImage(selectedImg)}>
            <ContentCopy fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="下载该图片">
          <IconButton size="small" onClick={() => handleDownloadCanvasImage(selectedImg)}>
            <Download fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="发送到外部设计软件">
          <IconButton
            size="small"
            onClick={(event) => handleOpenAgentSendMenu(event.currentTarget, [selectedImg])}
          >
            <SendIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={mediaCaptionActionLabel}>
          <IconButton
            size="small"
            onClick={() => handleOpenMediaCaptionEditor(selectedImg)}
            aria-label={mediaCaptionActionLabel}
          >
            <Typography
              component="span"
              sx={{
                fontWeight: 700,
                fontSize: 20,
                lineHeight: 1,
                display: 'block'
              }}
            >
              T
            </Typography>
          </IconButton>
        </Tooltip>
        <Tooltip title="将该素材作为上下文发给 Agent">
          <IconButton size="small" onClick={() => void handleSendCanvasItemsToAgent([selectedImg])}>
            <ChatBubbleOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    )
  }

  const renderBlobItemActionToolbar = () => {
    if (suppressSelectionChrome) return null
    if (!selectedSingleBlobItem || tool !== 'select') return null

    const stage = stageRef.current?.getStage?.()
    const selectedBlobItem = selectedSingleBlobItem

    const clientRect = resolveItemClientRect(selectedBlobItem, stage)
    const toolbarPosition = getFloatingToolbarPosition(clientRect, {
      ownerId: selectedBlobItem.id,
      stage,
      toolbarKind: 'blob'
    })

    return (
      <Box
        ref={blobToolbarRef}
        className="blob-item-action-toolbar"
        data-selection-toolbar-height-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.blob.height}
        data-selection-toolbar-owner-id={selectedBlobItem.id}
        data-selection-toolbar-preferred-placement="auto"
        data-selection-toolbar-width-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.blob.width}
        sx={{
          position: 'absolute',
          left: toolbarPosition.left,
          top: toolbarPosition.top,
          transform: 'translate(-50%, 0)',
          display: 'flex',
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          border: '1px solid',
          borderColor: 'divider',
          pointerEvents: 'auto',
          zIndex: 100,
          p: 0.5,
          gap: 0.5
        }}
        onPointerDownCapture={stopCanvasToolbarPointerPropagation}
        onMouseDownCapture={stopCanvasToolbarPointerPropagation}
        onTouchStartCapture={stopCanvasToolbarPointerPropagation}
      >
        {selectedBlobItem.type === 'model3d' && (
          <Tooltip title={'\u62d6\u62fd\u63d0\u53d6\u8d44\u6e90'}>
            <IconButton
              size="small"
              draggable
              onDragStart={(event) => {
                setCanvasDragPayload(
                  event.dataTransfer,
                  buildCanvasDragPayload([selectedBlobItem], {
                    objectUrl: selectedBlobItem.src,
                    promptId: (selectedBlobItem as CanvasModel3DItem & { promptId?: string })
                      .promptId
                  })
                )
              }}
              sx={{ cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
            >
              <DragIndicatorIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {selectedBlobItem.type === 'video' && (
          <Tooltip title={selectedBlobItemVideoIsActivelyPlaying ? '暂停播放' : '播放视频'}>
            <IconButton
              size="small"
              onClick={() =>
                handleToggleVideoPlayback(selectedBlobItem, !selectedBlobItemVideoIsActivelyPlaying)
              }
            >
              {selectedBlobItemVideoIsActivelyPlaying ? (
                <PauseIcon fontSize="small" />
              ) : (
                <PlayArrowIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        )}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />
        {selectedBlobItem.type === 'model3d' && (
          <Tooltip title="沉浸式查看 3D 模型">
            <IconButton size="small" onClick={() => handleOpenModel3DViewer(selectedBlobItem.id)}>
              <Model3DIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {selectedBlobItem.type === 'model3d' && (
          <Tooltip title="发送到游戏引擎 (Unity/Unreal)">
            <IconButton
              size="small"
              onClick={(event) => handleOpenDccExportMenu(event.currentTarget, selectedBlobItem.id)}
            >
              <ExportIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={selectedBlobItem.type === 'model3d' ? '下载 3D 模型打包文件' : '下载视频'}>
          <IconButton size="small" onClick={() => handleDownloadBlobItem(selectedBlobItem)}>
            <Download fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="复制该素材">
          <IconButton
            size="small"
            onClick={() => void handleCopyCanvasItemsAsImage([selectedBlobItem])}
          >
            <ContentCopy fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={mediaCaptionActionLabel}>
          <IconButton
            size="small"
            onClick={() => handleOpenMediaCaptionEditor(selectedBlobItem)}
            aria-label={mediaCaptionActionLabel}
          >
            <Typography
              component="span"
              sx={{
                fontWeight: 700,
                fontSize: 20,
                lineHeight: 1,
                display: 'block'
              }}
            >
              T
            </Typography>
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u5c06\u8be5\u7d20\u6750\u4f5c\u4e3a\u4e0a\u4e0b\u6587\u53d1\u7ed9 Agent'}>
          <IconButton
            size="small"
            onClick={() => void handleSendCanvasItemsToAgent([selectedBlobItem])}
          >
            <ChatBubbleOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    )
  }

  const renderTextLikeActionToolbar = () => {
    if (suppressSelectionChrome) return null
    if (!selectedSingleTextLikeItem || tool !== 'select') return null

    const stage = stageRef.current?.getStage?.()
    const selectedTextLike = selectedSingleTextLikeItem

    const clientRect = resolveItemClientRect(selectedTextLike, stage)
    const toolbarPosition = getFloatingToolbarPosition(clientRect, {
      ownerId: selectedTextLike.id,
      preferredPlacement: 'below',
      stage,
      toolbarKind: 'textlike'
    })

    return (
      <Box
        ref={textToolbarRef}
        className="textlike-action-toolbar"
        data-selection-toolbar-height-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.textlike.height}
        data-selection-toolbar-owner-id={selectedTextLike.id}
        data-selection-toolbar-preferred-placement="below"
        data-selection-toolbar-width-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.textlike.width}
        sx={{
          position: 'absolute',
          left: toolbarPosition.left,
          top: toolbarPosition.top,
          transform: 'translate(-50%, 0)',
          display: 'flex',
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          border: '1px solid',
          borderColor: 'divider',
          pointerEvents: 'auto',
          zIndex: 100,
          p: 0.5,
          gap: 0.5
        }}
        onPointerDownCapture={stopCanvasToolbarPointerPropagation}
        onMouseDownCapture={stopCanvasToolbarPointerPropagation}
        onTouchStartCapture={stopCanvasToolbarPointerPropagation}
      >
        <Tooltip title={'\u62d6\u62fd\u63d0\u53d6\u8d44\u6e90'}>
          <IconButton
            size="small"
            draggable
            onDragStart={(event) => {
              const objectUrl = getQuickCanvasItemsImageUrl([selectedTextLike])
              const promptId = (
                selectedTextLike as (CanvasTextItem | CanvasAnnotationItem) & {
                  promptId?: string
                }
              ).promptId

              setCanvasDragPayload(
                event.dataTransfer,
                buildCanvasDragPayload([selectedTextLike], {
                  ...(objectUrl
                    ? {
                        objectUrl,
                        previewImageUrl: objectUrl
                      }
                    : {}),
                  ...(promptId ? { promptId } : {})
                })
              )
            }}
            sx={{ cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
          >
            <DragIndicatorIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u590d\u5236\u8be5\u7d20\u6750'}>
          <IconButton
            size="small"
            onClick={() => void handleCopyCanvasItemsAsImage([selectedTextLike])}
          >
            <ContentCopy fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u4e0b\u8f7d\u4e3a\u900f\u660e\u80cc\u666f PNG \u539f\u56fe'}>
          <IconButton
            size="small"
            onClick={() => void handleDownloadCanvasItemsAsImage([selectedTextLike], 'canvas-item')}
          >
            <Download fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={'\u5c06\u8be5\u6587\u672c\u4f5c\u4e3a\u4e0a\u4e0b\u6587\u53d1\u7ed9 Agent'}>
          <IconButton
            size="small"
            onClick={() => void handleSendCanvasItemsToAgent([selectedTextLike])}
          >
            <ChatBubbleOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    )
  }

  const renderFileActionToolbar = () => {
    if (suppressSelectionChrome) return null
    if (!selectedSingleFileItem || tool !== 'select') return null

    const stage = stageRef.current?.getStage?.()
    const selectedFileItem = selectedSingleFileItem
    const exportOptions = getCanvasFileExportOptions(
      selectedFileItem,
      i18n.resolvedLanguage || i18n.language
    )

    const clientRect = resolveItemClientRect(selectedFileItem, stage)
    const toolbarPosition = getFloatingToolbarPosition(clientRect, {
      ownerId: selectedFileItem.id,
      preferredPlacement: 'below',
      stage,
      toolbarKind: 'file'
    })

    return (
      <Box
        ref={fileToolbarRef}
        className="file-item-action-toolbar"
        data-selection-toolbar-height-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.file.height}
        data-selection-toolbar-owner-id={selectedFileItem.id}
        data-selection-toolbar-preferred-placement="below"
        data-selection-toolbar-width-estimate={SELECTION_TOOLBAR_SIZE_ESTIMATES.file.width}
        sx={{
          position: 'absolute',
          left: toolbarPosition.left,
          top: toolbarPosition.top,
          transform: 'translate(-50%, 0)',
          display: 'flex',
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          border: '1px solid',
          borderColor: 'divider',
          pointerEvents: 'auto',
          zIndex: 100,
          p: 0.5,
          gap: 0.5
        }}
        onPointerDownCapture={stopCanvasToolbarPointerPropagation}
        onMouseDownCapture={stopCanvasToolbarPointerPropagation}
        onTouchStartCapture={stopCanvasToolbarPointerPropagation}
      >
        <Tooltip title={fileExportActionLabel}>
          <IconButton
            size="small"
            aria-label={fileExportActionLabel}
            onClick={(event) => {
              if (exportOptions.length <= 1) {
                void handleExportCanvasFile(selectedFileItem, exportOptions[0]?.format)
                return
              }

              setFileExportMenuAnchor(event.currentTarget)
            }}
          >
            <Download fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={fileExportMenuAnchor}
          open={Boolean(fileExportMenuAnchor)}
          onClose={() => setFileExportMenuAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
          {exportOptions.map((option) => (
            <MenuItem
              key={option.format}
              onClick={() => {
                setFileExportMenuAnchor(null)
                void handleExportCanvasFile(selectedFileItem, option.format)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </Menu>
      </Box>
    )
  }

  const renderMultiSelectionOverlay = () => {
    if (suppressSelectionChrome) return null
    if (selectedIds.size <= 1 || tool !== 'select' || !multiSelectionLayout) return null

    return (
      <CanvasMultiSelectionOverlay
        exactSelectedGroup={exactSelectedLiveGroup}
        selectedItems={selectedItems}
        selectionActionStackPosition={multiSelectionLayout.selectionActionStackPosition}
        stagePos={stagePos}
        stageScale={stageScale}
        legacyEnabled={legacySelectionToolbarEnabled}
        groupCreateLabel={groupCreateLabel}
        onDragSelectedItems={(itemsToDrag, dataTransfer) => {
          const objectUrl = getQuickCanvasItemsImageUrl(itemsToDrag)
          if (!objectUrl) return

          setCanvasDragPayload(
            dataTransfer,
            buildCanvasDragPayload(itemsToDrag, {
              objectUrl,
              previewImageUrl: objectUrl
            })
          )
        }}
        onCopySelectedItems={(itemsToCopy) => {
          void handleCopyCanvasItemsAsImage(itemsToCopy)
        }}
        onDownloadSelectedItems={(itemsToDownload, fileName) => {
          void handleDownloadCanvasItemsAsImage(itemsToDownload, fileName)
        }}
        onOpenAgentSendMenu={(anchor, itemsToSend) => {
          handleOpenAgentSendMenu(anchor, itemsToSend)
        }}
        onChatSelectedItems={(itemsToChat) => {
          void handleSendCanvasItemsToAgent(itemsToChat)
        }}
        onGenerateSelectedItems={(itemsToGenerate) => {
          void handleGenerateCanvasItems(itemsToGenerate)
        }}
        onCreateGroup={() => {
          handleCreateGroup()
        }}
      />
    )
  }

  const overlay = (
    <Box
      data-project-canvas-selection-overlays="true"
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'hidden',
        '[data-project-canvas-marquee-active="true"] &': {
          display: 'none'
        }
      }}
    >
      {renderGroupChips()}
      {renderImageActionToolbar()}
      {renderBlobItemActionToolbar()}
      {renderTextLikeActionToolbar()}
      {renderFileActionToolbar()}
      {renderMultiSelectionOverlay()}
    </Box>
  )

  if (!portalHost) {
    return null
  }

  return createPortal(overlay, portalHost)
}
