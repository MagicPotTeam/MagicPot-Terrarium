/* eslint-disable @typescript-eslint/no-explicit-any */
import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react'
import { isCanvasAdditiveSelectionModifier } from './canvasSelectionModifiers'
import { createProjectCanvasRuntime } from './projectCanvasRuntime'
import type { CanvasAnnotationItem, CanvasItem } from './types'

type UseCanvasStageInteractionOptions = any
type CanvasStageMouseEvent = {
  evt: MouseEvent
  type: string
}

type CanvasStageWheelEvent = {
  evt: WheelEvent
  type: string
}

type CanvasSelectionRect = {
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
} | null

type CanvasViewportRect = {
  left: number
  top: number
}

const WHEEL_DELTA_NORMALIZER_PX = 100
const WHEEL_LINE_DELTA_PX = 16
const WHEEL_MAX_FRAME_DELTA_PX = 400
const WHEEL_ZOOM_STEP_SCALE = 1.12
const VIEWPORT_INTERACTION_IDLE_MS = 240
const SELECTION_MARQUEE_ACTIVATION_PX = 3
const POINT_HIT_TEST_SCREEN_RADIUS_PX = 2

function isCanvasInteractionDebugEnabled() {
  return (
    (window as Window & { __projectCanvasDebugInteraction?: boolean })
      .__projectCanvasDebugInteraction === true
  )
}

function getCanvasPointFromViewportEvent(options: {
  canvasContainerRef: { current: HTMLDivElement | null }
  stagePos: { x: number; y: number }
  stageScale: number
  clientX: number
  clientY: number
  viewportRect?: CanvasViewportRect | null
}) {
  const { canvasContainerRef, stagePos, stageScale, clientX, clientY, viewportRect } = options
  const canvasContainer = canvasContainerRef.current
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

function normalizeWheelDeltaY(event: WheelEvent, canvasContainer: HTMLDivElement) {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY * WHEEL_LINE_DELTA_PX
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY * canvasContainer.clientHeight
    default:
      return event.deltaY
  }
}

function getCanvasPointHitTestRadius(stageScale: number) {
  const safeScale = Math.max(Math.abs(stageScale), 0.0001)
  return Math.max(POINT_HIT_TEST_SCREEN_RADIUS_PX / safeScale, 1)
}

