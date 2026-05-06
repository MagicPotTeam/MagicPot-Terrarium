import React from 'react'

import type { CanvasExportBounds } from './groupPlaybackUtils'
import { findCanvasItemOverlayElement } from './canvasDomOverlayLookup'
import { getCanvasItemBounds } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

export const CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT = 'canvas:live-visual-bounds-change'
const CANVAS_LIVE_BOUNDS_MIN_REVISION_INTERVAL_MS = 32
const CANVAS_LIVE_BOUNDS_MAX_DEFERRED_FRAMES = 3

type CanvasViewportRect = {
  left: number
  top: number
}

type StageNodeLike = {
  getClientRect?: () => CanvasExportBounds
}

type StageLike = {
  findOne?: (selector: string) => StageNodeLike | null | undefined
}

type StageRefLike = {
  getStage?: () => StageLike | null
}

type SelectionOverlayGroupLike = {
  id: string
  bounds: CanvasExportBounds
  validItems: CanvasItem[]
}

type LiveBoundsChangeDetail = {
  itemIds?: string[]
}

export function dispatchCanvasLiveVisualBoundsChange(itemIds?: string[]) {
  window.dispatchEvent(
    new CustomEvent<LiveBoundsChangeDetail>(CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT, {
      detail: itemIds && itemIds.length > 0 ? { itemIds } : undefined
    })
  )
}

function getOverlayStageRect(
  canvasContainer: HTMLDivElement | null,
  item: CanvasItem,
  getContainerRect?: () => CanvasViewportRect | null
): CanvasExportBounds | null {
  if (!canvasContainer) return null

  const element = findCanvasItemOverlayElement(canvasContainer, item)
  if (!element) return null

  const containerRect = getContainerRect?.() ?? canvasContainer.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()

  return {
    x: elementRect.left - containerRect.left,
    y: elementRect.top - containerRect.top,
    width: elementRect.width,
    height: elementRect.height
  }
}

function stageRectToCanvasBounds(
  rect: CanvasExportBounds,
  stagePos: { x: number; y: number },
  stageScale: number
): CanvasExportBounds {
  const scale = Math.max(Math.abs(stageScale), 0.0001)
  return {
    x: (rect.x - stagePos.x) / scale,
    y: (rect.y - stagePos.y) / scale,
    width: rect.width / scale,
    height: rect.height / scale
  }
}

function getCanvasItemVisualBounds(
  item: CanvasItem,
  options: {
    canvasContainer: HTMLDivElement | null
    getOverlayContainerRect?: () => CanvasViewportRect | null
    stagePos: { x: number; y: number }
    stageRef: React.RefObject<StageRefLike | null>
    stageScale: number
  }
): CanvasExportBounds | null {
  const { canvasContainer, stagePos, stageRef, stageScale } = options

  if (
    item.type === 'image' ||
    item.type === 'video' ||
    item.type === 'model3d' ||
    item.type === 'html'
  ) {
    const overlayRect = getOverlayStageRect(canvasContainer, item, options.getOverlayContainerRect)
    if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
      return stageRectToCanvasBounds(overlayRect, stagePos, stageScale)
    }
  }

  const stage = stageRef.current?.getStage?.()
  const nodeRect = stage?.findOne?.(`#${item.id}`)?.getClientRect?.()
  if (nodeRect && nodeRect.width > 0 && nodeRect.height > 0) {
    return stageRectToCanvasBounds(nodeRect, stagePos, stageScale)
  }

  const fallback = getCanvasItemBounds(item)
  return {
    x: fallback.minX,
    y: fallback.minY,
    width: Math.max(1, fallback.maxX - fallback.minX),
    height: Math.max(1, fallback.maxY - fallback.minY)
  }
}

