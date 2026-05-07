import React from 'react'
import { Box } from '@mui/material'
import type { CanvasImageItem } from '../types'
import {
  getProjectCanvasRenderTransformKey,
  type ProjectCanvasImagePreview,
  type ProjectCanvasImageRuntimeRoute
} from '../projectCanvasRenderBoundary'
import { findCanvasSelectionToolbar } from '../canvasDomOverlayLookup'
import type { SelectionActionStackPlacement } from '../canvasSelectionLayoutUtils'
import { resolveSelectionActionToolbarPosition } from '../canvasSelectionLayoutUtils'
import { isCanvasAdditiveSelectionModifier } from '../canvasSelectionModifiers'
import { getCanvasItemBounds } from '../projectCanvasPageShared'
import CanvasImageDomPreview from './CanvasImageDomPreview'
import { buildCanvasSelectionOutlineStyles } from './projectCanvasInteractionOverlayStyles'
import { scheduleCanvasSync } from './canvasSync'

type CanvasPoint = {
  x: number
  y: number
}

type CanvasViewportRect = {
  left: number
  top: number
}

type CanvasImageTransform = Pick<CanvasImageItem, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'>

type CornerHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
type CornerRotateHotspotPart = 'circle' | 'horizontal' | 'vertical'

type RotateSession = {
  kind: 'rotate'
  pointerId: number
  startAngleRad: number
  startTransform: CanvasImageTransform
  center: CanvasPoint
}

type DragSession = {
  kind: 'drag'
  pointerId: number
  startPoint: CanvasPoint
  startTransform: CanvasImageTransform
  moved: boolean
}

type ResizeSession = {
  kind: 'resize'
  pointerId: number
  handle: CornerHandle
  startTransform: CanvasImageTransform
}

type InteractionSession = DragSession | ResizeSession | RotateSession

type ProjectCanvasImageInteractionOverlayProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  item: CanvasImageItem
  isSelected: boolean
  selectedCount?: number
  renderMode?: ProjectCanvasImageRuntimeRoute
  suppressImagePreview?: boolean
  preferDomImagePreview?: boolean
  domImagePreviewBackdropColor?: string
  isDraggable: boolean
  showTransformer: boolean
  allowPointerPassthrough?: boolean
  stagePos: { x: number; y: number }
  stageScale: number
  stagePosRef?: React.MutableRefObject<{ x: number; y: number }>
  stageScaleRef?: React.MutableRefObject<number>
  onPreviewChange?: (itemId: string, preview: ProjectCanvasImagePreview | null) => void
  broadcastDomPreviewSync?: boolean
  onSelect: (additiveSelection?: boolean) => void
  onDragEnd: (id: string, x: number, y: number, evt?: PointerEvent) => void
  onTransformEnd: (id: string, attrs: Partial<CanvasImageItem>) => void
  onContextMenu?: (event: MouseEvent | PointerEvent) => void
}

const MIN_TRANSFORM_SIZE = 20
const HANDLE_SIZE = 10
const HANDLE_HIT_SIZE = 28
const HANDLE_HIT_HALF = HANDLE_HIT_SIZE / 2
const CORNER_ROTATE_CONNECTOR_THICKNESS = 16
const CORNER_ROTATE_HOTSPOT_RADIUS = 24
const CORNER_ROTATE_HOTSPOT_SIZE = CORNER_ROTATE_HOTSPOT_RADIUS * 2
const CORNER_ROTATE_HOTSPOT_OFFSET = 40
const rotateCursorUrl = new URL('../../../assets/cursors/rotate-cursor.svg', import.meta.url).href
const ROTATE_CURSOR = `url("${rotateCursorUrl}") 12 12, grab`
const DEFAULT_SELECTION_TOOLBAR_WIDTH = 356
const DEFAULT_SELECTION_TOOLBAR_HEIGHT = 44
const PROTECTED_SELECTION_OVERLAY_SELECTOR =
  '[data-canvas-overlay="annotation"], [data-canvas-overlay="text"]'

