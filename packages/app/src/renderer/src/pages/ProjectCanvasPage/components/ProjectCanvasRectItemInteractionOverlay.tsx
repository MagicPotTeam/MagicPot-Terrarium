import React from 'react'
import { Box } from '@mui/material'
import { buildCanvasSelectionOutlineStyles } from './projectCanvasInteractionOverlayStyles'
import { findCanvasSelectionToolbar } from '../canvasDomOverlayLookup'
import { isCanvasAdditiveSelectionModifier } from '../canvasSelectionModifiers'
import type { SelectionActionStackPlacement } from '../canvasSelectionLayoutUtils'
import { resolveSelectionActionToolbarPosition } from '../canvasSelectionLayoutUtils'

type CanvasPoint = {
  x: number
  y: number
}

type CanvasViewportRect = {
  left: number
  top: number
}

export type ProjectCanvasRectItemTransform = {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

type RectInteractionItem = ProjectCanvasRectItemTransform & {
  id: string
  width: number
  height: number
  zIndex: number
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

type CornerHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
type CornerRotateHotspotPart = 'circle' | 'horizontal' | 'vertical'
type DragEdge = 'top' | 'right' | 'bottom' | 'left'
type ContentDragSurfaceInset = Partial<Record<DragEdge, number>>

export type ProjectCanvasRectItemInteractionHandle = ResizeHandle | 'rotate' | 'drag'
export type ProjectCanvasRectItemTransformHandle = ResizeHandle | 'rotate'

type RotateSession = {
  kind: 'rotate'
  pointerId: number
  startAngleRad: number
  startTransform: ProjectCanvasRectItemTransform
  center: CanvasPoint
}

type DragSession = {
  kind: 'drag'
  pointerId: number
  startPoint: CanvasPoint
  startTransform: ProjectCanvasRectItemTransform
  moved: boolean
}

type ResizeSession = {
  kind: 'resize'
  pointerId: number
  handle: ResizeHandle
  startTransform: ProjectCanvasRectItemTransform
}

type InteractionSession = DragSession | ResizeSession | RotateSession

type ProjectCanvasRectItemInteractionOverlayProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  item: RectInteractionItem
  isSelected: boolean
  isDraggable: boolean
  showTransformer: boolean
  previewContent?: React.ReactNode
  allowPointerPassthrough?: boolean
  contentPointerPassthrough?: boolean
  contentDragEdges?: ReadonlyArray<DragEdge>
  contentDragSurfaceInset?: ContentDragSurfaceInset
  lockCornerAspectRatio?: boolean
  visualVariant?: 'transparent' | 'image-fallback'
  stagePos: { x: number; y: number }
  stageScale: number
  stagePosRef?: React.MutableRefObject<{ x: number; y: number }>
  stageScaleRef?: React.MutableRefObject<number>
  minWidth?: number
  minHeight?: number
  overlayRole: string
  floatingToolbarSelector?: string
  onPreviewChange?: (
    itemId: string,
    preview: ProjectCanvasRectItemTransform | null,
    handle: ProjectCanvasRectItemInteractionHandle | null
  ) => void
  onDragStart?: (itemId: string) => void
  onSelect: (additiveSelection?: boolean) => void
  onDragEnd: (id: string, x: number, y: number, evt?: PointerEvent) => void
  onTransformEnd: (
    id: string,
    attrs: ProjectCanvasRectItemTransform,
    handle: ProjectCanvasRectItemTransformHandle
  ) => void
  onDoubleClick?: () => void
  onContextMenu?: (event: MouseEvent | PointerEvent) => void
  onHoverChange?: (isHovering: boolean) => void
}

const DEFAULT_MIN_SIZE = 20
const HANDLE_SIZE = 10
const HANDLE_HIT_SIZE = 28
const HANDLE_HIT_HALF = HANDLE_HIT_SIZE / 2
const DRAG_EDGE_HIT_SIZE = 12
const DEFAULT_CONTENT_DRAG_EDGES: readonly DragEdge[] = ['top', 'right', 'bottom', 'left']
const CORNER_ROTATE_CONNECTOR_THICKNESS = 16
const CORNER_ROTATE_HOTSPOT_RADIUS = 24
const CORNER_ROTATE_HOTSPOT_SIZE = CORNER_ROTATE_HOTSPOT_RADIUS * 2
const CORNER_ROTATE_HOTSPOT_OFFSET = 40
const CANVAS_DOUBLE_CLICK_INTERVAL_MS = 320
const CANVAS_DOUBLE_CLICK_MAX_DISTANCE_PX = 8
const rotateCursorUrl = new URL('../../../assets/cursors/rotate-cursor.svg', import.meta.url).href
const ROTATE_CURSOR = `url("${rotateCursorUrl}") 12 12, grab`
const DEFAULT_SELECTION_TOOLBAR_WIDTH = 320
const DEFAULT_SELECTION_TOOLBAR_HEIGHT = 44
const PROTECTED_SELECTION_OVERLAY_SELECTOR =
  '[data-canvas-overlay="annotation"], [data-canvas-overlay="text"]'
const recentCanvasPointerDownByItemId = new Map<
  string,
  { timestamp: number; clientX: number; clientY: number }
>()

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

function resolveFloatingToolbarSelector(
  overlayRole: string,
  explicitSelector: string | undefined
): string | null {
  if (explicitSelector) {
    return explicitSelector
  }

  if (overlayRole === 'file-interaction') {
    return '.file-item-action-toolbar'
  }

  if (overlayRole === 'text-interaction' || overlayRole === 'annotation-interaction') {
    return '.textlike-action-toolbar'
  }

  return null
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

function buildElementTransform(transform: ProjectCanvasRectItemTransform): string {
  return `translate3d(${transform.x}px, ${transform.y}px, 0) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`
}

const HANDLE_POSITIONS: Array<{ handle: ResizeHandle; left: string; top: string; cursor: string }> =
  [
    { handle: 'top-left', left: '0%', top: '0%', cursor: 'nwse-resize' },
    { handle: 'top-center', left: '50%', top: '0%', cursor: 'ns-resize' },
    { handle: 'top-right', left: '100%', top: '0%', cursor: 'nesw-resize' },
    { handle: 'middle-left', left: '0%', top: '50%', cursor: 'ew-resize' },
    { handle: 'middle-right', left: '100%', top: '50%', cursor: 'ew-resize' },
    { handle: 'bottom-left', left: '0%', top: '100%', cursor: 'nesw-resize' },
    { handle: 'bottom-center', left: '50%', top: '100%', cursor: 'ns-resize' },
    { handle: 'bottom-right', left: '100%', top: '100%', cursor: 'nwse-resize' }
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

function isCornerHandle(handle: ResizeHandle): handle is CornerHandle {
  return (
    handle === 'top-left' ||
    handle === 'top-right' ||
    handle === 'bottom-left' ||
    handle === 'bottom-right'
  )
}

function toCssOffset(base: string, delta: number): string {
  if (Math.abs(delta) < 0.001) {
    return base
  }

  return delta >= 0 ? `calc(${base} + ${delta}px)` : `calc(${base} - ${Math.abs(delta)}px)`
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
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
  transform: ProjectCanvasRectItemTransform,
  width: number,
  height: number,
  handle: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
): CanvasPoint {
  const scaledWidth = width * transform.scaleX
  const scaledHeight = height * transform.scaleY
  const offset =
    handle === 'top-left'
      ? { x: 0, y: 0 }
      : handle === 'top-right'
        ? { x: scaledWidth, y: 0 }
        : handle === 'bottom-left'
          ? { x: 0, y: scaledHeight }
          : { x: scaledWidth, y: scaledHeight }

  return addPoints({ x: transform.x, y: transform.y }, rotateVector(offset, transform.rotation))
}

function getCornerHandleVector(
  transform: ProjectCanvasRectItemTransform,
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

function getEdgePoint(
  transform: ProjectCanvasRectItemTransform,
  width: number,
  height: number,
  handle: 'top-center' | 'bottom-center' | 'middle-left' | 'middle-right'
): CanvasPoint {
  const scaledWidth = width * transform.scaleX
  const scaledHeight = height * transform.scaleY
  const offset =
    handle === 'top-center'
      ? { x: scaledWidth / 2, y: 0 }
      : handle === 'bottom-center'
        ? { x: scaledWidth / 2, y: scaledHeight }
        : handle === 'middle-left'
          ? { x: 0, y: scaledHeight / 2 }
          : { x: scaledWidth, y: scaledHeight / 2 }

  return addPoints({ x: transform.x, y: transform.y }, rotateVector(offset, transform.rotation))
}

function getItemCenter(
  transform: ProjectCanvasRectItemTransform,
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

function resolveResizedTransform(options: {
  handle: ResizeHandle
  pointer: CanvasPoint
  startTransform: ProjectCanvasRectItemTransform
  width: number
  height: number
  minWidth: number
  minHeight: number
  lockCornerAspectRatio: boolean
}): ProjectCanvasRectItemTransform {
  const {
    handle,
    pointer,
    startTransform,
    width,
    height,
    minWidth,
    minHeight,
    lockCornerAspectRatio
  } = options
  const { xAxis, yAxis } = getCanvasAxes(startTransform.rotation)
  const scaledWidth = width * startTransform.scaleX
  const scaledHeight = height * startTransform.scaleY

  if (
    handle === 'top-left' ||
    handle === 'top-right' ||
    handle === 'bottom-left' ||
    handle === 'bottom-right'
  ) {
    const fixedPoint = getCornerPoint(
      startTransform,
      width,
      height,
      handle === 'top-left'
        ? 'bottom-right'
        : handle === 'top-right'
          ? 'bottom-left'
          : handle === 'bottom-left'
            ? 'top-right'
            : 'top-left'
    )
    const delta = subtractPoints(pointer, fixedPoint)
    if (lockCornerAspectRatio) {
      const handleVector = getCornerHandleVector(startTransform, width, height, handle)
      const handleVectorLengthSquared = Math.max(dotProduct(handleVector, handleVector), 0.0001)
      const scaleFactor = Math.max(
        Math.max(
          minWidth / Math.max(Math.abs(width * startTransform.scaleX), 1),
          minHeight / Math.max(Math.abs(height * startTransform.scaleY), 1)
        ),
        dotProduct(delta, handleVector) / handleVectorLengthSquared
      )
      const nextScaleX = startTransform.scaleX * scaleFactor
      const nextScaleY = startTransform.scaleY * scaleFactor

      if (handle === 'top-left') {
        const nextTopLeft = addPoints(fixedPoint, {
          x: handleVector.x * scaleFactor,
          y: handleVector.y * scaleFactor
        })
        return {
          ...startTransform,
          x: nextTopLeft.x,
          y: nextTopLeft.y,
          scaleX: nextScaleX,
          scaleY: nextScaleY
        }
      }

      if (handle === 'top-right') {
        const nextTopLeft = subtractPoints(
          fixedPoint,
          rotateVector({ x: 0, y: height * nextScaleY }, startTransform.rotation)
        )
        return {
          ...startTransform,
          x: nextTopLeft.x,
          y: nextTopLeft.y,
          scaleX: nextScaleX,
          scaleY: nextScaleY
        }
      }

      if (handle === 'bottom-left') {
        const nextTopLeft = subtractPoints(
          fixedPoint,
          rotateVector({ x: width * nextScaleX, y: 0 }, startTransform.rotation)
        )
        return {
          ...startTransform,
          x: nextTopLeft.x,
          y: nextTopLeft.y,
          scaleX: nextScaleX,
          scaleY: nextScaleY
        }
      }

      return {
        ...startTransform,
        scaleX: nextScaleX,
        scaleY: nextScaleY
      }
    }

    const projectedWidth =
      handle === 'top-left' || handle === 'bottom-left'
        ? -dotProduct(delta, xAxis)
        : dotProduct(delta, xAxis)
    const projectedHeight =
      handle === 'top-left' || handle === 'top-right'
        ? -dotProduct(delta, yAxis)
        : dotProduct(delta, yAxis)

    const nextWidth = Math.max(minWidth, projectedWidth)
    const nextHeight = Math.max(minHeight, projectedHeight)
    const nextScaleX = nextWidth / Math.max(width, 1)
    const nextScaleY = nextHeight / Math.max(height, 1)

    if (handle === 'top-left') {
      const nextTopLeft = subtractPoints(
        fixedPoint,
        rotateVector({ x: nextWidth, y: nextHeight }, startTransform.rotation)
      )
      return {
        ...startTransform,
        x: nextTopLeft.x,
        y: nextTopLeft.y,
        scaleX: nextScaleX,
        scaleY: nextScaleY
      }
    }

    if (handle === 'top-right') {
      const nextTopLeft = subtractPoints(
        fixedPoint,
        rotateVector({ x: 0, y: nextHeight }, startTransform.rotation)
      )
      return {
        ...startTransform,
        x: nextTopLeft.x,
        y: nextTopLeft.y,
        scaleX: nextScaleX,
        scaleY: nextScaleY
      }
    }

    if (handle === 'bottom-left') {
      const nextTopLeft = subtractPoints(
        fixedPoint,
        rotateVector({ x: nextWidth, y: 0 }, startTransform.rotation)
      )
      return {
        ...startTransform,
        x: nextTopLeft.x,
        y: nextTopLeft.y,
        scaleX: nextScaleX,
        scaleY: nextScaleY
      }
    }

    return {
      ...startTransform,
      scaleX: nextScaleX,
      scaleY: nextScaleY
    }
  }

  if (handle === 'top-center' || handle === 'bottom-center') {
    const fixedPoint = getEdgePoint(
      startTransform,
      width,
      height,
      handle === 'top-center' ? 'bottom-center' : 'top-center'
    )
    const delta = subtractPoints(pointer, fixedPoint)
    const projectedHeight =
      handle === 'top-center' ? -dotProduct(delta, yAxis) : dotProduct(delta, yAxis)
    const nextHeight = Math.max(minHeight, projectedHeight)
    const nextScaleY = nextHeight / Math.max(height, 1)

    if (handle === 'top-center') {
      const nextTopLeft = subtractPoints(
        fixedPoint,
        rotateVector({ x: scaledWidth / 2, y: nextHeight }, startTransform.rotation)
      )
      return {
        ...startTransform,
        x: nextTopLeft.x,
        y: nextTopLeft.y,
        scaleY: nextScaleY
      }
    }

    const nextTopLeft = subtractPoints(
      fixedPoint,
      rotateVector({ x: scaledWidth / 2, y: 0 }, startTransform.rotation)
    )
    return {
      ...startTransform,
      x: nextTopLeft.x,
      y: nextTopLeft.y,
      scaleY: nextScaleY
    }
  }

  const fixedPoint = getEdgePoint(
    startTransform,
    width,
    height,
    handle === 'middle-left' ? 'middle-right' : 'middle-left'
  )
  const delta = subtractPoints(pointer, fixedPoint)
  const projectedWidth =
    handle === 'middle-left' ? -dotProduct(delta, xAxis) : dotProduct(delta, xAxis)
  const nextWidth = Math.max(minWidth, projectedWidth)
  const nextScaleX = nextWidth / Math.max(width, 1)

  if (handle === 'middle-left') {
    const nextTopLeft = subtractPoints(
      fixedPoint,
      rotateVector({ x: nextWidth, y: scaledHeight / 2 }, startTransform.rotation)
    )
    return {
      ...startTransform,
      x: nextTopLeft.x,
      y: nextTopLeft.y,
      scaleX: nextScaleX
    }
  }

  const nextTopLeft = subtractPoints(
    fixedPoint,
    rotateVector({ x: 0, y: scaledHeight / 2 }, startTransform.rotation)
  )
  return {
    ...startTransform,
    x: nextTopLeft.x,
    y: nextTopLeft.y,
    scaleX: nextScaleX
  }
}

function resolveRotatedTransform(options: {
  center: CanvasPoint
  nextRotation: number
  startTransform: ProjectCanvasRectItemTransform
  width: number
  height: number
}): ProjectCanvasRectItemTransform {
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

function resolveInteractionHandle(
  session: InteractionSession | null
): ProjectCanvasRectItemInteractionHandle | null {
  if (!session) {
    return null
  }

  if (session.kind === 'resize') {
    return session.handle
  }

  if (session.kind === 'rotate') {
    return 'rotate'
  }

  return 'drag'
}

const ProjectCanvasRectItemInteractionOverlay: React.FC<
  ProjectCanvasRectItemInteractionOverlayProps
> = ({
  canvasContainerRef,
  item,
  isSelected,
  isDraggable,
  showTransformer,
  previewContent,
  allowPointerPassthrough = false,
  contentPointerPassthrough = false,
  contentDragEdges = DEFAULT_CONTENT_DRAG_EDGES,
  contentDragSurfaceInset,
  lockCornerAspectRatio = false,
  visualVariant = 'transparent',
  stagePos,
  stageScale,
  stagePosRef,
  stageScaleRef,
  minWidth = DEFAULT_MIN_SIZE,
  minHeight = DEFAULT_MIN_SIZE,
  overlayRole,
  floatingToolbarSelector,
  onPreviewChange,
  onDragStart,
  onSelect,
  onDragEnd,
  onTransformEnd,
  onDoubleClick,
  onContextMenu,
  onHoverChange
}) => {
  const elementRef = React.useRef<HTMLDivElement | null>(null)
  const sessionRef = React.useRef<InteractionSession | null>(null)
  const draftTransformRef = React.useRef<ProjectCanvasRectItemTransform | null>(null)
  const pendingPreviewRef = React.useRef<{
    transform: ProjectCanvasRectItemTransform
    handle: ProjectCanvasRectItemInteractionHandle | null
  } | null>(null)
  const previewCommitFrameRef = React.useRef<number | null>(null)
  const pointerCanvasViewportRectRef = React.useRef<CanvasViewportRect | null>(null)
  const windowPointerMoveHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const windowPointerUpHandlerRef = React.useRef<(event: PointerEvent) => void>(() => {})
  const detachWindowPointerListenersRef = React.useRef<(() => void) | null>(null)
  const hasRuntimePreviewRef = React.useRef(false)
  const shouldSelectOnDragFinishRef = React.useRef(false)
  const committedTransformRef = React.useRef({
    id: item.id,
    width: item.width,
    height: item.height,
    x: item.x,
    y: item.y,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    rotation: item.rotation
  })
  const [draftTransform, setDraftTransform] = React.useState<ProjectCanvasRectItemTransform | null>(
    null
  )
  const resolvedFloatingToolbarSelector = React.useMemo(
    () => resolveFloatingToolbarSelector(overlayRole, floatingToolbarSelector),
    [floatingToolbarSelector, overlayRole]
  )

  const activeTransform = React.useMemo(
    () =>
      draftTransform ?? {
        x: item.x,
        y: item.y,
        scaleX: item.scaleX,
        scaleY: item.scaleY,
        rotation: item.rotation
      },
    [draftTransform, item.rotation, item.scaleX, item.scaleY, item.x, item.y]
  )

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

  React.useLayoutEffect(() => {
    const previousCommittedTransform = committedTransformRef.current
    const didCommittedTransformChange =
      previousCommittedTransform.id === item.id &&
      (previousCommittedTransform.width !== item.width ||
        previousCommittedTransform.height !== item.height ||
        previousCommittedTransform.x !== item.x ||
        previousCommittedTransform.y !== item.y ||
        previousCommittedTransform.scaleX !== item.scaleX ||
        previousCommittedTransform.scaleY !== item.scaleY ||
        previousCommittedTransform.rotation !== item.rotation)

    committedTransformRef.current = {
      id: item.id,
      width: item.width,
      height: item.height,
      x: item.x,
      y: item.y,
      scaleX: item.scaleX,
      scaleY: item.scaleY,
      rotation: item.rotation
    }

    if (!didCommittedTransformChange || sessionRef.current) {
      return
    }

    hasRuntimePreviewRef.current = false
    draftTransformRef.current = null
    setDraftTransform(null)
    window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))
    onPreviewChange?.(item.id, null, null)
  }, [
    item.height,
    item.id,
    item.rotation,
    item.scaleX,
    item.scaleY,
    item.width,
    item.x,
    item.y,
    onPreviewChange
  ])

  const applyElementTransform = React.useCallback((transform: ProjectCanvasRectItemTransform) => {
    const element = elementRef.current
    if (!element) {
      return
    }

    element.style.transform = buildElementTransform(transform)
  }, [])

  React.useLayoutEffect(() => {
    applyElementTransform(draftTransformRef.current ?? activeTransform)
  }, [activeTransform, applyElementTransform])

  const cancelPendingPreviewCommit = React.useCallback(() => {
    if (previewCommitFrameRef.current == null) {
      return
    }

    window.cancelAnimationFrame(previewCommitFrameRef.current)
    previewCommitFrameRef.current = null
  }, [])

  const emitPreviewChangeNow = React.useCallback(
    (
      transform: ProjectCanvasRectItemTransform,
      handle: ProjectCanvasRectItemInteractionHandle | null
    ) => {
      onPreviewChange?.(item.id, transform, handle)
    },
    [item.id, onPreviewChange]
  )

  const flushPendingPreviewChange = React.useCallback(
    (
      nextTransform?: ProjectCanvasRectItemTransform,
      session: InteractionSession | null = sessionRef.current
    ) => {
      cancelPendingPreviewCommit()
      const pendingPreview = nextTransform
        ? {
            transform: nextTransform,
            handle: resolveInteractionHandle(session)
          }
        : pendingPreviewRef.current
      pendingPreviewRef.current = null
      if (!pendingPreview) {
        return
      }

      emitPreviewChangeNow(pendingPreview.transform, pendingPreview.handle)
    },
    [cancelPendingPreviewCommit, emitPreviewChangeNow]
  )

  const schedulePreviewChange = React.useCallback(
    (
      transform: ProjectCanvasRectItemTransform,
      session: InteractionSession | null = sessionRef.current
    ) => {
      pendingPreviewRef.current = {
        transform,
        handle: resolveInteractionHandle(session)
      }
      if (previewCommitFrameRef.current != null) {
        return
      }

      previewCommitFrameRef.current = window.requestAnimationFrame(() => {
        previewCommitFrameRef.current = null
        const pendingPreview = pendingPreviewRef.current
        pendingPreviewRef.current = null
        if (!pendingPreview) {
          return
        }

        emitPreviewChangeNow(pendingPreview.transform, pendingPreview.handle)
      })
    },
    [emitPreviewChangeNow]
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

  const flushPendingDraftTransformCommit = React.useCallback(
    (nextTransform: ProjectCanvasRectItemTransform | null = draftTransformRef.current ?? null) => {
      setDraftTransform(nextTransform)
    },
    []
  )

  React.useEffect(() => {
    return () => {
      cancelPendingPreviewCommit()
      pendingPreviewRef.current = null
      clearPointerCanvasViewportRect()
      shouldSelectOnDragFinishRef.current = false
      if (hasRuntimePreviewRef.current) {
        hasRuntimePreviewRef.current = false
        window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))
        onPreviewChange?.(item.id, null, null)
      }
    }
  }, [
    cancelPendingPreviewCommit,
    clearPointerCanvasViewportRect,
    item.id,
    onPreviewChange,
    shouldSelectOnDragFinishRef
  ])

  React.useEffect(() => {
    const resetDraftTransform = () => {
      if (sessionRef.current) {
        return
      }

      shouldSelectOnDragFinishRef.current = false
      hasRuntimePreviewRef.current = false
      sessionRef.current = null
      draftTransformRef.current = null
      cancelPendingPreviewCommit()
      pendingPreviewRef.current = null
      clearPointerCanvasViewportRect()
      setDraftTransform(null)
      onPreviewChange?.(item.id, null, null)
    }

    window.addEventListener(`canvas-reset-${item.id}`, resetDraftTransform)
    return () => {
      window.removeEventListener(`canvas-reset-${item.id}`, resetDraftTransform)
    }
  }, [
    cancelPendingPreviewCommit,
    clearPointerCanvasViewportRect,
    item.id,
    onPreviewChange,
    shouldSelectOnDragFinishRef
  ])

  const updateFloatingToolbarPosition = React.useCallback(() => {
    if (!isSelected) {
      return true
    }

    if (!resolvedFloatingToolbarSelector) {
      return true
    }

    const element = elementRef.current
    const canvasContainer = canvasContainerRef.current
    const toolbar = resolvedFloatingToolbarSelector
      ? findCanvasSelectionToolbar(canvasContainer, resolvedFloatingToolbarSelector, item.id)
      : null
    if (!element || !canvasContainer || !toolbar) {
      return false
    }

    const elementRect = element.getBoundingClientRect()
    const containerRect = canvasContainer.getBoundingClientRect()
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
        minX: elementRect.left - containerRect.left,
        minY: elementRect.top - containerRect.top,
        maxX: elementRect.right - containerRect.left,
        maxY: elementRect.bottom - containerRect.top
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
  }, [canvasContainerRef, isSelected, item.id, resolvedFloatingToolbarSelector])

  const updateLiveBoundsDisplay = React.useCallback(
    (transform: ProjectCanvasRectItemTransform) => {
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
    if (updateFloatingToolbarPosition()) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      updateFloatingToolbarPosition()
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
        hasRuntimePreviewRef.current = false
        draftTransformRef.current = null
        cancelPendingPreviewCommit()
        pendingPreviewRef.current = null
        flushPendingDraftTransformCommit(null)
        onPreviewChange?.(item.id, null, null)
        if (shouldSelectOnDragFinish) {
          onSelect(false)
        }
        return
      }

      const currentTransform = draftTransformRef.current ??
        draftTransform ?? {
          x: item.x,
          y: item.y,
          scaleX: item.scaleX,
          scaleY: item.scaleY,
          rotation: item.rotation
        }

      draftTransformRef.current = currentTransform
      flushPendingDraftTransformCommit(currentTransform)
      updateFloatingToolbarPosition()

      if (currentSession.kind === 'drag') {
        flushPendingPreviewChange(currentTransform, currentSession)
        onDragEnd(item.id, currentTransform.x, currentTransform.y, event)
        if (shouldSelectOnDragFinish) {
          onSelect(false)
        }
      } else {
        flushPendingPreviewChange(currentTransform, currentSession)
        onTransformEnd(
          item.id,
          currentTransform,
          currentSession.kind === 'resize' ? currentSession.handle : 'rotate'
        )
      }
    },
    [
      draftTransform,
      item.id,
      item.rotation,
      item.scaleX,
      item.scaleY,
      item.x,
      item.y,
      onDragEnd,
      onTransformEnd,
      onPreviewChange,
      onSelect,
      cancelPendingPreviewCommit,
      clearPointerCanvasViewportRect,
      detachWindowPointerListeners,
      flushPendingDraftTransformCommit,
      flushPendingPreviewChange,
      updateFloatingToolbarPosition
    ]
  )

  windowPointerMoveHandlerRef.current = (event: PointerEvent) => {
    const currentSession = sessionRef.current
    if (!currentSession || event.pointerId !== currentSession.pointerId) {
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
        hasRuntimePreviewRef.current = true
        onDragStart?.(item.id)
        if (!isSelected && shouldSelectOnDragFinishRef.current) {
          shouldSelectOnDragFinishRef.current = false
          onSelect(false)
        }
      }

      const nextTransform = {
        ...currentSession.startTransform,
        x: currentSession.startTransform.x + delta.x,
        y: currentSession.startTransform.y + delta.y
      }
      draftTransformRef.current = nextTransform
      applyElementTransform(nextTransform)
      schedulePreviewChange(nextTransform, currentSession)
      return
    }

    if (currentSession.kind === 'resize') {
      const nextTransform = resolveResizedTransform({
        handle: currentSession.handle,
        pointer: point,
        startTransform: currentSession.startTransform,
        width: item.width,
        height: item.height,
        minWidth,
        minHeight,
        lockCornerAspectRatio
      })
      draftTransformRef.current = nextTransform
      applyElementTransform(nextTransform)
      updateLiveBoundsDisplay(nextTransform)
      schedulePreviewChange(nextTransform, currentSession)
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
    schedulePreviewChange(nextTransform, currentSession)
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
      const pointerViewportRect = capturePointerCanvasViewportRect()
      const point = getCanvasPointFromClient(
        canvasContainerRef.current,
        currentStagePos,
        currentStageScale,
        event.clientX,
        event.clientY,
        pointerViewportRect
      )
      if (!point) {
        return false
      }

      sessionRef.current = {
        kind: 'drag',
        pointerId: event.pointerId,
        startPoint: point,
        startTransform: activeTransform,
        moved: false
      }
      attachWindowPointerListeners()
      return true
    },
    [
      activeTransform,
      attachWindowPointerListeners,
      canvasContainerRef,
      capturePointerCanvasViewportRect,
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
        recentCanvasPointerDownByItemId.delete(item.id)
        shouldSelectOnDragFinishRef.current = false
        onSelect(true)
        return
      }

      if (onDoubleClick) {
        const timestamp =
          typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp)
            ? event.timeStamp
            : Date.now()
        const clientX = event.clientX
        const clientY = event.clientY
        const previousPointerDown = recentCanvasPointerDownByItemId.get(item.id)

        recentCanvasPointerDownByItemId.set(item.id, { timestamp, clientX, clientY })

        if (previousPointerDown) {
          const elapsed = timestamp - previousPointerDown.timestamp
          const dx = clientX - previousPointerDown.clientX
          const dy = clientY - previousPointerDown.clientY
          const isDoubleClick =
            elapsed >= 0 &&
            elapsed <= CANVAS_DOUBLE_CLICK_INTERVAL_MS &&
            dx * dx + dy * dy <= CANVAS_DOUBLE_CLICK_MAX_DISTANCE_PX ** 2

          if (isDoubleClick) {
            recentCanvasPointerDownByItemId.delete(item.id)
            onDoubleClick()
            return
          }
        }
      }

      if (isDraggable) {
        shouldSelectOnDragFinishRef.current = !isSelected
        if (startDrag(event)) {
          return
        }
      }

      shouldSelectOnDragFinishRef.current = false
      onSelect(false)
    },
    [allowPointerPassthrough, isDraggable, isSelected, item.id, onDoubleClick, onSelect, startDrag]
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
    (handle: ResizeHandle, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      capturePointerCanvasViewportRect()

      sessionRef.current = {
        kind: 'resize',
        pointerId: event.pointerId,
        handle,
        startTransform: activeTransform
      }
      hasRuntimePreviewRef.current = true
      draftTransformRef.current = activeTransform
      applyElementTransform(activeTransform)
      attachWindowPointerListeners()
    },
    [
      activeTransform,
      applyElementTransform,
      attachWindowPointerListeners,
      capturePointerCanvasViewportRect
    ]
  )

  const startRotate = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      const { stagePos: currentStagePos, stageScale: currentStageScale } =
        resolveStageTransformSnapshot(stagePosRef, stageScaleRef, stagePos, stageScale)
      const pointerViewportRect = capturePointerCanvasViewportRect()
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

      const center = getItemCenter(activeTransform, item.width, item.height)
      sessionRef.current = {
        kind: 'rotate',
        pointerId: event.pointerId,
        startAngleRad: Math.atan2(point.y - center.y, point.x - center.x),
        startTransform: activeTransform,
        center
      }
      hasRuntimePreviewRef.current = true
      draftTransformRef.current = activeTransform
      applyElementTransform(activeTransform)
      attachWindowPointerListeners()
    },
    [
      activeTransform,
      applyElementTransform,
      attachWindowPointerListeners,
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
  const isImageFallback = visualVariant === 'image-fallback'
  const enableContentPointerPassthrough = contentPointerPassthrough && !allowPointerPassthrough
  const contentDragEdgeSet = React.useMemo(
    () => new Set<DragEdge>(contentDragEdges),
    [contentDragEdges]
  )
  const contentDragSurfaceStyle = React.useMemo(() => {
    if (!contentDragSurfaceInset) {
      return null
    }

    const left = Math.max(0, contentDragSurfaceInset.left ?? 0)
    const right = Math.max(0, contentDragSurfaceInset.right ?? 0)
    const top = Math.max(0, contentDragSurfaceInset.top ?? 0)
    const bottom = Math.max(0, contentDragSurfaceInset.bottom ?? 0)

    if (left + right >= item.width || top + bottom >= item.height) {
      return null
    }

    return { left, right, top, bottom }
  }, [contentDragSurfaceInset, item.height, item.width])
  const dragEdgeThickness = Math.min(
    DRAG_EDGE_HIT_SIZE * handleScaleCompensation,
    Math.max(4, Math.min(item.width, item.height) / 3)
  )

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
        data-canvas-overlay="rect-interaction"
        data-canvas-overlay-role={overlayRole}
        data-canvas-overlay-content-pointer-passthrough={
          enableContentPointerPassthrough ? 'true' : 'false'
        }
        onPointerDown={handleNodePointerDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: item.width,
          height: item.height,
          transform: buildElementTransform(activeTransform),
          transformOrigin: '0 0',
          willChange: 'transform',
          cursor: isDraggable ? 'default' : 'pointer',
          touchAction: 'none',
          zIndex: item.zIndex,
          bgcolor: 'transparent',
          borderRadius: isImageFallback ? '4px' : 0,
          outline: isSelected ? buildCanvasSelectionOutlineStyles(true).outline : 'none',
          boxShadow: isSelected ? buildCanvasSelectionOutlineStyles(true).boxShadow : 'none',
          pointerEvents:
            allowPointerPassthrough || enableContentPointerPassthrough ? 'none' : 'auto'
        }}
      >
        {previewContent}
        {enableContentPointerPassthrough && isDraggable && (
          <>
            {contentDragSurfaceStyle && (
              <Box
                data-canvas-rect-drag-surface="body"
                onPointerDown={handleNodePointerDown}
                sx={{
                  position: 'absolute',
                  left: contentDragSurfaceStyle.left,
                  right: contentDragSurfaceStyle.right,
                  top: contentDragSurfaceStyle.top,
                  bottom: contentDragSurfaceStyle.bottom,
                  pointerEvents: 'auto',
                  cursor: 'move',
                  zIndex: 0
                }}
              />
            )}
            {contentDragEdgeSet.has('top') && (
              <Box
                data-canvas-rect-drag-edge="top"
                onPointerDown={handleNodePointerDown}
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: '100%',
                  height: dragEdgeThickness,
                  pointerEvents: 'auto',
                  cursor: 'move',
                  zIndex: 1
                }}
              />
            )}
            {contentDragEdgeSet.has('right') && (
              <Box
                data-canvas-rect-drag-edge="right"
                onPointerDown={handleNodePointerDown}
                sx={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  width: dragEdgeThickness,
                  height: '100%',
                  pointerEvents: 'auto',
                  cursor: 'move',
                  zIndex: 1
                }}
              />
            )}
            {contentDragEdgeSet.has('bottom') && (
              <Box
                data-canvas-rect-drag-edge="bottom"
                onPointerDown={handleNodePointerDown}
                sx={{
                  position: 'absolute',
                  left: 0,
                  bottom: 0,
                  width: '100%',
                  height: dragEdgeThickness,
                  pointerEvents: 'auto',
                  cursor: 'move',
                  zIndex: 1
                }}
              />
            )}
            {contentDragEdgeSet.has('left') && (
              <Box
                data-canvas-rect-drag-edge="left"
                onPointerDown={handleNodePointerDown}
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: dragEdgeThickness,
                  height: '100%',
                  pointerEvents: 'auto',
                  cursor: 'move',
                  zIndex: 1
                }}
              />
            )}
          </>
        )}
        {showTransformer && (
          <>
            {HANDLE_POSITIONS.map(({ handle, left, top, cursor }) => (
              <Box
                key={handle}
                data-canvas-rect-handle={handle}
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
                  pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
                  cursor
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
                    borderRadius: isCornerHandle(handle)
                      ? '2px'
                      : handle === 'top-center' ||
                          handle === 'middle-left' ||
                          handle === 'middle-right' ||
                          handle === 'bottom-center'
                        ? '999px'
                        : '2px',
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
                    data-canvas-rect-rotate-hotspot={handle}
                    data-canvas-rect-rotate-hotspot-part={part}
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
                      pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
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

function areRectInteractionOverlayPropsEqual(
  previousProps: Readonly<ProjectCanvasRectItemInteractionOverlayProps>,
  nextProps: Readonly<ProjectCanvasRectItemInteractionOverlayProps>
) {
  const requiresViewportSync = previousProps.isSelected || nextProps.isSelected
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
    previousProps.isDraggable === nextProps.isDraggable &&
    previousProps.showTransformer === nextProps.showTransformer &&
    previousProps.previewContent === nextProps.previewContent &&
    previousProps.allowPointerPassthrough === nextProps.allowPointerPassthrough &&
    previousProps.contentPointerPassthrough === nextProps.contentPointerPassthrough &&
    previousProps.contentDragEdges?.join(',') === nextProps.contentDragEdges?.join(',') &&
    JSON.stringify(previousProps.contentDragSurfaceInset ?? null) ===
      JSON.stringify(nextProps.contentDragSurfaceInset ?? null) &&
    previousProps.lockCornerAspectRatio === nextProps.lockCornerAspectRatio &&
    previousProps.visualVariant === nextProps.visualVariant &&
    stageTransformEqual &&
    previousProps.stagePosRef === nextProps.stagePosRef &&
    previousProps.stageScaleRef === nextProps.stageScaleRef &&
    previousProps.minWidth === nextProps.minWidth &&
    previousProps.minHeight === nextProps.minHeight &&
    previousProps.overlayRole === nextProps.overlayRole &&
    previousProps.floatingToolbarSelector === nextProps.floatingToolbarSelector &&
    previousProps.onPreviewChange === nextProps.onPreviewChange &&
    previousProps.onDragStart === nextProps.onDragStart &&
    previousProps.onSelect === nextProps.onSelect &&
    previousProps.onDragEnd === nextProps.onDragEnd &&
    previousProps.onTransformEnd === nextProps.onTransformEnd &&
    previousProps.onDoubleClick === nextProps.onDoubleClick &&
    previousProps.onContextMenu === nextProps.onContextMenu &&
    previousProps.onHoverChange === nextProps.onHoverChange
  )
}

export default React.memo(
  ProjectCanvasRectItemInteractionOverlay,
  areRectInteractionOverlayPropsEqual
)