function getCanvasItemsVisualBounds(
  items: CanvasItem[],
  options: {
    canvasContainer: HTMLDivElement | null
    stagePos: { x: number; y: number }
    stageRef: React.RefObject<StageRefLike | null>
    stageScale: number
  }
): CanvasExportBounds | null {
  if (items.length === 0) return null

  let overlayContainerRect: CanvasViewportRect | null | undefined
  const getOverlayContainerRect = () => {
    if (overlayContainerRect !== undefined) {
      return overlayContainerRect
    }

    const canvasContainer = options.canvasContainer
    if (!canvasContainer) {
      overlayContainerRect = null
      return null
    }

    const rect = canvasContainer.getBoundingClientRect()
    overlayContainerRect = {
      left: rect.left,
      top: rect.top
    }
    return overlayContainerRect
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const visualBoundsOptions = {
    ...options,
    getOverlayContainerRect
  }

  for (const item of items) {
    const bounds = getCanvasItemVisualBounds(item, visualBoundsOptions)
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  }
}

export function useLiveSelectionOverlayGroups<TGroup extends SelectionOverlayGroupLike>(options: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  selectionOverlayGroups: TGroup[]
  stagePos: { x: number; y: number }
  stageRef: React.RefObject<StageRefLike | null>
  stageScale: number
}) {
  const { canvasContainerRef, selectionOverlayGroups, stagePos, stageRef, stageScale } = options
  const [revision, setRevision] = React.useState(0)
  const scheduledFrameRef = React.useRef<number | null>(null)
  const lastRevisionAtRef = React.useRef(Number.NEGATIVE_INFINITY)
  const deferredRevisionFrameCountRef = React.useRef(0)

  const trackedItemIds = React.useMemo(
    () =>
      new Set(selectionOverlayGroups.flatMap((group) => group.validItems.map((item) => item.id))),
    [selectionOverlayGroups]
  )

  React.useEffect(() => {
    const commitRevision = (timestamp: number) => {
      const now = Number.isFinite(timestamp) ? timestamp : performance.now()
      scheduledFrameRef.current = null

      if (
        now - lastRevisionAtRef.current < CANVAS_LIVE_BOUNDS_MIN_REVISION_INTERVAL_MS &&
        deferredRevisionFrameCountRef.current < CANVAS_LIVE_BOUNDS_MAX_DEFERRED_FRAMES
      ) {
        deferredRevisionFrameCountRef.current += 1
        scheduledFrameRef.current = window.requestAnimationFrame(commitRevision)
        return
      }

      deferredRevisionFrameCountRef.current = 0
      lastRevisionAtRef.current = now
      setRevision((current) => current + 1)
    }

    const scheduleRevision = () => {
      if (scheduledFrameRef.current !== null) return

      scheduledFrameRef.current = window.requestAnimationFrame(commitRevision)
    }

    const handleLiveBoundsChange = (event: Event) => {
      if (trackedItemIds.size === 0) return

      const detail = (event as CustomEvent<LiveBoundsChangeDetail>).detail
      const changedItemIds = detail?.itemIds
      if (
        Array.isArray(changedItemIds) &&
        changedItemIds.length > 0 &&
        !changedItemIds.some((itemId) => trackedItemIds.has(itemId))
      ) {
        return
      }

      scheduleRevision()
    }

    window.addEventListener(CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT, handleLiveBoundsChange)
    return () => {
      window.removeEventListener(CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT, handleLiveBoundsChange)
      if (scheduledFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledFrameRef.current)
        scheduledFrameRef.current = null
      }
      deferredRevisionFrameCountRef.current = 0
    }
  }, [trackedItemIds])

  return React.useMemo(
    () =>
      selectionOverlayGroups.map((group) => {
        const liveBounds = getCanvasItemsVisualBounds(group.validItems, {
          canvasContainer: canvasContainerRef.current,
          stagePos,
          stageRef,
          stageScale
        })

        return liveBounds ? { ...group, bounds: liveBounds } : group
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision invalidates cached live DOM measurements.
    [canvasContainerRef, revision, selectionOverlayGroups, stagePos, stageRef, stageScale]
  )
}
