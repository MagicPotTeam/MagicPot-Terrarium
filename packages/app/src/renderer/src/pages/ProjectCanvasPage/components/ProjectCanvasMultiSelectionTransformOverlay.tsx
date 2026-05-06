import React from 'react'
import { Box } from '@mui/material'

import { getCanvasItemBounds, getCanvasItemsBounds } from '../projectCanvasPageShared'
import type { CanvasItem } from '../types'
import { applyMultiDragDeltaToItem } from '../useCanvasLayerRuntime'
import { cancelCanvasSync, scheduleCanvasSync } from './canvasSync'

type SelectionBounds = {
  x: number
  y: number
  width: number
  height: number
}

type CanvasViewportRect = {
  left: number
  top: number
}

type CanvasSyncDetail = {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

type ResizeHandle =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

type ResizeSession = {
  kind: 'resize'
  pointerId: number
  handle: ResizeHandle
  startBounds: SelectionBounds
}

type DragSession = {
  kind: 'drag'
  pointerId: number
  startBounds: SelectionBounds
  startPoint: { x: number; y: number }
}

type LivePreviewState = {
  itemId: string
  bounds: SelectionBounds
}

type ProjectCanvasMultiSelectionTransformOverlayProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  items: CanvasItem[]
  livePreviewSyncItemIds?: ReadonlySet<string>
  onPreviewBoundsChange?: (bounds: SelectionBounds | null) => void
  registerViewportCallback?: (
    callback: (pos: { x: number; y: number }, scale: number) => void
  ) => (() => void) | void
  stagePos: { x: number; y: number }
  stagePosRef?: { current: { x: number; y: number } }
  stageScale: number
  stageScaleRef?: { current: number }
  onTransformEnd: (updates: Array<{ id: string; attrs: Partial<CanvasItem> }>) => void
}

const MIN_SELECTION_SIZE = 20
const HANDLE_SIZE = 10