export function useCanvasStageInteraction(options: UseCanvasStageInteractionOptions) {
  const {
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
    stagePosRef,
    stageScale,
    stageScaleRef,
    tool,
    onViewportInteractionStart,
    onViewportInteractionEnd,
    handleOpenCanvasTargetDialog,
    // Optional: called during pan/zoom to drive DOM transforms directly,
    // skipping React setState on the hot path. setState still happens on pointer-up.
    onViewportChange,
    // Optional: called every rAF during selection drag to drive DOM directly,
    // skipping React setState on the hot path. setState still happens on mouse-up.
    onSelectionRectChange,
    onSelectionMarqueeActiveChange
  } = options

  const isPanningRef = useRef(isPanning)
  const viewportCommitFrameRef = useRef<number | null>(null)
  const zoomCommitFrameRef = useRef<number | null>(null)
  const pendingWheelDeltaRef = useRef(0)
  const pendingWheelPointerRef = useRef<{ x: number; y: number } | null>(null)
  const selectionRectRef = useRef<CanvasSelectionRect>(selectionRect)
  const selectionRectDraftRef = useRef<CanvasSelectionRect>(null)
  const selectionRectCommitFrameRef = useRef<number | null>(null)
  const selectionRectAdditiveRef = useRef(false)
  const selectionRectHadInitialSelectionRef = useRef(false)
  const isSelectionMarqueeActiveRef = useRef(false)
  const isSelectionRectDraggingRef = useRef(false)
  const pointerCanvasViewportRectRef = useRef<CanvasViewportRect | null>(null)
  // Cached container rect for wheel events – avoids getBoundingClientRect() on every tick.
  // Invalidated when viewport interaction ends.
  const wheelContainerRectRef = useRef<{
    left: number
    top: number
    right: number
    bottom: number
  } | null>(null)
  const viewportInteractionIdleTimeoutRef = useRef<number | null>(null)
  const isViewportInteractionActiveRef = useRef(false)
  // Keep a stable ref to onViewportChange so rAF callbacks don't capture stale closures
  const onViewportChangeRef = useRef<
    ((pos: { x: number; y: number }, scale: number) => void) | undefined
  >(onViewportChange)
  const lastAppliedViewportChangeRef = useRef<{ x: number; y: number; scale: number } | null>(null)
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange
  }, [onViewportChange])
  const onSelectionRectChangeRef = useRef<
    ((rect: { x: number; y: number; w: number; h: number } | null) => void) | undefined
  >(onSelectionRectChange)
  useEffect(() => {
    onSelectionRectChangeRef.current = onSelectionRectChange
  }, [onSelectionRectChange])
  const onSelectionMarqueeActiveChangeRef = useRef<((active: boolean) => void) | undefined>(
    onSelectionMarqueeActiveChange
  )
  useEffect(() => {
    onSelectionMarqueeActiveChangeRef.current = onSelectionMarqueeActiveChange
  }, [onSelectionMarqueeActiveChange])

  useEffect(() => {
    isPanningRef.current = isPanning
  }, [isPanning])

  useEffect(() => {
    if (selectionRect == null && isSelectionRectDraggingRef.current) {
      return
    }
    selectionRectRef.current = selectionRect
  }, [selectionRect])

  const applyViewportChange = useCallback((pos: { x: number; y: number }, scale: number) => {
    const lastViewportChange = lastAppliedViewportChangeRef.current
    if (
      lastViewportChange &&
      lastViewportChange.x === pos.x &&
      lastViewportChange.y === pos.y &&
      lastViewportChange.scale === scale
    ) {
      return
    }

    lastAppliedViewportChangeRef.current = { x: pos.x, y: pos.y, scale }
    onViewportChangeRef.current?.(pos, scale)
  }, [])

  const canvasRuntime = useMemo(
    () => createProjectCanvasRuntime({ getItemBounds: getCanvasItemBounds }),
    [getCanvasItemBounds]
  )

  useEffect(() => {
    canvasRuntime.setItems(items)
  }, [canvasRuntime, items])

  const syncCanvasRuntimeViewport = useCallback(() => {
    const pos = stagePosRef.current
    canvasRuntime.setViewport({
      x: pos.x,
      y: pos.y,
      scale: stageScaleRef.current
    })
  }, [canvasRuntime, stagePosRef, stageScaleRef])

  useEffect(() => {
    syncCanvasRuntimeViewport()
  }, [stageScale, syncCanvasRuntimeViewport])

  const cancelPendingViewportCommit = useCallback(() => {
    if (viewportCommitFrameRef.current == null) {
      return
    }

    window.cancelAnimationFrame(viewportCommitFrameRef.current)
    viewportCommitFrameRef.current = null
  }, [])

  const flushPendingViewportCommit = useCallback(() => {
    if (viewportCommitFrameRef.current != null) {
      window.cancelAnimationFrame(viewportCommitFrameRef.current)
      viewportCommitFrameRef.current = null
    }

    const pos = stagePosRef.current
    const scale = stageScaleRef.current
    syncCanvasRuntimeViewport()
    // Ensure DOM layers are visually in sync before React reconciles.
    // This covers the edge case where pointerup fires before the pending rAF.
    applyViewportChange(pos, scale)
    setStageScale(scale)
    setStagePos({ ...pos })
  }, [
    applyViewportChange,
    setStagePos,
    setStageScale,
    stagePosRef,
    stageScaleRef,
    syncCanvasRuntimeViewport
  ])

  const applyPanViewportDelta = useCallback(
    (clientX: number, clientY: number) => {
      const dx = clientX - lastPanPosRef.current.x
      const dy = clientY - lastPanPosRef.current.y
      if (dx === 0 && dy === 0) {
        return
      }

      lastPanPosRef.current = { x: clientX, y: clientY }
      stagePosRef.current = {
        x: stagePosRef.current.x + dx,
        y: stagePosRef.current.y + dy
      }
      syncCanvasRuntimeViewport()
      applyViewportChange(stagePosRef.current, stageScaleRef.current)
    },
    [applyViewportChange, lastPanPosRef, stagePosRef, stageScaleRef, syncCanvasRuntimeViewport]
  )

  const scheduleViewportCommit = useCallback(() => {
    if (viewportCommitFrameRef.current != null) {
      return
    }

    viewportCommitFrameRef.current = window.requestAnimationFrame(() => {
      viewportCommitFrameRef.current = null
      const pos = stagePosRef.current
      const scale = stageScaleRef.current
      syncCanvasRuntimeViewport()
      // Drive viewport-layer DOM transforms imperatively – zero React setState on the hot path.
      // React state (setStagePos / setStageScale) is synced only once when interaction ends
      // via flushPendingViewportCommit, eliminating per-frame reconciliation overhead.
      applyViewportChange(pos, scale)
    })
  }, [applyViewportChange, stagePosRef, stageScaleRef, syncCanvasRuntimeViewport])

  const applyWheelZoom = useCallback(
    (pointer: { x: number; y: number }, deltaY: number) => {
      const oldScale = stageScaleRef.current
      const oldPos = stagePosRef.current
      const clampedDeltaY = Math.max(
        -WHEEL_MAX_FRAME_DELTA_PX,
        Math.min(WHEEL_MAX_FRAME_DELTA_PX, deltaY)
      )
      if (!Number.isFinite(clampedDeltaY) || Math.abs(clampedDeltaY) < 0.01) {
        return
      }

      const nextScale =
        oldScale * Math.pow(WHEEL_ZOOM_STEP_SCALE, -clampedDeltaY / WHEEL_DELTA_NORMALIZER_PX)
      const clampedScale = clampStageScale(nextScale)
      if (!Number.isFinite(clampedScale) || clampedScale === oldScale) return

      const mousePointTo = {
        x: (pointer.x - oldPos.x) / oldScale,
        y: (pointer.y - oldPos.y) / oldScale
      }

      const newPos = {
        x: pointer.x - mousePointTo.x * clampedScale,
        y: pointer.y - mousePointTo.y * clampedScale
      }

      stageScaleRef.current = clampedScale
      stagePosRef.current = newPos
      syncCanvasRuntimeViewport()
      applyViewportChange(newPos, clampedScale)
    },
    [applyViewportChange, clampStageScale, stagePosRef, stageScaleRef, syncCanvasRuntimeViewport]
  )

  const flushPendingZoomCommit = useCallback(() => {
    if (zoomCommitFrameRef.current != null) {
      window.cancelAnimationFrame(zoomCommitFrameRef.current)
      zoomCommitFrameRef.current = null
    }

    const pointer = pendingWheelPointerRef.current
    const deltaY = pendingWheelDeltaRef.current
    pendingWheelPointerRef.current = null
    pendingWheelDeltaRef.current = 0

    if (!pointer || !deltaY) {
      return
    }

    applyWheelZoom(pointer, deltaY)
  }, [applyWheelZoom])

  const scheduleZoomCommit = useCallback(() => {
    if (zoomCommitFrameRef.current != null) {
      return
    }

    zoomCommitFrameRef.current = window.requestAnimationFrame(() => {
      zoomCommitFrameRef.current = null
      const pointer = pendingWheelPointerRef.current
      const deltaY = pendingWheelDeltaRef.current
      pendingWheelPointerRef.current = null
      pendingWheelDeltaRef.current = 0

      if (!pointer || !deltaY) {
        return
      }

      applyWheelZoom(pointer, deltaY)
    })
  }, [applyWheelZoom])

  const cancelPendingZoomCommit = useCallback(() => {
    if (zoomCommitFrameRef.current != null) {
      window.cancelAnimationFrame(zoomCommitFrameRef.current)
      zoomCommitFrameRef.current = null
    }

    pendingWheelDeltaRef.current = 0
    pendingWheelPointerRef.current = null
  }, [])

  const clearViewportInteractionIdleTimeout = useCallback(() => {
    if (viewportInteractionIdleTimeoutRef.current == null) {
      return
    }

    window.clearTimeout(viewportInteractionIdleTimeoutRef.current)
    viewportInteractionIdleTimeoutRef.current = null
  }, [])

  const beginViewportInteraction = useCallback(() => {
    clearViewportInteractionIdleTimeout()

    if (isViewportInteractionActiveRef.current) {
      return
    }

    isViewportInteractionActiveRef.current = true
    onViewportInteractionStart?.()
  }, [clearViewportInteractionIdleTimeout, onViewportInteractionStart])

  const endViewportInteraction = useCallback(
    (flushViewport = false) => {
      clearViewportInteractionIdleTimeout()
      // Invalidate the cached wheel container rect so next interaction gets a fresh measurement.
      wheelContainerRectRef.current = null

      if (flushViewport) {
        flushPendingZoomCommit()
        flushPendingViewportCommit()
      }

      if (!isViewportInteractionActiveRef.current) {
        return
      }

      isViewportInteractionActiveRef.current = false
      onViewportInteractionEnd?.()
    },
    [
      clearViewportInteractionIdleTimeout,
      flushPendingViewportCommit,
      flushPendingZoomCommit,
      onViewportInteractionEnd
    ]
  )

  const scheduleViewportInteractionIdleRelease = useCallback(() => {
    clearViewportInteractionIdleTimeout()
    viewportInteractionIdleTimeoutRef.current = window.setTimeout(() => {
      viewportInteractionIdleTimeoutRef.current = null
      endViewportInteraction(true)
    }, VIEWPORT_INTERACTION_IDLE_MS)
  }, [clearViewportInteractionIdleTimeout, endViewportInteraction])

  const cancelPendingSelectionRectCommit = useCallback(() => {
    if (selectionRectCommitFrameRef.current == null) {
      return
    }

    window.cancelAnimationFrame(selectionRectCommitFrameRef.current)
    selectionRectCommitFrameRef.current = null
  }, [])

  const flushPendingSelectionRectCommit = useCallback(() => {
    if (selectionRectCommitFrameRef.current != null) {
      window.cancelAnimationFrame(selectionRectCommitFrameRef.current)
      selectionRectCommitFrameRef.current = null
    }

    const nextSelectionRect = selectionRectDraftRef.current
    if (!nextSelectionRect) {
      return
    }

    selectionRectDraftRef.current = null
    selectionRectRef.current = nextSelectionRect
    onSelectionRectChangeRef.current?.(nextSelectionRect)
  }, [])

  const scheduleSelectionRectCommit = useCallback(() => {
    if (selectionRectCommitFrameRef.current != null) {
      return
    }

    selectionRectCommitFrameRef.current = window.requestAnimationFrame(() => {
      selectionRectCommitFrameRef.current = null
      const nextSelectionRect = selectionRectDraftRef.current
      if (!nextSelectionRect) {
        return
      }

      selectionRectDraftRef.current = null
      selectionRectRef.current = nextSelectionRect
      // Drive selection rect DOM imperatively — zero React setState on the hot path.
      // React state is synced only once when mouse-up via setSelectionRect(null).
      onSelectionRectChangeRef.current?.(nextSelectionRect)
    })
  }, [])

  const clearPointerCanvasViewportRect = useCallback(() => {
    pointerCanvasViewportRectRef.current = null
  }, [])

  const syncSelectionRectState = useCallback(
    (nextSelectionRect: CanvasSelectionRect) => {
      if (nextSelectionRect == null && selectionRect == null) {
        return
      }

      startTransition(() => {
        setSelectionRect(nextSelectionRect)
      })
    },
    [selectionRect, setSelectionRect]
  )

  const capturePointerCanvasViewportRect = useCallback(() => {
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

  const getPointerCanvasViewportRect = useCallback(
    () => pointerCanvasViewportRectRef.current ?? capturePointerCanvasViewportRect(),
    [capturePointerCanvasViewportRect]
  )

  const updateCanvasInteractionDebug = useCallback(
    (
      phase: string,
      rect?: {
        w?: number
        h?: number
      } | null
    ) => {
      const canvasContainer = canvasContainerRef.current
      if (!isCanvasInteractionDebugEnabled()) {
        return
      }

      const traceWindow = window as Window & {
        __canvasInteractionTrace?: Array<Record<string, unknown>>
      }
      const traceEntry = {
        phase,
        tool,
        width: rect?.w ?? null,
        height: rect?.h ?? null
      }
      if (!traceWindow.__canvasInteractionTrace) {
        traceWindow.__canvasInteractionTrace = []
      }
      traceWindow.__canvasInteractionTrace.push(traceEntry)
      if (traceWindow.__canvasInteractionTrace.length > 80) {
        traceWindow.__canvasInteractionTrace.shift()
      }
      if (!canvasContainer) {
        return
      }

      canvasContainer.dataset.canvasDebugPhase = phase
      canvasContainer.dataset.canvasDebugTool = tool
      canvasContainer.dataset.canvasDebugSelectionWidth = rect?.w != null ? String(rect.w) : ''
      canvasContainer.dataset.canvasDebugSelectionHeight = rect?.h != null ? String(rect.h) : ''
    },
    [canvasContainerRef, tool]
  )

  const setSelectionMarqueeActive = useCallback((active: boolean) => {
    if (isSelectionMarqueeActiveRef.current === active) {
      return
    }

    isSelectionMarqueeActiveRef.current = active
    onSelectionMarqueeActiveChangeRef.current?.(active)
  }, [])

  useEffect(() => {
    return () => {
      cancelPendingViewportCommit()
      cancelPendingZoomCommit()
      cancelPendingSelectionRectCommit()
      clearViewportInteractionIdleTimeout()
      clearPointerCanvasViewportRect()
      setSelectionMarqueeActive(false)
    }
  }, [
    cancelPendingViewportCommit,
    cancelPendingZoomCommit,
    cancelPendingSelectionRectCommit,
    clearViewportInteractionIdleTimeout,
    clearPointerCanvasViewportRect,
    setSelectionMarqueeActive
  ])

  const handleStageMouseDown = useCallback(
    (event: CanvasStageMouseEvent) => {
      canvasContainerRef.current?.focus({ preventScroll: true })
      clearPointerCanvasViewportRect()

      isMiddleMouseRef.current = event.evt.button === 1
      if (event.evt.button === 1 || tool === 'hand') {
        beginViewportInteraction()
        isPanningRef.current = true
        setIsPanning(true)
        lastPanPosRef.current = { x: event.evt.clientX, y: event.evt.clientY }
        event.evt.preventDefault()

        const handleGlobalPointerMove = (moveEvent: MouseEvent | PointerEvent) => {
          if (!isPanningRef.current) {
            return
          }

          moveEvent.preventDefault()
          applyPanViewportDelta(moveEvent.clientX, moveEvent.clientY)
          scheduleViewportCommit()
        }

        const handleGlobalPointerUp = () => {
          isMiddleMouseRef.current = false
          isPanningRef.current = false
          endViewportInteraction(true)
          setIsPanning(false)
          window.removeEventListener('pointermove', handleGlobalPointerMove)
          window.removeEventListener('mousemove', handleGlobalPointerMove)
          window.removeEventListener('pointerup', handleGlobalPointerUp)
          window.removeEventListener('pointercancel', handleGlobalPointerUp)
          window.removeEventListener('mouseup', handleGlobalPointerUp)
        }

        window.addEventListener('pointermove', handleGlobalPointerMove, { passive: false })
        window.addEventListener('mousemove', handleGlobalPointerMove, { passive: false })
        window.addEventListener('pointerup', handleGlobalPointerUp)
        window.addEventListener('pointercancel', handleGlobalPointerUp)
        window.addEventListener('mouseup', handleGlobalPointerUp)
        return
      }

      if (tool === 'crop-select' && event.evt.button === 0) {
        cropOverlayRef.current?.confirm()
        return
      }

      if (tool === 'extract-select' && event.evt.button === 0) {
        return
      }

      if (tool === 'annotate' && event.evt.button === 0) {
        const pointerViewportRect = capturePointerCanvasViewportRect()
        const pointer = getCanvasPointFromViewportEvent({
          canvasContainerRef,
          stagePos: stagePosRef.current,
          stageScale: stageScaleRef.current,
          clientX: event.evt.clientX,
          clientY: event.evt.clientY,
          viewportRect: pointerViewportRect
        })
        if (!pointer) return
        const canvasX = pointer.x
        const canvasY = pointer.y
        updateCanvasInteractionDebug('drawing-start')

        if (annoTool === 'arrow' || annoTool === 'line') {
          setDrawingState({
            shape: annoTool,
            startX: canvasX,
            startY: canvasY,
            x: canvasX,
            y: canvasY,
            w: 0,
            h: 0,
            endX: canvasX,
            endY: canvasY
          })
          return
        }

        if (annoTool === 'freedraw') {
          setDrawingState({
            shape: 'freedraw',
            startX: canvasX,
            startY: canvasY,
            x: canvasX,
            y: canvasY,
            w: 0,
            h: 0,
            points: [canvasX, canvasY]
          })
          return
        }

        setDrawingState({
          shape: annoTool,
          startX: canvasX,
          startY: canvasY,
          x: canvasX,
          y: canvasY,
          w: 0,
          h: 0
        })
        return
      }

      if (
        (tool === 'select' || tool === 'export-select' || tool === 'target-select') &&
        event.evt.button === 0
      ) {
        const shouldStartSelection = tool !== 'select' || tool === 'select'

        if (shouldStartSelection) {
          const pointerViewportRect = capturePointerCanvasViewportRect()
          const pointer = getCanvasPointFromViewportEvent({
            canvasContainerRef,
            stagePos: stagePosRef.current,
            stageScale: stageScaleRef.current,
            clientX: event.evt.clientX,
            clientY: event.evt.clientY,
            viewportRect: pointerViewportRect
          })
          if (!pointer) return
          const canvasX = pointer.x
          const canvasY = pointer.y
          selectionRectAdditiveRef.current = isCanvasAdditiveSelectionModifier(event.evt)
          selectionRectHadInitialSelectionRef.current = selectedIds.size > 0
          cancelPendingSelectionRectCommit()
          selectionRectDraftRef.current = null
          const nextSelectionRect = {
            startX: canvasX,
            startY: canvasY,
            x: canvasX,
            y: canvasY,
            w: 0,
            h: 0
          }
          isSelectionRectDraggingRef.current = true
          selectionRectRef.current = nextSelectionRect
          updateCanvasInteractionDebug('selection-start', nextSelectionRect)
        }
      }
    },
    [
      annoTool,
      applyPanViewportDelta,
      beginViewportInteraction,
      canvasContainerRef,
      clearPointerCanvasViewportRect,
      capturePointerCanvasViewportRect,
      cancelPendingSelectionRectCommit,
      cropOverlayRef,
      endViewportInteraction,
      isSelectionRectDraggingRef,
      isMiddleMouseRef,
      lastPanPosRef,
      scheduleViewportCommit,
      selectedIds,
      setDrawingState,
      setIsPanning,
      stagePosRef,
      stageScaleRef,
      tool,
      updateCanvasInteractionDebug
    ]
  )

  const handleStageMouseMove = useCallback(
    (event: CanvasStageMouseEvent) => {
      if (isPanningRef.current) {
        event.evt.preventDefault()
        applyPanViewportDelta(event.evt.clientX, event.evt.clientY)
        scheduleViewportCommit()
        return
      }

      if (drawingState) {
        const pointerViewportRect = getPointerCanvasViewportRect()
        const pointer = getCanvasPointFromViewportEvent({
          canvasContainerRef,
          stagePos: stagePosRef.current,
          stageScale: stageScaleRef.current,
          clientX: event.evt.clientX,
          clientY: event.evt.clientY,
          viewportRect: pointerViewportRect
        })
        if (!pointer) return
        const canvasX = pointer.x
        const canvasY = pointer.y
        updateCanvasInteractionDebug('drawing-move')

        if (drawingState.shape === 'arrow' || drawingState.shape === 'line') {
          setDrawingState((prev: any) => (prev ? { ...prev, endX: canvasX, endY: canvasY } : null))
        } else if (drawingState.shape === 'freedraw') {
          setDrawingState((prev: any) =>
            prev
              ? {
                  ...prev,
                  points: [...(prev.points || []), canvasX, canvasY]
                }
              : null
          )
        } else {
          const x = Math.min(drawingState.startX, canvasX)
          const y = Math.min(drawingState.startY, canvasY)
          const w = Math.abs(canvasX - drawingState.startX)
          const h = Math.abs(canvasY - drawingState.startY)
          setDrawingState((prev: any) => (prev ? { ...prev, x, y, w, h } : null))
        }
        return
      }

      const activeSelectionRect = selectionRectDraftRef.current ?? selectionRectRef.current
      if (activeSelectionRect) {
        const pointerViewportRect = getPointerCanvasViewportRect()
        const pointer = getCanvasPointFromViewportEvent({
          canvasContainerRef,
          stagePos: stagePosRef.current,
          stageScale: stageScaleRef.current,
          clientX: event.evt.clientX,
          clientY: event.evt.clientY,
          viewportRect: pointerViewportRect
        })
        if (!pointer) return
        const canvasX = pointer.x
        const canvasY = pointer.y
        const nextSelectionRect = {
          ...activeSelectionRect,
          x: Math.min(activeSelectionRect.startX, canvasX),
          y: Math.min(activeSelectionRect.startY, canvasY),
          w: Math.abs(canvasX - activeSelectionRect.startX),
          h: Math.abs(canvasY - activeSelectionRect.startY)
        }
        selectionRectDraftRef.current = nextSelectionRect
        selectionRectRef.current = nextSelectionRect
        updateCanvasInteractionDebug('selection-move', nextSelectionRect)
        const shouldActivateMarquee =
          nextSelectionRect.w > SELECTION_MARQUEE_ACTIVATION_PX ||
          nextSelectionRect.h > SELECTION_MARQUEE_ACTIVATION_PX
        if (!shouldActivateMarquee) {
          return
        }

        setSelectionMarqueeActive(true)
        if (onSelectionRectChangeRef.current) {
          cancelPendingSelectionRectCommit()
          onSelectionRectChangeRef.current(nextSelectionRect)
          return
        }

        scheduleSelectionRectCommit()
      }
    },
    [
      cancelPendingSelectionRectCommit,
      canvasContainerRef,
      drawingState,
      getPointerCanvasViewportRect,
      onSelectionRectChangeRef,
      applyPanViewportDelta,
      scheduleSelectionRectCommit,
      scheduleViewportCommit,
      setDrawingState,
      setSelectionMarqueeActive,
      stagePosRef,
      stageScaleRef,
      updateCanvasInteractionDebug
    ]
  )

  const handleStageWheel = useCallback(
    (event: CanvasStageWheelEvent) => {
      const canvasContainer = canvasContainerRef.current
      if (!canvasContainer) {
        return
      }

      // Reuse cached rect to avoid getBoundingClientRect() forced layout on every wheel tick.
      // wheelContainerRectRef is invalidated by endViewportInteraction so each new gesture
      // always starts with a fresh measurement.
      let canvasRect = wheelContainerRectRef.current
      if (!canvasRect) {
        const domRect = canvasContainer.getBoundingClientRect()
        canvasRect = {
          left: domRect.left,
          top: domRect.top,
          right: domRect.right,
          bottom: domRect.bottom
        }
        wheelContainerRectRef.current = canvasRect
      }
      const withinCanvas =
        event.evt.clientX >= canvasRect.left &&
        event.evt.clientX <= canvasRect.right &&
        event.evt.clientY >= canvasRect.top &&
        event.evt.clientY <= canvasRect.bottom
      if (!withinCanvas) {
        return
      }

      if (event.evt.cancelable) {
        event.evt.preventDefault()
      }
      const normalizedDeltaY = normalizeWheelDeltaY(event.evt, canvasContainer)
      if (!Number.isFinite(normalizedDeltaY) || normalizedDeltaY === 0) {
        return
      }

      beginViewportInteraction()
      pendingWheelDeltaRef.current += normalizedDeltaY
      pendingWheelPointerRef.current = {
        x: event.evt.clientX - canvasRect.left,
        y: event.evt.clientY - canvasRect.top
      }
      scheduleZoomCommit()
      scheduleViewportInteractionIdleRelease()
    },
    [
      beginViewportInteraction,
      canvasContainerRef,
      scheduleViewportInteractionIdleRelease,
      scheduleZoomCommit
    ]
  )

  const handleStageMouseUp = useCallback(
    (event?: CanvasStageMouseEvent) => {
      const hasActiveSelectionGesture =
        isSelectionRectDraggingRef.current ||
        selectionRectDraftRef.current != null ||
        selectionRectRef.current != null

      if (
        event?.type === 'mouseleave' &&
        event.evt &&
        (event.evt.buttons >= 1 || hasActiveSelectionGesture)
      ) {
        return
      }

      if (isPanningRef.current || isMiddleMouseRef.current) {
        isMiddleMouseRef.current = false
        isPanningRef.current = false
        endViewportInteraction(true)
      }
      setIsPanning(false)

      if (drawingState) {
        const base = {
          id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'annotation' as const,
          shape: drawingState.shape,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndex.current++,
          locked: false,
          stroke: annotationColor,
          fillOpacity: isFillableAnnotationShape(drawingState.shape) ? annotationFillOpacity : 0,
          strokeWidth: annotationStrokeWidth,
          label: ''
        }

        if (
          (drawingState.shape === 'arrow' || drawingState.shape === 'line') &&
          drawingState.endX != null &&
          drawingState.endY != null
        ) {
          const dx = drawingState.endX - drawingState.startX
          const dy = drawingState.endY - drawingState.startY
          if (Math.sqrt(dx * dx + dy * dy) > 10) {
            const newItem: CanvasAnnotationItem = {
              ...base,
              x: drawingState.startX,
              y: drawingState.startY,
              width: 0,
              height: 0,
              endX: drawingState.endX,
              endY: drawingState.endY
            }
            setItemsWithHistory((prev: CanvasItem[]) => [...prev, newItem])
            setSelectedIds(new Set([newItem.id]))
          }
        } else if (
          drawingState.shape === 'freedraw' &&
          drawingState.points &&
          drawingState.points.length > 4
        ) {
          const xs = drawingState.points.filter((_: unknown, index: number) => index % 2 === 0)
          const ys = drawingState.points.filter((_: unknown, index: number) => index % 2 === 1)
          const minX = Math.min(...xs)
          const maxX = Math.max(...xs)
          const minY = Math.min(...ys)
          const maxY = Math.max(...ys)
          const newItem: CanvasAnnotationItem = {
            ...base,
            x: minX,
            y: minY,
            width: maxX - minX || 1,
            height: maxY - minY || 1,
            points: drawingState.points
          }
          setItemsWithHistory((prev: CanvasItem[]) => [...prev, newItem])
          setSelectedIds(new Set([newItem.id]))
        } else if (
          [
            'rect',
            'ellipse',
            'circle',
            'text-anno',
            'rhombus',
            'parallelogram',
            'double-line-rect',
            'document',
            'cylinder',
            'rounded-rect'
          ].includes(drawingState.shape)
        ) {
          if (drawingState.shape === 'text-anno') {
            const isClick = drawingState.w < 10 && drawingState.h < 10
            const initialWidth = isClick ? 200 / Math.abs(stageScale || 1) : drawingState.w
            const initialHeight = isClick ? 60 / Math.abs(stageScale || 1) : drawingState.h

            setInlineTextEdit({
              id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              x: drawingState.x,
              y: drawingState.y,
              w: initialWidth,
              h: initialHeight,
              text: '',
              isNew: true,
              fontSize: initialHeight,
              _createdAt: Date.now()
            } as any)
          } else if (drawingState.w > 10 && drawingState.h > 10) {
            const newItem: CanvasAnnotationItem = {
              ...base,
              x: drawingState.x,
              y: drawingState.y,
              width: drawingState.w,
              height: drawingState.h
            }
            setItemsWithHistory((prev: CanvasItem[]) => [...prev, newItem])
            setSelectedIds(new Set([newItem.id]))
          }
        }
      }

      setDrawingState(null)
      flushPendingSelectionRectCommit()
      const activeSelectionRect = selectionRectDraftRef.current ?? selectionRectRef.current
      const isAdditiveSelection = selectionRectAdditiveRef.current
      const hadInitialSelection = selectionRectHadInitialSelectionRef.current

      if (
        activeSelectionRect &&
        (activeSelectionRect.w > 5 || activeSelectionRect.h > 5) &&
        !dragContextRef.current.draggingId
      ) {
        if (tool === 'export-select') {
          isSelectionRectDraggingRef.current = false
          selectionRectDraftRef.current = null
          selectionRectRef.current = null
          setTool('select')
          syncSelectionRectState(null)
          clearPointerCanvasViewportRect()
          setSelectionMarqueeActive(false)
          return
        }

        if (tool === 'crop-select' || tool === 'extract-select') {
          isSelectionRectDraggingRef.current = false
          selectionRectDraftRef.current = null
          selectionRectRef.current = null
          clearPointerCanvasViewportRect()
          setSelectionMarqueeActive(false)
          return
        }

        if (tool === 'target-select') {
          const { x: sx, y: sy, w: sw, h: sh } = activeSelectionRect
          const targetItems = canvasRuntime.queryItems({
            minX: sx,
            minY: sy,
            maxX: sx + sw,
            maxY: sy + sh
          })

          setTool('select')
          isSelectionRectDraggingRef.current = false
          selectionRectDraftRef.current = null
          selectionRectRef.current = null
          syncSelectionRectState(null)
          clearPointerCanvasViewportRect()
          setSelectionMarqueeActive(false)

          if (targetItems.length === 0) {
            notifyWarning(
              isChineseUi
                ? '\u5f53\u524d\u6846\u9009\u533a\u57df\u5185\u6ca1\u6709\u53ef\u7528\u4e8e\u81ea\u52a8\u5316\u7684\u753b\u5e03\u5143\u7d20\u3002'
                : 'No canvas items were found in the selected region.'
            )
            return
          }

          setSelectedIds(new Set(targetItems.map((item: CanvasItem) => item.id)))
          void handleOpenCanvasTargetDialog(targetItems, {
            x: sx,
            y: sy,
            width: sw,
            height: sh
          })
          return
        }

        const { x: sx, y: sy, w: sw, h: sh } = activeSelectionRect
        const hitIds = new Set(
          canvasRuntime.marqueeSelect({
            minX: sx,
            minY: sy,
            maxX: sx + sw,
            maxY: sy + sh
          })
        )
        if (hitIds.size > 0) {
          if (isAdditiveSelection) {
            setSelectedIds((prev: Set<string>) => {
              let shouldMerge = false
              for (const id of hitIds) {
                if (!prev.has(id)) {
                  shouldMerge = true
                  break
                }
              }
              if (!shouldMerge) {
                return prev
              }

              const next = new Set(prev)
              for (const id of hitIds) next.add(id)
              return next
            })
          } else {
            setSelectedIds((prev: Set<string>) => {
              if (prev.size === hitIds.size) {
                let isSameSelection = true
                for (const id of hitIds) {
                  if (!prev.has(id)) {
                    isSameSelection = false
                    break
                  }
                }
                if (isSameSelection) {
                  return prev
                }
              }

              return hitIds
            })
          }
        } else if (!isAdditiveSelection && hadInitialSelection) {
          setSelectedIds((prev: Set<string>) => (prev.size === 0 ? prev : new Set()))
        }
      } else if (activeSelectionRect && !dragContextRef.current.draggingId && tool === 'select') {
        const hitItem = canvasRuntime.hitTest(
          { x: activeSelectionRect.startX, y: activeSelectionRect.startY },
          { canvasRadius: getCanvasPointHitTestRadius(stageScaleRef.current) }
        )

        if (hitItem) {
          if (isAdditiveSelection) {
            setSelectedIds((prev: Set<string>) => {
              const next = new Set(prev)
              if (next.has(hitItem.id)) next.delete(hitItem.id)
              else next.add(hitItem.id)
              return next
            })
          } else {
            setSelectedIds((prev: Set<string>) => {
              if (prev.size === 1 && prev.has(hitItem.id)) {
                return prev
              }

              return new Set([hitItem.id])
            })
          }
        } else if (!isAdditiveSelection && hadInitialSelection) {
          setSelectedIds((prev: Set<string>) => (prev.size === 0 ? prev : new Set()))
        }
      }

      isSelectionRectDraggingRef.current = false
      selectionRectDraftRef.current = null
      selectionRectRef.current = null
      selectionRectAdditiveRef.current = false
      selectionRectHadInitialSelectionRef.current = false
      updateCanvasInteractionDebug('selection-clear')
      if (isSelectionMarqueeActiveRef.current) {
        onSelectionRectChangeRef.current?.(null)
      }
      syncSelectionRectState(null)
      clearPointerCanvasViewportRect()
      setSelectionMarqueeActive(false)
    },
    [
      annotationColor,
      annotationFillOpacity,
      annotationStrokeWidth,
      dragContextRef,
      drawingState,
      handleOpenCanvasTargetDialog,
      isChineseUi,
      isFillableAnnotationShape,
      isSelectionRectDraggingRef,
      canvasRuntime,
      nextZIndex,
      notifyWarning,
      endViewportInteraction,
      flushPendingSelectionRectCommit,
      clearPointerCanvasViewportRect,
      syncSelectionRectState,
      setSelectionMarqueeActive,
      setDrawingState,
      setInlineTextEdit,
      isMiddleMouseRef,
      setIsPanning,
      setItemsWithHistory,
      setSelectedIds,
      setTool,
      stageScale,
      stageScaleRef,
      tool,
      updateCanvasInteractionDebug
    ]
  )

  return {
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageWheel,
    zoomStageAtPointer: applyWheelZoom
  }
}