type SelectionToolbarAvoidRect = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function parseSelectionToolbarMetric(value: string | undefined, fallback: number): number {
  const parsedValue = Number(value)
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

function hasSameStageTransform(
  previousStagePos: { x: number; y: number },
  previousStageScale: number,
  nextStagePos: { x: number; y: number },
  nextStageScale: number
): boolean {
  return (
    previousStagePos.x === nextStagePos.x &&
    previousStagePos.y === nextStagePos.y &&
    previousStageScale === nextStageScale
  )
}

function getSelectionToolbarAvoidRects(
  canvasContainer: HTMLDivElement,
  ownerId: string
): SelectionToolbarAvoidRect[] {
  const containerRect = canvasContainer.getBoundingClientRect()

  return Array.from(
    canvasContainer.querySelectorAll<HTMLElement>(PROTECTED_SELECTION_OVERLAY_SELECTOR)
  )
    .filter((element) => element.dataset.canvasItemId !== ownerId)
    .map((element) => {
      const elementRect = element.getBoundingClientRect()
      return {
        minX: elementRect.left - containerRect.left,
        minY: elementRect.top - containerRect.top,
        maxX: elementRect.right - containerRect.left,
        maxY: elementRect.bottom - containerRect.top
      }
    })
    .filter((rect) => rect.maxX > rect.minX && rect.maxY > rect.minY)
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function buildElementTransform(transform: CanvasImageTransform): string {
  return `translate3d(${transform.x}px, ${transform.y}px, 0) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`
}

function rotateVector(vector: CanvasPoint, degrees: number): CanvasPoint {
  const radians = toRadians(degrees)
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos
  }
}

function subtractPoints(left: CanvasPoint, right: CanvasPoint): CanvasPoint {
  return {
    x: left.x - right.x,
    y: left.y - right.y
  }
}

function addPoints(left: CanvasPoint, right: CanvasPoint): CanvasPoint {
  return {
    x: left.x + right.x,
    y: left.y + right.y
  }
}

function dotProduct(left: CanvasPoint, right: CanvasPoint): number {
  return left.x * right.x + left.y * right.y
}

function getCanvasAxes(rotation: number) {
  const radians = toRadians(rotation)
  return {
    xAxis: {
      x: Math.cos(radians),
      y: Math.sin(radians)
    },
    yAxis: {
      x: -Math.sin(radians),
      y: Math.cos(radians)
    }
  }
}

function getCanvasPointFromClient(
  canvasContainer: HTMLDivElement | null,
  stagePos: { x: number; y: number },
  stageScale: number,
  clientX: number,
  clientY: number,
  viewportRect?: CanvasViewportRect | null
): CanvasPoint | null {
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

function resolveStageTransformSnapshot(
  stagePosRef: React.MutableRefObject<{ x: number; y: number }> | undefined,
  stageScaleRef: React.MutableRefObject<number> | undefined,
  stagePos: { x: number; y: number },
  stageScale: number
) {
  return {
    stagePos: stagePosRef?.current ?? stagePos,
    stageScale: stageScaleRef?.current ?? stageScale
  }
}

function getCornerPoint(
  transform: CanvasImageTransform,
  width: number,
  height: number,
  handle: CornerHandle
): CanvasPoint {
  const offset =
    handle === 'top-left'
      ? { x: 0, y: 0 }
      : handle === 'top-right'
        ? { x: width * transform.scaleX, y: 0 }
        : handle === 'bottom-left'
          ? { x: 0, y: height * transform.scaleY }
          : { x: width * transform.scaleX, y: height * transform.scaleY }

  return addPoints({ x: transform.x, y: transform.y }, rotateVector(offset, transform.rotation))
}

function getHandleVector(
  transform: CanvasImageTransform,
  width: number,
  height: number,
  handle: CornerHandle
): CanvasPoint {
  const scaledWidth = width * transform.scaleX
  const scaledHeight = height * transform.scaleY
  const offset =
    handle === 'top-left'
      ? { x: -scaledWidth, y: -scaledHeight }
      : handle === 'top-right'
        ? { x: scaledWidth, y: -scaledHeight }
        : handle === 'bottom-left'
          ? { x: -scaledWidth, y: scaledHeight }
          : { x: scaledWidth, y: scaledHeight }

  return rotateVector(offset, transform.rotation)
}

function getImageCenter(
  transform: CanvasImageTransform,
  width: number,
  height: number
): CanvasPoint {
  return addPoints(
    { x: transform.x, y: transform.y },
    rotateVector(
      {
        x: (width * transform.scaleX) / 2,
        y: (height * transform.scaleY) / 2
      },
      transform.rotation
    )
  )
}

function getOppositeHandle(handle: CornerHandle): CornerHandle {
  switch (handle) {
    case 'top-left':
      return 'bottom-right'
    case 'top-right':
      return 'bottom-left'
    case 'bottom-left':
      return 'top-right'
    case 'bottom-right':
      return 'top-left'
  }
}

function resolveResizedTransform(options: {
  handle: CornerHandle
  pointer: CanvasPoint
  startTransform: CanvasImageTransform
  width: number
  height: number
}): CanvasImageTransform {
  const { handle, pointer, startTransform, width, height } = options
  const fixedPoint = getCornerPoint(startTransform, width, height, getOppositeHandle(handle))
  const delta = subtractPoints(pointer, fixedPoint)
  const handleVector = getHandleVector(startTransform, width, height, handle)
  const handleVectorLengthSquared = Math.max(dotProduct(handleVector, handleVector), 0.0001)
  const minScaleFactor = Math.max(
    MIN_TRANSFORM_SIZE / Math.max(Math.abs(width * startTransform.scaleX), 1),
    MIN_TRANSFORM_SIZE / Math.max(Math.abs(height * startTransform.scaleY), 1),
    0.01
  )
  const scaleFactor = Math.max(
    minScaleFactor,
    dotProduct(delta, handleVector) / handleVectorLengthSquared
  )
  const scaleX = startTransform.scaleX * scaleFactor
  const scaleY = startTransform.scaleY * scaleFactor

  if (handle === 'top-left') {
    const nextTopLeft = addPoints(fixedPoint, {
      x: handleVector.x * scaleFactor,
      y: handleVector.y * scaleFactor
    })
    return {
      ...startTransform,
      x: nextTopLeft.x,
      y: nextTopLeft.y,
      scaleX,
      scaleY
    }
  }

  if (handle === 'top-right') {
    const nextPosition = subtractPoints(
      fixedPoint,
      rotateVector({ x: 0, y: height * scaleY }, startTransform.rotation)
    )
    return {
      ...startTransform,
      x: nextPosition.x,
      y: nextPosition.y,
      scaleX,
      scaleY
    }
  }

  if (handle === 'bottom-left') {
    const nextPosition = subtractPoints(
      fixedPoint,
      rotateVector({ x: width * scaleX, y: 0 }, startTransform.rotation)
    )
    return {
      ...startTransform,
      x: nextPosition.x,
      y: nextPosition.y,
      scaleX,
      scaleY
    }
  }

  return {
    ...startTransform,
    scaleX,
    scaleY
  }
}

function resolveRotatedTransform(options: {
  center: CanvasPoint
  nextRotation: number
  startTransform: CanvasImageTransform
  width: number
  height: number
}): CanvasImageTransform {
  const { center, nextRotation, startTransform, width, height } = options
  const nextOffset = rotateVector(
    {
      x: (width * startTransform.scaleX) / 2,
      y: (height * startTransform.scaleY) / 2
    },
    nextRotation
  )
  const nextPosition = subtractPoints(center, nextOffset)
  return {
    ...startTransform,
    x: nextPosition.x,
    y: nextPosition.y,
    rotation: nextRotation
  }
}

function buildPreview(
  item: CanvasImageItem,
  transform: CanvasImageTransform
): ProjectCanvasImagePreview {
  return {
    x: transform.x,
    y: transform.y,
    width: item.width,
    height: item.height,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation
  }
}

function getImageTransformClientBounds(
  item: CanvasImageItem,
  transform: CanvasImageTransform,
  stagePos: { x: number; y: number },
  stageScale: number
) {
  const bounds = getCanvasItemBounds({ ...item, ...transform })
  return {
    minX: stagePos.x + bounds.minX * stageScale,
    minY: stagePos.y + bounds.minY * stageScale,
    maxX: stagePos.x + bounds.maxX * stageScale,
    maxY: stagePos.y + bounds.maxY * stageScale
  }
}

const HANDLE_POSITIONS: Array<{ handle: CornerHandle; left: string; top: string }> = [
  { handle: 'top-left', left: '0%', top: '0%' },
  { handle: 'top-right', left: '100%', top: '0%' },
  { handle: 'bottom-left', left: '0%', top: '100%' },
  { handle: 'bottom-right', left: '100%', top: '100%' }
]

const CORNER_ROTATE_HOTSPOTS: Array<{
  handle: CornerHandle
  part: CornerRotateHotspotPart
  left: string
  top: string
  offsetX: number
  offsetY: number
  width: number
  height: number
  anchorMode: 'center' | 'top-left'
}> = [
  {
    handle: 'top-left',
    part: 'circle',
    left: '0%',
    top: '0%',
    offsetX: -CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: -CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_HOTSPOT_SIZE,
    height: CORNER_ROTATE_HOTSPOT_SIZE,
    anchorMode: 'center'
  },
  {
    handle: 'top-left',
    part: 'horizontal',
    left: '0%',
    top: '0%',
    offsetX: -CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: -(HANDLE_HIT_HALF + CORNER_ROTATE_CONNECTOR_THICKNESS),
    width: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    height: CORNER_ROTATE_CONNECTOR_THICKNESS,
    anchorMode: 'top-left'
  },
  {
    handle: 'top-left',
    part: 'vertical',
    left: '0%',
    top: '0%',
    offsetX: -(HANDLE_HIT_HALF + CORNER_ROTATE_CONNECTOR_THICKNESS),
    offsetY: -CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_CONNECTOR_THICKNESS,
    height: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    anchorMode: 'top-left'
  },
  {
    handle: 'top-right',
    part: 'circle',
    left: '100%',
    top: '0%',
    offsetX: CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: -CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_HOTSPOT_SIZE,
    height: CORNER_ROTATE_HOTSPOT_SIZE,
    anchorMode: 'center'
  },
  {
    handle: 'top-right',
    part: 'horizontal',
    left: '100%',
    top: '0%',
    offsetX: -HANDLE_HIT_HALF,
    offsetY: -(HANDLE_HIT_HALF + CORNER_ROTATE_CONNECTOR_THICKNESS),
    width: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    height: CORNER_ROTATE_CONNECTOR_THICKNESS,
    anchorMode: 'top-left'
  },
  {
    handle: 'top-right',
    part: 'vertical',
    left: '100%',
    top: '0%',
    offsetX: HANDLE_HIT_HALF,
    offsetY: -CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_CONNECTOR_THICKNESS,
    height: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    anchorMode: 'top-left'
  },
  {
    handle: 'bottom-left',
    part: 'circle',
    left: '0%',
    top: '100%',
    offsetX: -CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_HOTSPOT_SIZE,
    height: CORNER_ROTATE_HOTSPOT_SIZE,
    anchorMode: 'center'
  },
  {
    handle: 'bottom-left',
    part: 'horizontal',
    left: '0%',
    top: '100%',
    offsetX: -CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: HANDLE_HIT_HALF,
    width: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    height: CORNER_ROTATE_CONNECTOR_THICKNESS,
    anchorMode: 'top-left'
  },
  {
    handle: 'bottom-left',
    part: 'vertical',
    left: '0%',
    top: '100%',
    offsetX: -(HANDLE_HIT_HALF + CORNER_ROTATE_CONNECTOR_THICKNESS),
    offsetY: -HANDLE_HIT_HALF,
    width: CORNER_ROTATE_CONNECTOR_THICKNESS,
    height: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    anchorMode: 'top-left'
  },
  {
    handle: 'bottom-right',
    part: 'circle',
    left: '100%',
    top: '100%',
    offsetX: CORNER_ROTATE_HOTSPOT_OFFSET,
    offsetY: CORNER_ROTATE_HOTSPOT_OFFSET,
    width: CORNER_ROTATE_HOTSPOT_SIZE,
    height: CORNER_ROTATE_HOTSPOT_SIZE,
    anchorMode: 'center'
  },
  {
    handle: 'bottom-right',
    part: 'horizontal',
    left: '100%',
    top: '100%',
    offsetX: -HANDLE_HIT_HALF,
    offsetY: HANDLE_HIT_HALF,
    width: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    height: CORNER_ROTATE_CONNECTOR_THICKNESS,
    anchorMode: 'top-left'
  },
  {
    handle: 'bottom-right',
    part: 'vertical',
    left: '100%',
    top: '100%',
    offsetX: HANDLE_HIT_HALF,
    offsetY: -HANDLE_HIT_HALF,
    width: CORNER_ROTATE_CONNECTOR_THICKNESS,
    height: CORNER_ROTATE_HOTSPOT_OFFSET + HANDLE_HIT_HALF,
    anchorMode: 'top-left'
  }
]

function toCssOffset(base: string, delta: number): string {
  if (Math.abs(delta) < 0.001) {
    return base
  }

  return delta >= 0 ? `calc(${base} + ${delta}px)` : `calc(${base} - ${Math.abs(delta)}px)`
}

const ProjectCanvasImageInteractionOverlay: React.FC<ProjectCanvasImageInteractionOverlayProps> = ({
  canvasContainerRef,
  item,
  isSelected,
  selectedCount = 1,
  renderMode = 'webgl-primary',
  suppressImagePreview = false,
  preferDomImagePreview = false,
  domImagePreviewBackdropColor,
  isDraggable,
  showTransformer,
  allowPointerPassthrough = false,
  stagePos,
  stageScale,
  stagePosRef,
  stageScaleRef,
  onPreviewChange,
  broadcastDomPreviewSync = false,
  onSelect,
  onDragEnd,
  onTransformEnd,
  onContextMenu
}) => {
  const elementRef = React.useRef<HTMLDivElement | null>(null)
  const sessionRef = React.useRef<InteractionSession | null>(null)
  const draftTransformRef = React.useRef<CanvasImageTransform | null>(null)
  const lastEmittedPreviewKeyRef = React.useRef<string | null>(null)
  const pointerCanvasViewportRectRef = React.useRef<CanvasViewportRect | null>(null)
  const windowPointerMoveHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const windowPointerUpHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const detachWindowPointerListenersRef = React.useRef<(() => void) | null>(null)
  const shouldSelectOnDragFinishRef = React.useRef(false)
  const [draftTransform, setDraftTransform] = React.useState<CanvasImageTransform | null>(null)

  const committedTransform = React.useMemo(
    () => ({
      x: item.x,
      y: item.y,
      scaleX: item.scaleX,
      scaleY: item.scaleY,
      rotation: item.rotation
    }),
    [item.rotation, item.scaleX, item.scaleY, item.x, item.y]
  )
  const activeTransform = draftTransform ?? committedTransform

  React.useEffect(() => {
    if (!sessionRef.current) {
      draftTransformRef.current = null
      setDraftTransform(null)
    }
  }, [committedTransform])

  const detachWindowPointerListeners = React.useCallback(() => {
    const detach = detachWindowPointerListenersRef.current
    if (!detach) {
      return
    }

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
      detachWindowPointerListenersRef.current = null
    }
  }, [])

  React.useEffect(() => detachWindowPointerListeners, [detachWindowPointerListeners])

  const applyElementTransform = React.useCallback((transform: CanvasImageTransform) => {
    const element = elementRef.current
    if (!element) {
      return
    }

    element.style.transform = buildElementTransform(transform)
  }, [])

  const emitPreviewChangeNow = React.useCallback(
    (preview: ProjectCanvasImagePreview, options: { immediateSync?: boolean } = {}) => {
      if (broadcastDomPreviewSync) {
        if (options.immediateSync) {
          window.dispatchEvent(new CustomEvent(`canvas-sync-${item.id}`, { detail: preview }))
        } else {
          scheduleCanvasSync(item.id, preview)
        }
      }
      lastEmittedPreviewKeyRef.current = getProjectCanvasRenderTransformKey(preview)
      onPreviewChange?.(item.id, preview)
    },
    [broadcastDomPreviewSync, item.id, onPreviewChange]
  )

  const flushPendingPreviewChange = React.useCallback(
    (nextTransform: CanvasImageTransform) => {
      const preview = buildPreview(item, nextTransform)
      const previewKey = getProjectCanvasRenderTransformKey(preview)
      if (lastEmittedPreviewKeyRef.current === previewKey) {
        return
      }

      emitPreviewChangeNow(preview, { immediateSync: true })
    },
    [emitPreviewChangeNow, item]
  )

  const schedulePreviewChange = React.useCallback(
    (transform: CanvasImageTransform) => {
      emitPreviewChangeNow(buildPreview(item, transform), { immediateSync: true })
    },
    [emitPreviewChangeNow, item]
  )

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

  React.useLayoutEffect(() => {
    applyElementTransform(draftTransformRef.current ?? activeTransform)
  }, [activeTransform, applyElementTransform])

  const flushPendingDraftTransformCommit = React.useCallback(
    (nextTransform: CanvasImageTransform | null = draftTransformRef.current ?? null) => {
      setDraftTransform(nextTransform)
    },
    []
  )

  React.useEffect(() => {
    return () => {
      lastEmittedPreviewKeyRef.current = null
      shouldSelectOnDragFinishRef.current = false
      clearPointerCanvasViewportRect()
      if (broadcastDomPreviewSync) {
        window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))
      }
      onPreviewChange?.(item.id, null)
    }
  }, [
    broadcastDomPreviewSync,
    clearPointerCanvasViewportRect,
    item.id,
    onPreviewChange,
    shouldSelectOnDragFinishRef
  ])

  const updateFloatingToolbarPosition = React.useCallback(
    (transform: CanvasImageTransform = activeTransform) => {
      if (!isSelected) {
        return true
      }

      const canvasContainer = canvasContainerRef.current
      if (!canvasContainer) {
        return false
      }

      const toolbar = findCanvasSelectionToolbar(canvasContainer, '.image-action-toolbar', item.id)
      if (!toolbar) {
        return false
      }

      const containerRect = canvasContainer.getBoundingClientRect()
      const { stagePos: currentStagePos, stageScale: currentStageScale } =
        resolveStageTransformSnapshot(stagePosRef, stageScaleRef, stagePos, stageScale)
      const imageBounds = getImageTransformClientBounds(
        item,
        transform,
        currentStagePos,
        currentStageScale
      )
      const toolbarRect = toolbar.getBoundingClientRect()
      const toolbarWidth =
        toolbarRect.width ||
        parseSelectionToolbarMetric(
          toolbar.dataset.selectionToolbarWidthEstimate,
          DEFAULT_SELECTION_TOOLBAR_WIDTH
        )
      const toolbarHeight =
        toolbarRect.height ||
        parseSelectionToolbarMetric(
          toolbar.dataset.selectionToolbarHeightEstimate,
          DEFAULT_SELECTION_TOOLBAR_HEIGHT
        )
      const preferredPlacement =
        (toolbar.dataset.selectionToolbarPreferredPlacement as
          | SelectionActionStackPlacement
          | undefined) ?? 'auto'
      const toolbarPosition = resolveSelectionActionToolbarPosition(
        {
          minX: imageBounds.minX,
          minY: imageBounds.minY,
          maxX: imageBounds.maxX,
          maxY: imageBounds.maxY
        },
        {
          width: containerRect.width,
          height: containerRect.height
        },
        {
          avoidRects: getSelectionToolbarAvoidRects(canvasContainer, item.id),
          lockHorizontalAnchor: true,
          preferredPlacement,
          toolbarHeight,
          toolbarWidth
        }
      )

      toolbar.style.left = `${toolbarPosition.left}px`
      toolbar.style.top = `${toolbarPosition.top}px`
      return true
    },
    [
      activeTransform,
      canvasContainerRef,
      isSelected,
      item,
      stagePos,
      stagePosRef,
      stageScale,
      stageScaleRef
    ]
  )

  const updateLiveBoundsDisplay = React.useCallback(
    (transform: CanvasImageTransform) => {
      const display = document.getElementById('live-bounds-display')
      if (!display) {
        return
      }

      const width = Math.round(Math.abs(item.width * (transform.scaleX || 1)))
      const height = Math.round(Math.abs(item.height * (transform.scaleY || 1)))
      display.textContent = `${width} x ${height}`
    },
    [item.height, item.width]
  )

  React.useLayoutEffect(() => {
    if (updateFloatingToolbarPosition(activeTransform)) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      updateFloatingToolbarPosition(activeTransform)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [activeTransform, stagePos.x, stagePos.y, stageScale, updateFloatingToolbarPosition])

  const finishSession = React.useCallback(
    (event: PointerEvent) => {
      const currentSession = sessionRef.current
      const shouldSelectOnDragFinish = shouldSelectOnDragFinishRef.current

      shouldSelectOnDragFinishRef.current = false
      sessionRef.current = null
      detachWindowPointerListeners()
      clearPointerCanvasViewportRect()

      if (!currentSession) {
        return
      }

      if (currentSession.kind === 'drag' && !currentSession.moved) {
        draftTransformRef.current = null
        flushPendingDraftTransformCommit(null)
        if (shouldSelectOnDragFinish) {
          onSelect(false)
        }
        return
      }

      const currentTransform = draftTransformRef.current ?? draftTransform ?? committedTransform

      draftTransformRef.current = currentTransform
      flushPendingDraftTransformCommit(currentTransform)
      updateFloatingToolbarPosition(currentTransform)

      if (currentSession.kind === 'drag') {
        flushPendingPreviewChange(currentTransform)
        onDragEnd(item.id, currentTransform.x, currentTransform.y, event)
        if (shouldSelectOnDragFinish) {
          onSelect(false)
        }
      } else {
        flushPendingPreviewChange(currentTransform)
        onTransformEnd(item.id, {
          x: currentTransform.x,
          y: currentTransform.y,
          rotation: currentTransform.rotation,
          scaleX: currentTransform.scaleX,
          scaleY: currentTransform.scaleY
        })
      }
    },
    [
      clearPointerCanvasViewportRect,
      detachWindowPointerListeners,
      committedTransform,
      draftTransform,
      flushPendingDraftTransformCommit,
      flushPendingPreviewChange,
      item.id,
      onDragEnd,
      onSelect,
      onTransformEnd,
      updateFloatingToolbarPosition
    ]
  )

  windowPointerMoveHandlerRef.current = (event: PointerEvent) => {
    const currentSession = sessionRef.current
    if (!currentSession) {
      return
    }
    if (event.pointerId !== currentSession.pointerId) {
      return
    }

    const { stagePos: currentStagePos, stageScale: currentStageScale } =
      resolveStageTransformSnapshot(stagePosRef, stageScaleRef, stagePos, stageScale)
    const pointerViewportRect = getPointerCanvasViewportRect()
    const point = getCanvasPointFromClient(
      canvasContainerRef.current,
      currentStagePos,
      currentStageScale,
      event.clientX,
      event.clientY,
      pointerViewportRect
    )
    if (!point) {
      return
    }

    if (currentSession.kind === 'drag') {
      const delta = subtractPoints(point, currentSession.startPoint)
      const moved = currentSession.moved || delta.x !== 0 || delta.y !== 0
      if (!moved) {
        return
      }

      if (!currentSession.moved) {
        currentSession.moved = true
      }

      const nextTransform = {
        ...currentSession.startTransform,
        x: currentSession.startTransform.x + delta.x,
        y: currentSession.startTransform.y + delta.y
      }
      draftTransformRef.current = nextTransform
      applyElementTransform(nextTransform)
      schedulePreviewChange(nextTransform)
      return
    }

    if (currentSession.kind === 'resize') {
      const nextTransform = resolveResizedTransform({
        handle: currentSession.handle,
        pointer: point,
        startTransform: currentSession.startTransform,
        width: item.width,
        height: item.height
      })
      draftTransformRef.current = nextTransform
      applyElementTransform(nextTransform)
      updateLiveBoundsDisplay(nextTransform)
      schedulePreviewChange(nextTransform)
      return
    }

    const nextAngle = Math.atan2(
      point.y - currentSession.center.y,
      point.x - currentSession.center.x
    )
    const nextRotation =
      currentSession.startTransform.rotation +
      ((nextAngle - currentSession.startAngleRad) * 180) / Math.PI
    const nextTransform = resolveRotatedTransform({
      center: currentSession.center,
      nextRotation,
      startTransform: currentSession.startTransform,
      width: item.width,
      height: item.height
    })
    draftTransformRef.current = nextTransform
    applyElementTransform(nextTransform)
    schedulePreviewChange(nextTransform)
  }

  windowPointerUpHandlerRef.current = (event: PointerEvent) => {
    if (event.pointerId !== sessionRef.current?.pointerId) {
      return
    }
    finishSession(event)
  }

  const startDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const { stagePos: currentStagePos, stageScale: currentStageScale } =
        resolveStageTransformSnapshot(stagePosRef, stageScaleRef, stagePos, stageScale)
      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        currentStagePos,
        currentStageScale,
        event.clientX,
        event.clientY,
        capturePointerCanvasViewportRect()
      )
      if (!point) {
        return false
      }

      sessionRef.current = {
        kind: 'drag',
        pointerId: event.pointerId,
        startPoint: point,
        startTransform: committedTransform,
        moved: false
      }
      attachWindowPointerListeners()
      return true
    },
    [
      attachWindowPointerListeners,
      canvasContainerRef,
      capturePointerCanvasViewportRect,
      committedTransform,
      stagePos,
      stagePosRef,
      stageScale,
      stageScaleRef
    ]
  )

  const handleNodePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return
      }

      if (allowPointerPassthrough) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (isCanvasAdditiveSelectionModifier(event)) {
        shouldSelectOnDragFinishRef.current = false
        onSelect(true)
        return
      }

      if (isDraggable) {
        shouldSelectOnDragFinishRef.current = !isSelected
        if (startDrag(event)) {
          return
        }
      }

      shouldSelectOnDragFinishRef.current = false
      if (!(isSelected && selectedCount > 1)) {
        onSelect(false)
      }
    },
    [allowPointerPassthrough, isDraggable, isSelected, onSelect, selectedCount, startDrag]
  )

  const handleContextMenu = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onContextMenu?.(event.nativeEvent)
    },
    [onContextMenu]
  )

  const startResize = React.useCallback(
    (handle: CornerHandle, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      sessionRef.current = {
        kind: 'resize',
        pointerId: event.pointerId,
        handle,
        startTransform: committedTransform
      }
      draftTransformRef.current = committedTransform
      applyElementTransform(committedTransform)
      setDraftTransform(committedTransform)
      attachWindowPointerListeners()
    },
    [attachWindowPointerListeners, committedTransform, applyElementTransform]
  )

  const startRotate = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      const { stagePos: currentStagePos, stageScale: currentStageScale } =
        resolveStageTransformSnapshot(stagePosRef, stageScaleRef, stagePos, stageScale)
      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        currentStagePos,
        currentStageScale,
        event.clientX,
        event.clientY,
        capturePointerCanvasViewportRect()
      )
      if (!point) {
        return
      }

      const center = getImageCenter(committedTransform, item.width, item.height)
      sessionRef.current = {
        kind: 'rotate',
        pointerId: event.pointerId,
        startAngleRad: Math.atan2(point.y - center.y, point.x - center.x),
        startTransform: committedTransform,
        center
      }
      draftTransformRef.current = committedTransform
      applyElementTransform(committedTransform)
      setDraftTransform(committedTransform)
      attachWindowPointerListeners()
    },
    [
      attachWindowPointerListeners,
      committedTransform,
      applyElementTransform,
      canvasContainerRef,
      capturePointerCanvasViewportRect,
      item.height,
      item.width,
      stagePos,
      stagePosRef,
      stageScale,
      stageScaleRef
    ]
  )

  const handleScaleCompensation =
    1 / Math.max(Math.abs(activeTransform.scaleX), Math.abs(activeTransform.scaleY), 1)
  const selectionOutlineScaleCompensation =
    1 /
    Math.max(
      Math.abs(stageScale) *
        Math.max(Math.abs(activeTransform.scaleX), Math.abs(activeTransform.scaleY), 0.0001),
      0.0001
    )
  const showDomImagePreview =
    !suppressImagePreview &&
    ((preferDomImagePreview && renderMode === 'webgl-primary') ||
      renderMode === 'budget-image-proxy' ||
      renderMode === 'fallback-image-proxy')

  return (
    <Box
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        overflow: 'visible',
        pointerEvents: 'none'
      }}
    >
      <Box
        ref={elementRef}
        data-canvas-item-id={item.id}
        data-canvas-overlay="image-interaction"
        data-canvas-overlay-role="image-interaction"
        data-canvas-render-mode={renderMode}
        onPointerDown={handleNodePointerDown}
        onContextMenu={handleContextMenu}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: item.width,
          height: item.height,
          transform: buildElementTransform(activeTransform),
          transformOrigin: '0 0',
          willChange: 'transform',
          pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
          cursor: isDraggable ? 'move' : 'pointer',
          touchAction: 'none',
          zIndex: item.zIndex,
          ...buildCanvasSelectionOutlineStyles(isSelected, {
            scaleCompensation: selectionOutlineScaleCompensation
          })
        }}
      >
        {showDomImagePreview && (
          <CanvasImageDomPreview
            item={item}
            previewMode={renderMode}
            borderRadius="4px"
            backgroundColor={domImagePreviewBackdropColor}
            stageScale={stageScale}
          />
        )}
        {showTransformer && (
          <>
            {HANDLE_POSITIONS.map(({ handle, left, top }) => (
              <Box
                key={handle}
                data-canvas-image-handle={handle}
                onPointerDown={(event: React.PointerEvent<HTMLDivElement>) =>
                  startResize(handle, event)
                }
                sx={{
                  position: 'absolute',
                  left,
                  top,
                  width: HANDLE_HIT_SIZE,
                  height: HANDLE_HIT_SIZE,
                  transform: `translate(-50%, -50%) scale(${handleScaleCompensation})`,
                  transformOrigin: 'center',
                  zIndex: 2,
                  cursor:
                    handle === 'top-left' || handle === 'bottom-right'
                      ? 'nwse-resize'
                      : 'nesw-resize'
                }}
              >
                <Box
                  sx={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                    transform: 'translate(-50%, -50%)',
                    borderRadius: '2px',
                    bgcolor: '#6366f1',
                    border: '1.5px solid #ffffff',
                    boxShadow: '0 2px 8px rgba(15,23,42,0.22)',
                    pointerEvents: 'none'
                  }}
                />
              </Box>
            ))}
            {CORNER_ROTATE_HOTSPOTS.map(
              ({ handle, part, left, top, offsetX, offsetY, width, height, anchorMode }) => {
                const compensatedOffsetX = offsetX * handleScaleCompensation
                const compensatedOffsetY = offsetY * handleScaleCompensation
                const compensatedWidth = width * handleScaleCompensation
                const compensatedHeight = height * handleScaleCompensation
                return (
                  <Box
                    key={`${handle}-rotate-${part}`}
                    data-canvas-image-rotate-hotspot={handle}
                    data-canvas-image-rotate-hotspot-part={part}
                    onPointerDown={startRotate}
                    sx={{
                      position: 'absolute',
                      left: toCssOffset(left, compensatedOffsetX),
                      top: toCssOffset(top, compensatedOffsetY),
                      width: compensatedWidth,
                      height: compensatedHeight,
                      transform: anchorMode === 'center' ? 'translate(-50%, -50%)' : 'none',
                      transformOrigin: 'center',
                      borderRadius: '999px',
                      bgcolor: 'transparent',
                      pointerEvents: 'auto',
                      zIndex: 1,
                      cursor: ROTATE_CURSOR
                    }}
                  />
                )
              }
            )}
          </>
        )}
      </Box>
    </Box>
  )
}