const HANDLE_POSITIONS: Array<{
  handle: ResizeHandle
  left: string
  top: string
  cursor: string
}> = [
  { handle: 'top-left', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { handle: 'top-center', left: '50%', top: '0%', cursor: 'ns-resize' },
  { handle: 'top-right', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { handle: 'middle-left', left: '0%', top: '50%', cursor: 'ew-resize' },
  { handle: 'middle-right', left: '100%', top: '50%', cursor: 'ew-resize' },
  { handle: 'bottom-left', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { handle: 'bottom-center', left: '50%', top: '100%', cursor: 'ns-resize' },
  { handle: 'bottom-right', left: '100%', top: '100%', cursor: 'nwse-resize' }
]

function getCanvasPointFromClient(
  canvasContainer: HTMLDivElement | null,
  stagePos: { x: number; y: number },
  stageScale: number,
  clientX: number,
  clientY: number,
  viewportRect?: CanvasViewportRect | null
) {
  if (!canvasContainer) {
    return null
  }

  const rect = viewportRect ?? canvasContainer.getBoundingClientRect()
  const scale = Math.max(Math.abs(stageScale), 0.0001)

  return {
    x: (clientX - rect.left - stagePos.x) / scale,
    y: (clientY - rect.top - stagePos.y) / scale
  }
}

function resolveSelectionBounds(items: CanvasItem[]): SelectionBounds | null {
  const bounds = getCanvasItemsBounds(items)
  if (!bounds) {
    return null
  }

  return {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(bounds.maxX - bounds.minX, 1),
    height: Math.max(bounds.maxY - bounds.minY, 1)
  }
}

function resolveItemDragSurfaces(
  items: CanvasItem[],
  selectionBounds: SelectionBounds,
  stageScale: number
) {
  const scale = Math.max(Math.abs(stageScale), 0.0001)

  return items
    .map((item) => {
      const bounds = getCanvasItemBounds(item)
      const width = Math.max((bounds.maxX - bounds.minX) * scale, 1)
      const height = Math.max((bounds.maxY - bounds.minY) * scale, 1)

      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null
      }

      return {
        id: item.id,
        left: (bounds.minX - selectionBounds.x) * scale,
        top: (bounds.minY - selectionBounds.y) * scale,
        width,
        height
      }
    })
    .filter(
      (
        surface
      ): surface is { id: string; left: number; top: number; width: number; height: number } =>
        surface != null
    )
}

function resolveNextBounds(
  startBounds: SelectionBounds,
  handle: ResizeHandle,
  point: { x: number; y: number }
): SelectionBounds {
  let minX = startBounds.x
  let maxX = startBounds.x + startBounds.width
  let minY = startBounds.y
  let maxY = startBounds.y + startBounds.height

  if (handle.includes('left')) {
    minX = Math.min(point.x, maxX - MIN_SELECTION_SIZE)
  }

  if (handle.includes('right')) {
    maxX = Math.max(point.x, minX + MIN_SELECTION_SIZE)
  }

  if (handle.startsWith('top')) {
    minY = Math.min(point.y, maxY - MIN_SELECTION_SIZE)
  }

  if (handle.startsWith('bottom')) {
    maxY = Math.max(point.y, minY + MIN_SELECTION_SIZE)
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, MIN_SELECTION_SIZE),
    height: Math.max(maxY - minY, MIN_SELECTION_SIZE)
  }
}

function buildSelectionTransformUpdate(
  item: CanvasItem,
  startBounds: SelectionBounds,
  nextBounds: SelectionBounds
) {
  const safeItemWidth = Math.max(Math.abs(item.width), 1)
  const safeItemHeight = Math.max(Math.abs(item.height), 1)
  const startWidth = Math.max(startBounds.width, 1)
  const startHeight = Math.max(startBounds.height, 1)
  const scaleXFactor = nextBounds.width / startWidth
  const scaleYFactor = nextBounds.height / startHeight
  const itemExtentX = item.width * item.scaleX
  const itemExtentY = item.height * item.scaleY
  const itemLeft = Math.min(item.x, item.x + itemExtentX)
  const itemTop = Math.min(item.y, item.y + itemExtentY)
  const itemWidth = Math.max(Math.abs(itemExtentX), 1)
  const itemHeight = Math.max(Math.abs(itemExtentY), 1)
  const nextItemLeft = nextBounds.x + (itemLeft - startBounds.x) * scaleXFactor
  const nextItemTop = nextBounds.y + (itemTop - startBounds.y) * scaleYFactor
  const nextItemWidth = itemWidth * scaleXFactor
  const nextItemHeight = itemHeight * scaleYFactor
  const signScaleX = item.scaleX >= 0 ? 1 : -1
  const signScaleY = item.scaleY >= 0 ? 1 : -1

  return {
    x: signScaleX >= 0 ? nextItemLeft : nextItemLeft + nextItemWidth,
    y: signScaleY >= 0 ? nextItemTop : nextItemTop + nextItemHeight,
    scaleX: signScaleX * (nextItemWidth / safeItemWidth),
    scaleY: signScaleY * (nextItemHeight / safeItemHeight)
  }
}

function buildSelectionDragUpdate(item: CanvasItem, delta: { dx: number; dy: number }) {
  const movedItem = applyMultiDragDeltaToItem(item, delta)
  const attrs: Partial<CanvasItem> & {
    endX?: number
    endY?: number
    points?: number[]
  } = {
    x: movedItem.x,
    y: movedItem.y
  }

  if (
    movedItem.type === 'annotation' &&
    (movedItem.shape === 'arrow' || movedItem.shape === 'line') &&
    movedItem.endX != null &&
    movedItem.endY != null
  ) {
    attrs.endX = movedItem.endX
    attrs.endY = movedItem.endY
  }

  if (movedItem.type === 'annotation' && movedItem.shape === 'freedraw' && movedItem.points) {
    attrs.points = movedItem.points
  }

  return attrs
}

function buildSelectionPreviewTransform(
  item: CanvasItem,
  session: ResizeSession | DragSession,
  nextBounds: SelectionBounds
): CanvasSyncDetail {
  if (session.kind === 'drag') {
    const dx = nextBounds.x - session.startBounds.x
    const dy = nextBounds.y - session.startBounds.y
    const movedItem = applyMultiDragDeltaToItem(item, { dx, dy })

    return {
      x: movedItem.x,
      y: movedItem.y,
      rotation: item.rotation,
      scaleX: item.scaleX,
      scaleY: item.scaleY
    }
  }

  const update = buildSelectionTransformUpdate(item, session.startBounds, nextBounds)
  return {
    x: update.x,
    y: update.y,
    rotation: item.rotation,
    scaleX: update.scaleX,
    scaleY: update.scaleY
  }
}

function shouldBroadcastSelectionPreview(item: CanvasItem) {
  return item.type !== 'image' && item.type !== 'file'
}

const ProjectCanvasMultiSelectionTransformOverlay: React.FC<
  ProjectCanvasMultiSelectionTransformOverlayProps
> = ({
  canvasContainerRef,
  items,
  livePreviewSyncItemIds,
  onPreviewBoundsChange,
  registerViewportCallback,
  stagePos,
  stagePosRef,
  stageScale,
  stageScaleRef,
  onTransformEnd
}) => {
  const sessionRef = React.useRef<ResizeSession | DragSession | null>(null)
  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  const draftBoundsRef = React.useRef<SelectionBounds | null>(null)
  const previewedItemIdsRef = React.useRef<Set<string>>(new Set())
  const pendingPreviewBoundsRef = React.useRef<SelectionBounds | null>(null)
  const previewBoundsFrameRef = React.useRef<number | null>(null)
  const pointerCanvasViewportRectRef = React.useRef<CanvasViewportRect | null>(null)
  const windowPointerMoveHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const windowPointerUpHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const detachWindowPointerListenersRef = React.useRef<(() => void) | null>(null)
  const [livePreviewState, setLivePreviewState] = React.useState<LivePreviewState | null>(null)

  const baseBounds = React.useMemo(() => resolveSelectionBounds(items), [items])
  const broadcastPreviewItems = React.useMemo(
    () => items.filter(shouldBroadcastSelectionPreview),
    [items]
  )
  const livePreviewSyncItems = React.useMemo(
    () =>
      livePreviewSyncItemIds ? items.filter((item) => livePreviewSyncItemIds.has(item.id)) : items,
    [items, livePreviewSyncItemIds]
  )
  const activeBounds = livePreviewState?.bounds ?? baseBounds
  const getLiveStageSnapshot = React.useCallback(
    () => ({
      pos: stagePosRef?.current ?? stagePos,
      scale: stageScaleRef?.current ?? stageScale
    }),
    [stagePos, stagePosRef, stageScale, stageScaleRef]
  )
  const syncOverlayViewportPosition = React.useCallback(
    (
      bounds?: SelectionBounds | null,
      stageTransform: { pos: { x: number; y: number }; scale: number } = getLiveStageSnapshot()
    ) => {
      const resolvedBounds = bounds ?? draftBoundsRef.current ?? activeBounds
      const overlay = overlayRef.current
      if (!overlay || !resolvedBounds) {
        return
      }

      overlay.style.left = `${stageTransform.pos.x + resolvedBounds.x * stageTransform.scale}px`
      overlay.style.top = `${stageTransform.pos.y + resolvedBounds.y * stageTransform.scale}px`
      overlay.style.width = `${Math.max(resolvedBounds.width * stageTransform.scale, 1)}px`
      overlay.style.height = `${Math.max(resolvedBounds.height * stageTransform.scale, 1)}px`
    },
    [activeBounds, getLiveStageSnapshot]
  )
  const resizeEnabled = React.useMemo(
    () =>
      items.length > 1 &&
      items.every(
        (item) =>
          Math.abs(item.rotation) < 0.001 &&
          Number.isFinite(item.width) &&
          Number.isFinite(item.height) &&
          Math.abs(item.width) > 0 &&
          Math.abs(item.height) > 0
      ),
    [items]
  )

  const clearItemPreviewTransforms = React.useCallback((dispatchReset: boolean) => {
    for (const itemId of previewedItemIdsRef.current) {
      cancelCanvasSync(itemId)
      if (dispatchReset) {
        window.dispatchEvent(new CustomEvent(`canvas-reset-${itemId}`))
      }
    }

    previewedItemIdsRef.current.clear()
  }, [])

  const detachWindowPointerListeners = React.useCallback(() => {
    const detach = detachWindowPointerListenersRef.current
    if (!detach) {
      return
    }

    detachWindowPointerListenersRef.current = null
    detach()
  }, [])

  const attachWindowPointerListeners = React.useCallback(() => {
    if (detachWindowPointerListenersRef.current) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      windowPointerMoveHandlerRef.current(event)
    }
    const handlePointerUp = (event: PointerEvent) => {
      windowPointerUpHandlerRef.current(event)
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)

    detachWindowPointerListenersRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
    }
  }, [])

  const clearPointerCanvasViewportRect = React.useCallback(() => {
    pointerCanvasViewportRectRef.current = null
  }, [])

  const capturePointerCanvasViewportRect = React.useCallback(() => {
    const canvasContainer = canvasContainerRef.current
    if (!canvasContainer) {
      pointerCanvasViewportRectRef.current = null
      return null
    }

    const rect = canvasContainer.getBoundingClientRect()
    const nextViewportRect = {
      left: rect.left,
      top: rect.top
    }
    pointerCanvasViewportRectRef.current = nextViewportRect
    return nextViewportRect
  }, [canvasContainerRef])

  const getPointerCanvasViewportRect = React.useCallback(
    () => pointerCanvasViewportRectRef.current ?? capturePointerCanvasViewportRect(),
    [capturePointerCanvasViewportRect]
  )

  const cancelPreviewBoundsFrame = React.useCallback(() => {
    if (previewBoundsFrameRef.current == null) {
      return
    }

    window.cancelAnimationFrame(previewBoundsFrameRef.current)
    previewBoundsFrameRef.current = null
  }, [])

  const emitPreviewBoundsChange = React.useCallback(
    (bounds: SelectionBounds | null) => {
      pendingPreviewBoundsRef.current = null
      cancelPreviewBoundsFrame()
      onPreviewBoundsChange?.(bounds)
    },
    [cancelPreviewBoundsFrame, onPreviewBoundsChange]
  )

  const schedulePreviewBoundsChange = React.useCallback(
    (bounds: SelectionBounds) => {
      if (!onPreviewBoundsChange) {
        return
      }

      pendingPreviewBoundsRef.current = bounds
      if (previewBoundsFrameRef.current != null) {
        return
      }

      previewBoundsFrameRef.current = window.requestAnimationFrame(() => {
        previewBoundsFrameRef.current = null
        const nextBounds = pendingPreviewBoundsRef.current
        pendingPreviewBoundsRef.current = null
        onPreviewBoundsChange(nextBounds)
      })
    },
    [onPreviewBoundsChange]
  )

  const flushPreviewBoundsChange = React.useCallback(() => {
    if (pendingPreviewBoundsRef.current == null) {
      return
    }

    const nextBounds = pendingPreviewBoundsRef.current
    emitPreviewBoundsChange(nextBounds)
  }, [emitPreviewBoundsChange])

  const updateDraftBounds = React.useCallback(
    (nextBounds: SelectionBounds | null, session: ResizeSession | DragSession | null) => {
      draftBoundsRef.current = nextBounds

      if (!nextBounds || !session) {
        return
      }

      syncOverlayViewportPosition(nextBounds)

      if (broadcastPreviewItems.length === 0) {
        return
      }

      broadcastPreviewItems.forEach((item) => {
        previewedItemIdsRef.current.add(item.id)
        scheduleCanvasSync(item.id, buildSelectionPreviewTransform(item, session, nextBounds))
      })
    },
    [broadcastPreviewItems, syncOverlayViewportPosition]
  )

  React.useEffect(() => {
    if (!sessionRef.current) {
      draftBoundsRef.current = null
      setLivePreviewState(null)
    }
  }, [baseBounds, items])

  React.useEffect(() => {
    return () => {
      detachWindowPointerListeners()
      clearPointerCanvasViewportRect()
      cancelPreviewBoundsFrame()
      clearItemPreviewTransforms(true)
    }
  }, [
    cancelPreviewBoundsFrame,
    clearItemPreviewTransforms,
    clearPointerCanvasViewportRect,
    detachWindowPointerListeners
  ])

  React.useEffect(() => {
    if (livePreviewSyncItems.length === 0 || sessionRef.current) {
      setLivePreviewState(null)
      return
    }

    const itemById = new Map(livePreviewSyncItems.map((item) => [item.id, item]))
    const handleCanvasSync = (itemId: string, event: Event) => {
      if (sessionRef.current) {
        return
      }

      const item = itemById.get(itemId)
      const detail = (event as CustomEvent<CanvasSyncDetail>).detail
      if (!item || !detail || !baseBounds) {
        return
      }

      const dx = detail.x - item.x
      const dy = detail.y - item.y
      if (Math.abs(dx) <= 0.001 && Math.abs(dy) <= 0.001) {
        setLivePreviewState((previous) => (previous?.itemId === itemId ? null : previous))
        return
      }

      setLivePreviewState({
        itemId,
        bounds: {
          ...baseBounds,
          x: baseBounds.x + dx,
          y: baseBounds.y + dy
        }
      })
    }

    const handleCanvasReset = (itemId: string) => {
      if (sessionRef.current) {
        return
      }

      setLivePreviewState((previous) => (previous?.itemId === itemId ? null : previous))
    }

    const cleanup = livePreviewSyncItems.map((item) => {
      const syncListener = (event: Event) => handleCanvasSync(item.id, event)
      const resetListener = () => handleCanvasReset(item.id)
      window.addEventListener(`canvas-sync-${item.id}`, syncListener)
      window.addEventListener(`canvas-reset-${item.id}`, resetListener)
      return () => {
        window.removeEventListener(`canvas-sync-${item.id}`, syncListener)
        window.removeEventListener(`canvas-reset-${item.id}`, resetListener)
      }
    })

    return () => {
      cleanup.forEach((dispose) => dispose())
    }
  }, [baseBounds, livePreviewSyncItems])

  const finishInteraction = React.useCallback(
    (event: PointerEvent) => {
      const session = sessionRef.current
      const nextBounds = draftBoundsRef.current

      sessionRef.current = null
      draftBoundsRef.current = null
      detachWindowPointerListeners()
      clearPointerCanvasViewportRect()
      flushPreviewBoundsChange()

      if (!session || !nextBounds || !baseBounds) {
        emitPreviewBoundsChange(null)
        clearItemPreviewTransforms(true)
        return
      }

      if (event.pointerId !== session.pointerId) {
        emitPreviewBoundsChange(null)
        clearItemPreviewTransforms(true)
        return
      }

      if (session.kind === 'drag') {
        const dx = nextBounds.x - session.startBounds.x
        const dy = nextBounds.y - session.startBounds.y
        if (Math.abs(dx) <= 0.001 && Math.abs(dy) <= 0.001) {
          emitPreviewBoundsChange(null)
          clearItemPreviewTransforms(true)
          return
        }

        onTransformEnd(
          items.map((item) => ({
            id: item.id,
            attrs: buildSelectionDragUpdate(item, { dx, dy })
          }))
        )
        emitPreviewBoundsChange(null)
        clearItemPreviewTransforms(false)
        return
      }

      const widthChanged = Math.abs(nextBounds.width - session.startBounds.width) > 0.001
      const heightChanged = Math.abs(nextBounds.height - session.startBounds.height) > 0.001
      if (!widthChanged && !heightChanged) {
        emitPreviewBoundsChange(null)
        clearItemPreviewTransforms(true)
        return
      }

      onTransformEnd(
        items.map((item) => ({
          id: item.id,
          attrs: buildSelectionTransformUpdate(item, session.startBounds, nextBounds)
        }))
      )
      emitPreviewBoundsChange(null)
      clearItemPreviewTransforms(false)
    },
    [
      baseBounds,
      clearItemPreviewTransforms,
      clearPointerCanvasViewportRect,
      detachWindowPointerListeners,
      emitPreviewBoundsChange,
      flushPreviewBoundsChange,
      items,
      onTransformEnd
    ]
  )

  windowPointerMoveHandlerRef.current = (event: PointerEvent) => {
    const session = sessionRef.current
    if (!session || event.pointerId !== session.pointerId) {
      return
    }

    const stageTransform = getLiveStageSnapshot()
    const pointerViewportRect = getPointerCanvasViewportRect()
    const point = getCanvasPointFromClient(
      canvasContainerRef.current,
      stageTransform.pos,
      stageTransform.scale,
      event.clientX,
      event.clientY,
      pointerViewportRect
    )
    if (!point) {
      return
    }

    if (session.kind === 'drag') {
      const dx = point.x - session.startPoint.x
      const dy = point.y - session.startPoint.y
      const nextBounds = {
        ...session.startBounds,
        x: session.startBounds.x + dx,
        y: session.startBounds.y + dy
      }
      updateDraftBounds(nextBounds, session)
      schedulePreviewBoundsChange(nextBounds)
      return
    }

    const nextBounds = resolveNextBounds(session.startBounds, session.handle, point)
    updateDraftBounds(nextBounds, session)
    schedulePreviewBoundsChange(nextBounds)
  }

  windowPointerUpHandlerRef.current = (event: PointerEvent) => {
    if (event.pointerId !== sessionRef.current?.pointerId) {
      return
    }

    finishInteraction(event)
  }

  const startResize = React.useCallback(
    (handle: ResizeHandle, event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeEnabled || !baseBounds) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      capturePointerCanvasViewportRect()
      sessionRef.current = {
        kind: 'resize',
        pointerId: event.pointerId,
        handle,
        startBounds: baseBounds
      }
      draftBoundsRef.current = baseBounds
      syncOverlayViewportPosition(baseBounds)
      emitPreviewBoundsChange(baseBounds)
      attachWindowPointerListeners()
    },
    [
      attachWindowPointerListeners,
      baseBounds,
      capturePointerCanvasViewportRect,
      emitPreviewBoundsChange,
      resizeEnabled,
      syncOverlayViewportPosition
    ]
  )

  const startDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!baseBounds || event.button !== 0) {
        return
      }

      const stageTransform = getLiveStageSnapshot()
      const pointerViewportRect = capturePointerCanvasViewportRect()
      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        stageTransform.pos,
        stageTransform.scale,
        event.clientX,
        event.clientY,
        pointerViewportRect
      )
      if (!point) {
        clearPointerCanvasViewportRect()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      sessionRef.current = {
        kind: 'drag',
        pointerId: event.pointerId,
        startBounds: baseBounds,
        startPoint: point
      }
      draftBoundsRef.current = baseBounds
      syncOverlayViewportPosition(baseBounds)
      emitPreviewBoundsChange(baseBounds)
      attachWindowPointerListeners()
    },
    [
      attachWindowPointerListeners,
      baseBounds,
      canvasContainerRef,
      capturePointerCanvasViewportRect,
      clearPointerCanvasViewportRect,
      emitPreviewBoundsChange,
      getLiveStageSnapshot,
      syncOverlayViewportPosition
    ]
  )

  React.useEffect(() => {
    return () => {
      onPreviewBoundsChange?.(null)
    }
  }, [onPreviewBoundsChange])

  React.useEffect(() => {
    if (!registerViewportCallback) {
      return
    }

    const dispose = registerViewportCallback((pos, scale) => {
      syncOverlayViewportPosition(undefined, { pos, scale })
    })

    return typeof dispose === 'function' ? dispose : undefined
  }, [activeBounds, registerViewportCallback, syncOverlayViewportPosition])

  React.useLayoutEffect(() => {
    syncOverlayViewportPosition()
    const frameId = window.requestAnimationFrame(() => {
      syncOverlayViewportPosition()
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [syncOverlayViewportPosition])

  if (!activeBounds) {
    return null
  }

  const stageTransform = getLiveStageSnapshot()
  const itemDragSurfaces = resolveItemDragSurfaces(items, activeBounds, stageTransform.scale)

  return (
    <Box
      ref={overlayRef}
      data-testid="project-canvas-multi-selection-transform-overlay"
      data-project-canvas-multi-selection-transform-overlay="true"
      data-resize-enabled={String(resizeEnabled)}
      sx={{
        position: 'absolute',
        left: stageTransform.pos.x + activeBounds.x * stageTransform.scale,
        top: stageTransform.pos.y + activeBounds.y * stageTransform.scale,
        width: Math.max(activeBounds.width * stageTransform.scale, 1),
        height: Math.max(activeBounds.height * stageTransform.scale, 1),
        border: '1px solid rgba(99,102,241,0.92)',
        boxShadow: '0 0 0 1px rgba(99,102,241,0.24)',
        borderRadius: '2px',
        pointerEvents: 'none',
        zIndex: 6
      }}
    >
      {itemDragSurfaces.map((surface) => (
        <Box
          key={surface.id}
          data-canvas-multi-select-drag-surface="true"
          data-canvas-multi-select-drag-surface-item-id={surface.id}
          onPointerDown={startDrag}
          sx={{
            position: 'absolute',
            left: surface.left,
            top: surface.top,
            width: surface.width,
            height: surface.height,
            pointerEvents: 'auto',
            cursor: 'move'
          }}
        />
      ))}
      {resizeEnabled &&
        HANDLE_POSITIONS.map(({ handle, left, top, cursor }) => (
          <Box
            key={handle}
            data-canvas-multi-select-handle={handle}
            onPointerDown={(event: React.PointerEvent<HTMLDivElement>) =>
              startResize(handle, event)
            }
            sx={{
              position: 'absolute',
              left,
              top,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              transform: 'translate(-50%, -50%)',
              borderRadius:
                handle.includes('center') || handle.includes('middle') ? '999px' : '2px',
              bgcolor: '#6366f1',
              border: '1.5px solid #ffffff',
              boxShadow: '0 2px 8px rgba(15,23,42,0.22)',
              pointerEvents: 'auto',
              cursor
            }}
          />
        ))}
    </Box>
  )
}

export default React.memo(ProjectCanvasMultiSelectionTransformOverlay)