function areImageInteractionOverlayPropsEqual(
  previousProps: Readonly<ProjectCanvasImageInteractionOverlayProps>,
  nextProps: Readonly<ProjectCanvasImageInteractionOverlayProps>
) {
  const usesDomImagePreview = (props: Readonly<ProjectCanvasImageInteractionOverlayProps>) =>
    !props.suppressImagePreview &&
    ((props.preferDomImagePreview && props.renderMode === 'webgl-primary') ||
      props.renderMode === 'budget-image-proxy' ||
      props.renderMode === 'fallback-image-proxy')
  const requiresViewportSync =
    previousProps.isSelected ||
    nextProps.isSelected ||
    usesDomImagePreview(previousProps) ||
    usesDomImagePreview(nextProps)
  const canUseStageRefs =
    previousProps.stagePosRef != null &&
    previousProps.stageScaleRef != null &&
    previousProps.stagePosRef === nextProps.stagePosRef &&
    previousProps.stageScaleRef === nextProps.stageScaleRef
  const stageTransformEqual = requiresViewportSync
    ? hasSameStageTransform(
        previousProps.stagePos,
        previousProps.stageScale,
        nextProps.stagePos,
        nextProps.stageScale
      )
    : canUseStageRefs ||
      hasSameStageTransform(
        previousProps.stagePos,
        previousProps.stageScale,
        nextProps.stagePos,
        nextProps.stageScale
      )

  return (
    previousProps.canvasContainerRef === nextProps.canvasContainerRef &&
    previousProps.item === nextProps.item &&
    previousProps.isSelected === nextProps.isSelected &&
    previousProps.selectedCount === nextProps.selectedCount &&
    previousProps.renderMode === nextProps.renderMode &&
    previousProps.suppressImagePreview === nextProps.suppressImagePreview &&
    previousProps.preferDomImagePreview === nextProps.preferDomImagePreview &&
    previousProps.domImagePreviewBackdropColor === nextProps.domImagePreviewBackdropColor &&
    previousProps.isDraggable === nextProps.isDraggable &&
    previousProps.showTransformer === nextProps.showTransformer &&
    stageTransformEqual &&
    previousProps.stagePosRef === nextProps.stagePosRef &&
    previousProps.stageScaleRef === nextProps.stageScaleRef &&
    previousProps.onPreviewChange === nextProps.onPreviewChange &&
    previousProps.broadcastDomPreviewSync === nextProps.broadcastDomPreviewSync &&
    previousProps.onSelect === nextProps.onSelect &&
    previousProps.onDragEnd === nextProps.onDragEnd &&
    previousProps.onTransformEnd === nextProps.onTransformEnd &&
    previousProps.onContextMenu === nextProps.onContextMenu
  )
}

export default React.memo(
  ProjectCanvasImageInteractionOverlay,
  areImageInteractionOverlayPropsEqual
)
