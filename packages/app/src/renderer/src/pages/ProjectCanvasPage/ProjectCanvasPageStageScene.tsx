/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import {
  STAGE_VIEWPORT_LAYER_BASE_STYLE,
  useStageViewportTransformDriver
} from './useStageViewportTransformDriver'
import { Box } from '@mui/material'
import MaxSizeLayout from '../../components/MaxSizeLayout'
import CanvasItemPlaceholder from './components/CanvasItemPlaceholder'
import CanvasImageDomPreview from './components/CanvasImageDomPreview'
import { CanvasTextOverlayContent, CanvasTextOverlayFrame } from './components/CanvasTextOverlay'
import ProjectCanvasImageCropOverlay from './components/ProjectCanvasImageCropOverlay'
import ProjectCanvasImageInteractionOverlay from './components/ProjectCanvasImageInteractionOverlay'
import ProjectCanvasMultiSelectionTransformOverlay from './components/ProjectCanvasMultiSelectionTransformOverlay'
import ProjectCanvasRectItemInteractionOverlay, {
  type ProjectCanvasRectItemInteractionHandle,
  type ProjectCanvasRectItemTransform
} from './components/ProjectCanvasRectItemInteractionOverlay'
import { cancelCanvasSync, scheduleCanvasSync } from './components/canvasSync'
import {
  dispatchCanvasLiveVisualBoundsChange,
  useLiveSelectionOverlayGroups
} from './canvasLiveOverlayBounds'
import { CANVAS_NEW_RESULT_HINT_EVENT, type CanvasNewResultHintDetail } from './canvasNewResultHint'
import { measureCanvasAnnotationTextHeight, measureCanvasTextBoxHeight } from './canvasTextLayout'
import {
  ProjectCanvasPageSceneGrid,
  ProjectCanvasPageSceneOverlay
} from './ProjectCanvasPageSceneDecorations'
import ProjectCanvasWebGLImageLayer, {
  PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT,
  PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE,
  PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
  type ProjectCanvasWebGLImageLayerHandle,
  type ProjectCanvasWebGLImageLayerMetrics
} from './components/ProjectCanvasWebGLImageLayer'
import {
  buildProjectCanvasRenderableItems,
  resolveProjectCanvasImageInteractionMode,
  resolveProjectCanvasRenderBoundary,
  summarizeProjectCanvasImageFallbacks,
  summarizeProjectCanvasRuntimeSurfaces,
  type ProjectCanvasImagePreview
} from './projectCanvasRenderBoundary'
import { getCanvasItemBounds, isFillableAnnotationShape } from './projectCanvasPageShared'
import { getCanvasThumbnailRuntimeMetrics } from './canvasThumbnailWorkerClient'
import {
  areProjectCanvasSetsEqual,
  areProjectCanvasWebGLRuntimeMetricsEqual,
  buildProjectCanvasMetricsSnapshot,
  createProjectCanvasWebGLPendingRuntimeState,
  queueProjectCanvasWebGLPendingRuntimeIds,
  queueProjectCanvasWebGLPendingRuntimeMetrics,
  takeProjectCanvasWebGLPendingRuntimeState
} from './projectCanvasWebGLRuntimeState'
import { resolveCanvasImageLodDecision } from './canvasImageLodPolicy'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import type { AttachedCaptionAnnotation } from './canvasAttachedCaptionUtils'

const CANVAS_TEXT_TRANSFORM_MIN_WIDTH = 60
const CANVAS_TEXT_TRANSFORM_MIN_HEIGHT = 30
const CANVAS_TEXT_TRANSFORM_MIN_FONT_SIZE = 8
const CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE = 20
const CANVAS_ANNOTATION_TEXT_TRANSFORM_MIN_FONT_SIZE = 8
const PROJECT_CANVAS_DENSE_WEBGL_IMAGE_PROXY_LIMIT = 256
const PROJECT_CANVAS_SELECTION_RECT_ACTIVE_THRESHOLD_PX = 3
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_MIN_SOURCE_RATIO = 1.25
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_VIEWPORT_PIXEL_BUDGET_MULTIPLIER = 8
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_MIN_VISIBLE_SCREEN_AREA = 160 * 160
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_SOURCE_PIXEL_BUDGET = 96 * 1024 * 1024
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_DENSE_VIEW_MAX_SCALE = 1
const PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_DENSE_VIEW_CANDIDATE_LIMIT = 16
const PROJECT_CANVAS_NEW_RESULT_HINT_DURATION_MS = 8000
const PROJECT_CANVAS_NEW_RESULT_HINT_OUTLINE_SCREEN_PX = 4

function getProjectCanvasDomImageDeviceScale() {
  return Math.min(4, Math.max(1, window.devicePixelRatio || 1))
}

type CanvasPlanePoint = {
  x: number
  y: number
}

type CanvasBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type CanvasPlaceholderItem = CanvasImageItem | CanvasModel3DItem | CanvasVideoItem
const VIDEO_CONTROL_STRIP_HEIGHT_RATIO = 0.22
const VIDEO_CONTROL_STRIP_MIN_HEIGHT = 28
const VIDEO_CONTROL_STRIP_MAX_HEIGHT = 56

type CanvasRectInteractionOverlayItem = {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
}

type CanvasAnnotationInteractionOverlayItem = CanvasRectInteractionOverlayItem
type CanvasPlaceholderInteractionOverlayItem = CanvasRectInteractionOverlayItem

const STAGE_MARQUEE_FALLBACK_BLOCKING_SELECTORS = [
  '[data-canvas-item-id][data-canvas-overlay]',
  '[data-project-canvas-crop-overlay="dom"]',
  '[data-canvas-crop-box]',
  '[data-canvas-crop-handle]',
  '[data-project-canvas-multi-selection-transform-overlay="true"]',
  '[data-canvas-multi-select-drag-surface="true"]',
  '[data-canvas-multi-select-handle]',
  '.image-action-toolbar',
  '.blob-item-action-toolbar',
  '.file-action-toolbar',
  '.file-item-action-toolbar',
  '.group-action-toolbar',
  '.text-item-action-toolbar',
  '.textlike-action-toolbar',
  '.selection-action-stack'
] as const

function resolveCanvasAnnotationShape(item: CanvasAnnotationItem) {
  return item.shape || 'rect'
}

function rotateCanvasPoint(point: CanvasPlanePoint, rotation: number): CanvasPlanePoint {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

function addCanvasPoints(left: CanvasPlanePoint, right: CanvasPlanePoint): CanvasPlanePoint {
  return {
    x: left.x + right.x,
    y: left.y + right.y
  }
}

function getCanvasPointBounds(
  points: CanvasPlanePoint[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) {
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

function getCanvasPlaceholderLocalMinCorner(
  item: Pick<CanvasPlaceholderItem, 'width' | 'height' | 'scaleX' | 'scaleY'>
): CanvasPlanePoint {
  return {
    x: Math.min(0, item.width * item.scaleX),
    y: Math.min(0, item.height * item.scaleY)
  }
}

function isCanvasPlaceholderDomRectInteractionEligible(item: CanvasPlaceholderItem) {
  return Math.abs(item.scaleX) > 0.0001 && Math.abs(item.scaleY) > 0.0001
}

function getCanvasPlaceholderInteractionOverlayItem(
  item: CanvasPlaceholderItem
): CanvasPlaceholderInteractionOverlayItem {
  const localMinCorner = getCanvasPlaceholderLocalMinCorner(item)
  const offset = rotateCanvasPoint(localMinCorner, item.rotation)

  return {
    id: item.id,
    x: item.x + offset.x,
    y: item.y + offset.y,
    width: Math.max(1, Math.abs(item.width * item.scaleX)),
    height: Math.max(1, Math.abs(item.height * item.scaleY)),
    rotation: item.rotation,
    scaleX: 1,
    scaleY: 1,
    zIndex: item.zIndex
  }
}

function buildCanvasImageDomTransform(
  item: Pick<CanvasImageItem, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>
) {
  return `translate3d(${item.x}px, ${item.y}px, 0) rotate(${item.rotation}deg) scale(${item.scaleX}, ${item.scaleY})`
}

function resolveNewResultHintOutlineWidth(stageScale: number) {
  const safeScale = Math.max(0.001, Math.abs(stageScale))
  return PROJECT_CANVAS_NEW_RESULT_HINT_OUTLINE_SCREEN_PX / safeScale
}

function CanvasNewResultHintOverlay({
  item,
  stageScale
}: {
  item: CanvasImageItem
  stageScale: number
}) {
  const overlayItem = React.useMemo(() => getCanvasPlaceholderInteractionOverlayItem(item), [item])
  const outlineWidth = resolveNewResultHintOutlineWidth(stageScale)

  return (
    <Box
      data-canvas-overlay="new-result-hint"
      data-canvas-item-id={item.id}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: overlayItem.width,
        height: overlayItem.height,
        transform: buildCanvasImageDomTransform(overlayItem),
        transformOrigin: '0 0',
        pointerEvents: 'none',
        zIndex: overlayItem.zIndex + 2,
        borderRadius: `${Math.max(2, 4 / Math.max(0.001, Math.abs(stageScale)))}px`,
        outline: `${outlineWidth}px solid rgba(245, 158, 11, 0.98)`,
        boxShadow: [
          `0 0 0 ${outlineWidth * 0.55}px rgba(255, 255, 255, 0.92)`,
          `0 0 ${outlineWidth * 5}px ${outlineWidth}px rgba(245, 158, 11, 0.44)`
        ].join(', '),
        boxSizing: 'border-box'
      }}
    />
  )
}

function shouldUseHighResolutionDomSourcePreview(item: CanvasImageItem, stageScale: number) {
  const sourceWidth = item.sourceWidth ?? item.width
  const sourceHeight = item.sourceHeight ?? item.height
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return false
  }

  const sourceMaxSide = Math.max(sourceWidth, sourceHeight)
  if (
    sourceMaxSide <=
    PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE *
      PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_MIN_SOURCE_RATIO
  ) {
    return false
  }

  return resolveCanvasImageLodDecision({
    item,
    image: item.image,
    stageScale,
    isVisible: true,
    deviceScale: getProjectCanvasDomImageDeviceScale()
  }).shouldUseSourceTexture
}

function getCanvasViewportBounds({
  stagePos,
  stageScale,
  stageSize
}: {
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number } | null
}): CanvasBounds | null {
  const scale = Math.max(Math.abs(stageScale), 0.0001)
  const width = stageSize?.width ?? 0
  const height = stageSize?.height ?? 0

  if (width <= 0 || height <= 0) {
    return null
  }

  return {
    minX: -stagePos.x / scale,
    minY: -stagePos.y / scale,
    maxX: (-stagePos.x + width) / scale,
    maxY: (-stagePos.y + height) / scale
  }
}

function getCanvasBoundsIntersectionArea(left: CanvasBounds, right: CanvasBounds) {
  const width = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX))
  const height = Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY))
  return width * height
}

function getCanvasItemVisibleScreenArea(
  item: CanvasImageItem,
  viewportBounds: CanvasBounds,
  stageScale: number
) {
  const itemBounds = getCanvasItemBounds(item)
  const canvasArea = getCanvasBoundsIntersectionArea(itemBounds, viewportBounds)
  return canvasArea * Math.max(Math.abs(stageScale), 0.0001) ** 2
}

function getCanvasImageSourcePixelArea(item: CanvasImageItem) {
  const sourceWidth = item.sourceWidth ?? item.width
  const sourceHeight = item.sourceHeight ?? item.height
  const sourcePixelArea = sourceWidth * sourceHeight

  return Number.isFinite(sourcePixelArea) && sourcePixelArea > 0 ? sourcePixelArea : 0
}

function getCanvasPlaceholderInteractionTransformCommit(
  item: CanvasPlaceholderItem,
  transform: ProjectCanvasRectItemTransform
): Pick<CanvasPlaceholderItem, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'> {
  const signX = item.scaleX < 0 ? -1 : 1
  const signY = item.scaleY < 0 ? -1 : 1
  const nextScaleX = Math.max(0.0001, Math.abs(item.scaleX || 1) * Math.abs(transform.scaleX || 1))
  const nextScaleY = Math.max(0.0001, Math.abs(item.scaleY || 1) * Math.abs(transform.scaleY || 1))
  const nextSignedScaleX = nextScaleX * signX
  const nextSignedScaleY = nextScaleY * signY
  const localMinCorner = getCanvasPlaceholderLocalMinCorner({
    width: item.width,
    height: item.height,
    scaleX: nextSignedScaleX,
    scaleY: nextSignedScaleY
  })
  const offset = rotateCanvasPoint(localMinCorner, transform.rotation)

  return {
    x: transform.x - offset.x,
    y: transform.y - offset.y,
    rotation: transform.rotation,
    scaleX: nextSignedScaleX,
    scaleY: nextSignedScaleY
  }
}

function getCanvasAnnotationLocalPoints(item: CanvasAnnotationItem): CanvasPlanePoint[] | null {
  const shape = resolveCanvasAnnotationShape(item)

  if ((shape === 'arrow' || shape === 'line') && item.endX != null && item.endY != null) {
    return [
      { x: 0, y: 0 },
      { x: item.endX - item.x, y: item.endY - item.y }
    ]
  }

  if (shape === 'freedraw' && item.points && item.points.length >= 2) {
    const points: CanvasPlanePoint[] = []
    for (let index = 0; index < item.points.length; index += 2) {
      points.push({
        x: item.points[index] - item.x,
        y: item.points[index + 1] - item.y
      })
    }
    return points
  }

  return null
}

function getCanvasAnnotationLocalBounds(
  item: CanvasAnnotationItem
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points = getCanvasAnnotationLocalPoints(item)
  return points ? getCanvasPointBounds(points) : null
}

function getCanvasAnnotationRectLocalMinCorner(
  item: Pick<CanvasAnnotationItem, 'width' | 'height' | 'scaleX' | 'scaleY'>
): CanvasPlanePoint {
  return {
    x: Math.min(0, item.width * item.scaleX),
    y: Math.min(0, item.height * item.scaleY)
  }
}

function getCanvasAnnotationVisualLocalPoints(
  item: CanvasAnnotationItem
): CanvasPlanePoint[] | null {
  const points = getCanvasAnnotationLocalPoints(item)
  if (!points) {
    return null
  }

  return points.map((point) => ({
    x: point.x * item.scaleX,
    y: point.y * item.scaleY
  }))
}

function getCanvasAnnotationVisualLocalBounds(
  item: CanvasAnnotationItem
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points = getCanvasAnnotationVisualLocalPoints(item)
  return points ? getCanvasPointBounds(points) : null
}

function getCanvasAnnotationInteractionOverlayItem(
  item: CanvasAnnotationItem
): CanvasAnnotationInteractionOverlayItem {
  const shape = resolveCanvasAnnotationShape(item)

  if (shape === 'arrow' || shape === 'line' || shape === 'freedraw') {
    const localBounds = getCanvasAnnotationVisualLocalBounds(item)
    if (localBounds) {
      const offset = rotateCanvasPoint(
        {
          x: localBounds.minX,
          y: localBounds.minY
        },
        item.rotation
      )

      return {
        id: item.id,
        x: item.x + offset.x,
        y: item.y + offset.y,
        width: Math.max(1, localBounds.maxX - localBounds.minX),
        height: Math.max(1, localBounds.maxY - localBounds.minY),
        rotation: item.rotation,
        scaleX: 1,
        scaleY: 1,
        zIndex: item.zIndex
      }
    }
  }

  const localMinCorner = getCanvasAnnotationRectLocalMinCorner(item)
  const offset = rotateCanvasPoint(localMinCorner, item.rotation)

  return {
    id: item.id,
    x: item.x + offset.x,
    y: item.y + offset.y,
    width: Math.max(1, Math.abs(item.width * item.scaleX)),
    height: Math.max(1, Math.abs(item.height * item.scaleY)),
    rotation: item.rotation,
    scaleX: 1,
    scaleY: 1,
    zIndex: item.zIndex
  }
}

function isCanvasAnnotationDomRectInteractionEligible(
  item: CanvasAnnotationItem,
  itemIdSet: Set<string>
) {
  if (item.attachedToId && itemIdSet.has(item.attachedToId)) {
    return false
  }

  if (Math.abs(item.scaleX) <= 0.0001 || Math.abs(item.scaleY) <= 0.0001) {
    return false
  }

  return true
}

function getCanvasTextTransformMetrics(
  item: CanvasTextItem,
  transform: ProjectCanvasRectItemTransform,
  handle: ProjectCanvasRectItemInteractionHandle | null
): {
  width: number
  height: number
  fontSize: number
} {
  const scaleX = Math.abs(transform.scaleX || 1)
  const scaleY = Math.abs(transform.scaleY || 1)
  const isHorizontalEdge = handle === 'middle-left' || handle === 'middle-right'
  const isVerticalEdge = handle === 'top-center' || handle === 'bottom-center'

  let width = item.width
  let height = item.height
  let fontSize = item.fontSize

  if (isHorizontalEdge) {
    width = Math.max(CANVAS_TEXT_TRANSFORM_MIN_WIDTH, item.width * scaleX)
  } else if (isVerticalEdge) {
    height = Math.max(CANVAS_TEXT_TRANSFORM_MIN_HEIGHT, item.height * scaleY)
    fontSize = Math.max(CANVAS_TEXT_TRANSFORM_MIN_FONT_SIZE, item.fontSize * scaleY)
  } else if (handle && handle !== 'drag' && handle !== 'rotate') {
    const scale = Math.max(scaleX, scaleY)
    width = Math.max(CANVAS_TEXT_TRANSFORM_MIN_WIDTH, item.width * scale)
    height = Math.max(CANVAS_TEXT_TRANSFORM_MIN_HEIGHT, item.height * scale)
    fontSize = Math.max(CANVAS_TEXT_TRANSFORM_MIN_FONT_SIZE, item.fontSize * scale)
  }

  return {
    width,
    height,
    fontSize
  }
}

function getCanvasTextTransformCommit(
  item: CanvasTextItem,
  transform: ProjectCanvasRectItemTransform,
  handle: ProjectCanvasRectItemInteractionHandle | null
): Partial<CanvasTextItem> {
  const metrics = getCanvasTextTransformMetrics(item, transform, handle)

  return {
    x: transform.x,
    y: transform.y,
    width: metrics.width,
    height: measureCanvasTextBoxHeight({
      text: item.text,
      fontSize: metrics.fontSize,
      fontFamily: item.fontFamily,
      width: metrics.width
    }),
    fontSize: metrics.fontSize,
    rotation: transform.rotation
  }
}

function updateCanvasTextLiveBoundsDisplay(
  item: CanvasTextItem,
  transform: ProjectCanvasRectItemTransform | null,
  handle: ProjectCanvasRectItemInteractionHandle | null
) {
  const display = document.getElementById('live-bounds-display')
  if (!display) {
    return
  }

  if (!transform || !handle || handle === 'drag') {
    display.textContent = ''
    return
  }

  const metrics = getCanvasTextTransformMetrics(item, transform, handle)
  display.textContent = `Width: ${Math.round(metrics.width)}px | Height: ${Math.round(metrics.height)}px | Font: ${Math.round(metrics.fontSize)}px`
}

function getCanvasAnnotationTextTransformMetrics(
  item: CanvasAnnotationItem,
  transform: ProjectCanvasRectItemTransform,
  handle: ProjectCanvasRectItemInteractionHandle | null
): {
  width: number
  height: number
  fontSize: number
} {
  const scaleX = Math.abs(item.scaleX || 1) * Math.abs(transform.scaleX || 1)
  const scaleY = Math.abs(item.scaleY || 1) * Math.abs(transform.scaleY || 1)
  const fontSize = item.fontSize || 36
  const isHorizontalEdge = handle === 'middle-left' || handle === 'middle-right'
  const isVerticalEdge = handle === 'top-center' || handle === 'bottom-center'

  let width = item.width
  let height = item.height
  let nextFontSize = fontSize

  if (isHorizontalEdge) {
    width = Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, item.width * scaleX)
  } else if (isVerticalEdge) {
    height = Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, item.height * scaleY)
    nextFontSize = Math.max(CANVAS_ANNOTATION_TEXT_TRANSFORM_MIN_FONT_SIZE, fontSize * scaleY)
  } else if (handle && handle !== 'drag') {
    const scale = Math.max(scaleX, scaleY)
    width = Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, item.width * scale)
    height = Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, item.height * scale)
    nextFontSize = Math.max(CANVAS_ANNOTATION_TEXT_TRANSFORM_MIN_FONT_SIZE, fontSize * scale)
  }

  return {
    width,
    height,
    fontSize: nextFontSize
  }
}

function getCanvasAnnotationLineLikeTransformCommit(
  item: CanvasAnnotationItem,
  transform: ProjectCanvasRectItemTransform
): Partial<CanvasAnnotationItem> {
  const localPoints = getCanvasAnnotationVisualLocalPoints(item)
  const localBounds = getCanvasAnnotationVisualLocalBounds(item)

  if (!localPoints || !localBounds) {
    const bounds = getCanvasItemBounds(item)
    return {
      x: transform.x,
      y: transform.y,
      width: Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, bounds.maxX - bounds.minX),
      height: Math.max(CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE, bounds.maxY - bounds.minY),
      rotation: transform.rotation,
      scaleX: 1,
      scaleY: 1
    }
  }

  const origin = addCanvasPoints(
    { x: transform.x, y: transform.y },
    rotateCanvasPoint(
      {
        x: -localBounds.minX * Math.abs(transform.scaleX || 1),
        y: -localBounds.minY * Math.abs(transform.scaleY || 1)
      },
      transform.rotation
    )
  )

  if (
    resolveCanvasAnnotationShape(item) === 'arrow' ||
    resolveCanvasAnnotationShape(item) === 'line'
  ) {
    const endPoint = localPoints[1] ?? { x: 0, y: 0 }
    return {
      x: origin.x,
      y: origin.y,
      width: Math.max(1, (localBounds.maxX - localBounds.minX) * Math.abs(transform.scaleX)),
      height: Math.max(1, (localBounds.maxY - localBounds.minY) * Math.abs(transform.scaleY)),
      endX: origin.x + endPoint.x * Math.abs(transform.scaleX || 1),
      endY: origin.y + endPoint.y * Math.abs(transform.scaleY || 1),
      rotation: transform.rotation,
      scaleX: 1,
      scaleY: 1
    }
  }

  const nextPoints = localPoints.flatMap((point) => [
    origin.x + point.x * Math.abs(transform.scaleX || 1),
    origin.y + point.y * Math.abs(transform.scaleY || 1)
  ])

  return {
    x: origin.x,
    y: origin.y,
    width: Math.max(1, (localBounds.maxX - localBounds.minX) * Math.abs(transform.scaleX)),
    height: Math.max(1, (localBounds.maxY - localBounds.minY) * Math.abs(transform.scaleY)),
    points: nextPoints,
    rotation: transform.rotation,
    scaleX: 1,
    scaleY: 1
  }
}

function getCanvasAnnotationTransformCommit(
  item: CanvasAnnotationItem,
  transform: ProjectCanvasRectItemTransform,
  handle: ProjectCanvasRectItemInteractionHandle | null
): Partial<CanvasAnnotationItem> {
  const shape = resolveCanvasAnnotationShape(item)
  const overlayItem = getCanvasAnnotationInteractionOverlayItem(item)

  if (shape === 'arrow' || shape === 'line' || shape === 'freedraw') {
    return getCanvasAnnotationLineLikeTransformCommit(item, transform)
  }

  if (resolveCanvasAnnotationShape(item) === 'text-anno') {
    const metrics = getCanvasAnnotationTextTransformMetrics(item, transform, handle)

    return {
      x: transform.x,
      y: transform.y,
      width: metrics.width,
      height: measureCanvasAnnotationTextHeight({
        text: item.text || '',
        width: metrics.width,
        fontSize: metrics.fontSize,
        fontWeight: item.fontWeight
      }),
      fontSize: metrics.fontSize,
      rotation: transform.rotation,
      scaleX: 1,
      scaleY: 1
    }
  }

  return {
    x: transform.x,
    y: transform.y,
    width: Math.max(
      CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE,
      overlayItem.width * Math.abs(transform.scaleX || 1)
    ),
    height: Math.max(
      CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE,
      overlayItem.height * Math.abs(transform.scaleY || 1)
    ),
    rotation: transform.rotation,
    scaleX: 1,
    scaleY: 1
  }
}

function getCanvasAnnotationDragCommit(
  item: CanvasAnnotationItem,
  overlayItem: CanvasAnnotationInteractionOverlayItem,
  nextX: number,
  nextY: number
): Partial<CanvasAnnotationItem> {
  const dx = nextX - overlayItem.x
  const dy = nextY - overlayItem.y
  const shape = resolveCanvasAnnotationShape(item)

  if ((shape === 'arrow' || shape === 'line') && item.endX != null && item.endY != null) {
    return {
      x: item.x + dx,
      y: item.y + dy,
      endX: item.endX + dx,
      endY: item.endY + dy
    }
  }

  if (shape === 'freedraw' && item.points) {
    return {
      x: item.x + dx,
      y: item.y + dy,
      points: item.points.map((value, index) => (index % 2 === 0 ? value + dx : value + dy))
    }
  }

  return {
    x: item.x + dx,
    y: item.y + dy
  }
}

function updateCanvasAnnotationLiveBoundsDisplay(
  item: CanvasAnnotationItem,
  transform: ProjectCanvasRectItemTransform | null,
  handle: ProjectCanvasRectItemInteractionHandle | null
) {
  const display = document.getElementById('live-bounds-display')
  if (!display) {
    return
  }

  if (!transform || !handle || handle === 'drag') {
    display.textContent = ''
    return
  }

  if (resolveCanvasAnnotationShape(item) !== 'text-anno') {
    const overlayItem = getCanvasAnnotationInteractionOverlayItem(item)
    display.textContent = `${Math.round(Math.abs(overlayItem.width * transform.scaleX))} x ${Math.round(Math.abs(overlayItem.height * transform.scaleY))}`
    return
  }

  const metrics = getCanvasAnnotationTextTransformMetrics(item, transform, handle)
  display.textContent = `Width: ${Math.round(metrics.width)}px | Font: ${Math.round(metrics.fontSize)}px`
}

export default function ProjectCanvasPageStageScene(props: any) {
  const {
    activeOcrHover,
    annotationColor,
    annotationFillOpacity,
    bgColor,
    canvasContainerRef,
    canvasActiveRef,
    croppingImageId,
    extractingImageId,
    cropOverlayRef,
    cursorStyle,
    drawingState,
    exactSelectedGroup,
    gridColor,
    handleDragEnd,
    handleDragOver,
    handleDrop,
    handleImageContextMenu,
    handleExtractImageRegion,
    handleOpenFileDialog,
    handleOpenModel3DViewer,
    handleResize,
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageWheel,
    handleTransformEnd,
    itemIdSet,
    isFillableAnnotationShape: isFillableAnnotationShapeProp,
    isMiddleMouseRef,
    isViewportInteracting = false,
    lastClickedIdRef,
    dragContextRef,
    onLiveMultiSelectionBoundsChange,
    onSelectionRectElementsChange,
    selectedIds,
    selectionOverlayGroups,
    selectionRect,
    selectionRectRenderMode = 'react',
    setActiveOcrHover,
    setCanvasContainerElement,
    setCroppingImageId,
    setExtractingImageId,
    setInlineTextEdit,
    setItemsWithHistory,
    setLabelDialogItemId,
    setLabelDialogOpen,
    setLabelDialogText,
    setSelectedIds,
    setTool,
    showGrid,
    shouldForceShapeCreationCrosshair,
    stagePos,
    stagePosRef,
    stageRef,
    stageSize,
    stageScale,
    stageScaleRef,
    suppressSelectionChromeAfterMarquee = false,
    tool,
    transparentPattern,
    visibleItems,
    // Optional: page-level viewport driver (shared with interaction hook for zero-render pan/zoom).
    registerViewportLayer: registerViewportLayerProp
  } = props

  const renderCommitCountRef = React.useRef(0)
  renderCommitCountRef.current += 1

  const propItems = (props as { items?: unknown }).items
  const allCanvasItems = React.useMemo<CanvasItem[]>(() => {
    if (Array.isArray(propItems)) {
      return propItems as CanvasItem[]
    }
    return visibleItems
  }, [propItems, visibleItems])
  const totalCanvasItemCount =
    typeof itemIdSet?.size === 'number' ? itemIdSet.size : allCanvasItems.length
  const totalCanvasImageItemCount = React.useMemo(
    () => allCanvasItems.reduce((count, item) => count + (item.type === 'image' ? 1 : 0), 0),
    [allCanvasItems]
  )
  const [newResultHintIds, setNewResultHintIds] = React.useState<Set<string>>(new Set())
  const newResultHintTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  React.useEffect(() => {
    const hintTimers = newResultHintTimersRef.current

    const removeHint = (itemId: string) => {
      setNewResultHintIds((previousIds) => {
        if (!previousIds.has(itemId)) {
          return previousIds
        }
        const nextIds = new Set(previousIds)
        nextIds.delete(itemId)
        return nextIds
      })
    }

    const handleNewResultHint = (event: Event) => {
      const detail = (event as CustomEvent<CanvasNewResultHintDetail>).detail
      if (!detail?.itemId) {
        return
      }

      setNewResultHintIds((previousIds) => {
        const nextIds = new Set(previousIds)
        nextIds.add(detail.itemId)
        return nextIds
      })

      const previousTimer = hintTimers.get(detail.itemId)
      if (previousTimer != null) {
        clearTimeout(previousTimer)
      }
      const timer = setTimeout(() => {
        hintTimers.delete(detail.itemId)
        removeHint(detail.itemId)
      }, PROJECT_CANVAS_NEW_RESULT_HINT_DURATION_MS)
      hintTimers.set(detail.itemId, timer)
    }

    window.addEventListener(CANVAS_NEW_RESULT_HINT_EVENT, handleNewResultHint)

    return () => {
      window.removeEventListener(CANVAS_NEW_RESULT_HINT_EVENT, handleNewResultHint)
      hintTimers.forEach((timer) => clearTimeout(timer))
      hintTimers.clear()
    }
  }, [])

  const newResultHintItems = React.useMemo(
    () =>
      allCanvasItems
        .filter(
          (item): item is CanvasImageItem => item.type === 'image' && newResultHintIds.has(item.id)
        )
        .sort((left, right) => left.zIndex - right.zIndex),
    [allCanvasItems, newResultHintIds]
  )
  const domPreviewSyncParentIdSet = React.useMemo(() => {
    const parentIds = new Set<string>()
    for (const item of allCanvasItems) {
      if (item.type !== 'annotation') {
        continue
      }
      const attachedToId = (item as Partial<AttachedCaptionAnnotation>).attachedToId
      if (typeof attachedToId === 'string' && attachedToId.length > 0) {
        parentIds.add(attachedToId)
      }
    }
    return parentIds
  }, [allCanvasItems])

  const isFillableShape = isFillableAnnotationShapeProp || isFillableAnnotationShape
  // Use page-level driver if available (driven by interaction hook, zero React renders during pan/zoom).
  // Fall back to local driver for standalone use (tests, etc.).
  const localDriver = useStageViewportTransformDriver()
  const registerViewportLayer = registerViewportLayerProp ?? localDriver.registerViewportLayer
  // Extract registerViewportCallback from page-level driver if provided via props,
  // otherwise fall back to the local driver's callback registration.
  const registerViewportCallback =
    (props as any).registerViewportCallback ?? localDriver.registerViewportCallback
  const registerViewportInteractionCallback =
    (props as any).registerViewportInteractionCallback ??
    localDriver.registerViewportInteractionCallback
  React.useLayoutEffect(() => {
    if (!registerViewportLayerProp) {
      localDriver.applyViewportTransform(stagePos, stageScale)
    }
  }, [localDriver, registerViewportLayerProp, stagePos, stageScale])
  const stageSizeRef = React.useRef(stageSize)
  React.useLayoutEffect(() => {
    stageSizeRef.current = stageSize
  }, [stageSize])
  const [webglImageLayerReady, setWebglImageLayerReady] = React.useState(false)
  const [webglResidentImageIds, setWebglResidentImageIds] = React.useState<Set<string>>(new Set())
  const [webglResolvedImageIds, setWebglResolvedImageIds] = React.useState<Set<string>>(new Set())
  const [webglFailedImageIds, setWebglFailedImageIds] = React.useState<Set<string>>(new Set())
  const [webglMetrics, setWebglMetrics] =
    React.useState<ProjectCanvasWebGLImageLayerMetrics | null>(null)
  const webglImageLayerRef = React.useRef<ProjectCanvasWebGLImageLayerHandle | null>(null)
  const isViewportInteractionActiveRef = React.useRef(isViewportInteracting)
  const pendingWebglRuntimeStateRef = React.useRef(
    createProjectCanvasWebGLPendingRuntimeState<ProjectCanvasWebGLImageLayerMetrics>()
  )
  const commitWebglResidentIds = React.useCallback((residentIds: ReadonlySet<string>) => {
    setWebglResidentImageIds((previousResidentIds) =>
      areProjectCanvasSetsEqual(previousResidentIds, residentIds)
        ? previousResidentIds
        : new Set(residentIds)
    )
  }, [])
  const commitWebglResolvedIds = React.useCallback((resolvedIds: ReadonlySet<string>) => {
    setWebglResolvedImageIds((previousResolvedIds) =>
      areProjectCanvasSetsEqual(previousResolvedIds, resolvedIds)
        ? previousResolvedIds
        : new Set(resolvedIds)
    )
  }, [])
  const commitWebglFailedIds = React.useCallback((failedIds: ReadonlySet<string>) => {
    setWebglFailedImageIds((previousFailedIds) =>
      areProjectCanvasSetsEqual(previousFailedIds, failedIds)
        ? previousFailedIds
        : new Set(failedIds)
    )
  }, [])
  const commitWebglMetrics = React.useCallback((metrics: ProjectCanvasWebGLImageLayerMetrics) => {
    setWebglMetrics((previousMetrics) =>
      areProjectCanvasWebGLRuntimeMetricsEqual(previousMetrics, metrics)
        ? previousMetrics
        : { ...metrics }
    )
  }, [])
  const flushPendingWebglRuntimeState = React.useCallback(() => {
    const { pending, next } = takeProjectCanvasWebGLPendingRuntimeState(
      pendingWebglRuntimeStateRef.current
    )
    pendingWebglRuntimeStateRef.current = next

    if (pending.residentIds) {
      commitWebglResidentIds(pending.residentIds)
    }
    if (pending.resolvedIds) {
      commitWebglResolvedIds(pending.resolvedIds)
    }
    if (pending.failedIds) {
      commitWebglFailedIds(pending.failedIds)
    }
    if (pending.metrics) {
      commitWebglMetrics(pending.metrics)
    }
  }, [commitWebglFailedIds, commitWebglMetrics, commitWebglResidentIds, commitWebglResolvedIds])
  const handleWebglResidentIdsChange = React.useCallback(
    (residentIds: Set<string>) => {
      if (isViewportInteractionActiveRef.current) {
        pendingWebglRuntimeStateRef.current = queueProjectCanvasWebGLPendingRuntimeIds(
          pendingWebglRuntimeStateRef.current,
          'residentIds',
          residentIds
        )
        return
      }

      commitWebglResidentIds(residentIds)
    },
    [commitWebglResidentIds]
  )
  const handleWebglResolvedIdsChange = React.useCallback(
    (resolvedIds: Set<string>) => {
      if (isViewportInteractionActiveRef.current) {
        pendingWebglRuntimeStateRef.current = queueProjectCanvasWebGLPendingRuntimeIds(
          pendingWebglRuntimeStateRef.current,
          'resolvedIds',
          resolvedIds
        )
        return
      }

      commitWebglResolvedIds(resolvedIds)
    },
    [commitWebglResolvedIds]
  )
  const handleWebglFailedIdsChange = React.useCallback(
    (failedIds: Set<string>) => {
      if (isViewportInteractionActiveRef.current) {
        pendingWebglRuntimeStateRef.current = queueProjectCanvasWebGLPendingRuntimeIds(
          pendingWebglRuntimeStateRef.current,
          'failedIds',
          failedIds
        )
        return
      }

      commitWebglFailedIds(failedIds)
    },
    [commitWebglFailedIds]
  )
  const handleWebglMetricsChange = React.useCallback(
    (metrics: ProjectCanvasWebGLImageLayerMetrics) => {
      if (isViewportInteractionActiveRef.current) {
        pendingWebglRuntimeStateRef.current = queueProjectCanvasWebGLPendingRuntimeMetrics(
          pendingWebglRuntimeStateRef.current,
          metrics
        )
        return
      }

      commitWebglMetrics(metrics)
    },
    [commitWebglMetrics]
  )
  React.useEffect(() => {
    isViewportInteractionActiveRef.current = isViewportInteracting
    if (!isViewportInteracting) {
      flushPendingWebglRuntimeState()
    }
  }, [flushPendingWebglRuntimeState, isViewportInteracting])
  React.useEffect(() => {
    if (!registerViewportCallback) {
      return
    }

    return registerViewportCallback((pos, scale) => {
      const syncViewport = webglImageLayerRef.current?.syncViewport
      if (typeof syncViewport === 'function') {
        syncViewport(pos, scale)
      }
    })
  }, [registerViewportCallback])
  React.useEffect(() => {
    if (!registerViewportInteractionCallback) {
      return
    }

    return registerViewportInteractionCallback((active) => {
      isViewportInteractionActiveRef.current = active
      const webglImageLayer = webglImageLayerRef.current
      if (typeof webglImageLayer?.setViewportInteracting === 'function') {
        webglImageLayer.setViewportInteracting(active)
      }
      if (!active) {
        flushPendingWebglRuntimeState()
      }
    })
  }, [flushPendingWebglRuntimeState, registerViewportInteractionCallback])
  const regionSelectionTargetId =
    tool === 'crop-select' ? croppingImageId : tool === 'extract-select' ? extractingImageId : null
  const cropTargetId = regionSelectionTargetId
  const renderableMediaItems = React.useMemo(
    () => buildProjectCanvasRenderableItems(visibleItems),
    [visibleItems]
  )
  const resolvedRenderBoundaryItems = React.useMemo(
    () =>
      resolveProjectCanvasRenderBoundary({
        items: visibleItems,
        cropTargetId,
        webglReady: webglImageLayerReady,
        loadedImageIds: webglResolvedImageIds,
        residentImageIds: webglResidentImageIds,
        failedImageIds: webglFailedImageIds,
        selectedIds,
        stagePos: stagePosRef?.current ?? stagePos,
        stageScale: stageScaleRef?.current ?? stageScale,
        stageSize: stageSizeRef.current
      }),
    [
      cropTargetId,
      selectedIds,
      visibleItems,
      webglFailedImageIds,
      webglImageLayerReady,
      webglResolvedImageIds,
      webglResidentImageIds
    ]
  )
  const imageRuntimeRouteById = React.useMemo(() => {
    const routes = new Map<
      string,
      'webgl-primary' | 'budget-image-proxy' | 'fallback-image-proxy' | 'crop-excluded'
    >()

    for (const item of resolvedRenderBoundaryItems) {
      if (item.kind !== 'image' || !item.imageRuntimeRoute) {
        continue
      }

      routes.set(item.id, item.imageRuntimeRoute)
    }

    return routes
  }, [resolvedRenderBoundaryItems])
  const imageFallbackReasonById = React.useMemo(() => {
    const reasons = new Map<string, 'unloaded' | 'failed' | 'unsupported'>()

    for (const item of resolvedRenderBoundaryItems) {
      if (item.kind === 'image' && item.imageFallbackReason) {
        reasons.set(item.id, item.imageFallbackReason)
      }
    }

    return reasons
  }, [resolvedRenderBoundaryItems])
  const webglImageItems = React.useMemo(
    () =>
      allCanvasItems
        .filter(
          (item): item is CanvasImageItem =>
            item.type === 'image' &&
            item.id !== cropTargetId &&
            imageRuntimeRouteById.get(item.id) !== 'crop-excluded'
        )
        .sort((left, right) => left.zIndex - right.zIndex),
    [allCanvasItems, cropTargetId, imageRuntimeRouteById]
  )
  const webglPrimaryImageCount = React.useMemo(() => {
    let count = 0
    for (const runtimeRoute of imageRuntimeRouteById.values()) {
      if (runtimeRoute === 'webgl-primary') {
        count += 1
      }
    }
    return count
  }, [imageRuntimeRouteById])
  const highResolutionDomImagePreviewItems = React.useMemo(() => {
    if (isViewportInteracting) {
      return []
    }

    const currentStageScale = stageScaleRef?.current ?? stageScale
    const viewportBounds = getCanvasViewportBounds({
      stagePos: stagePosRef?.current ?? stagePos,
      stageScale: currentStageScale,
      stageSize
    })
    if (!viewportBounds) {
      return []
    }

    const viewportPixelBudget =
      (stageSize?.width ?? 0) *
      (stageSize?.height ?? 0) *
      PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_VIEWPORT_PIXEL_BUDGET_MULTIPLIER
    if (viewportPixelBudget <= 0) {
      return []
    }

    const visibleWebglImageCandidateCount = visibleItems.reduce((count, item) => {
      if (item.type !== 'image' || imageRuntimeRouteById.get(item.id) !== 'webgl-primary') {
        return count
      }

      return count + 1
    }, 0)
    if (
      currentStageScale < PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_DENSE_VIEW_MAX_SCALE &&
      visibleWebglImageCandidateCount > PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_DENSE_VIEW_CANDIDATE_LIMIT
    ) {
      return []
    }

    let usedPixelBudget = 0
    let usedSourcePixelBudget = 0
    const budgetedItems: CanvasImageItem[] = []
    const candidates = visibleItems
      .flatMap((item) => {
        if (
          item.type !== 'image' ||
          imageRuntimeRouteById.get(item.id) !== 'webgl-primary' ||
          !shouldUseHighResolutionDomSourcePreview(item, currentStageScale)
        ) {
          return []
        }

        const visibleScreenArea = getCanvasItemVisibleScreenArea(
          item,
          viewportBounds,
          currentStageScale
        )
        if (visibleScreenArea < PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_MIN_VISIBLE_SCREEN_AREA) {
          return []
        }

        const sourcePixelArea = getCanvasImageSourcePixelArea(item)
        if (sourcePixelArea <= 0) {
          return []
        }

        return [
          {
            item,
            visibleScreenArea,
            sourcePixelArea,
            selectedRank: selectedIds.has(item.id) ? 1 : 0
          }
        ]
      })
      .sort((left, right) => {
        if (left.selectedRank !== right.selectedRank) {
          return right.selectedRank - left.selectedRank
        }
        if (left.item.zIndex !== right.item.zIndex) {
          return right.item.zIndex - left.item.zIndex
        }
        return right.visibleScreenArea - left.visibleScreenArea
      })

    for (const candidate of candidates) {
      const nextBudget = usedPixelBudget + candidate.visibleScreenArea
      const nextSourcePixelBudget = usedSourcePixelBudget + candidate.sourcePixelArea
      if (
        budgetedItems.length > 0 &&
        (nextBudget > viewportPixelBudget ||
          nextSourcePixelBudget > PROJECT_CANVAS_HIGH_RES_DOM_IMAGE_SOURCE_PIXEL_BUDGET)
      ) {
        continue
      }

      usedPixelBudget = nextBudget
      usedSourcePixelBudget = nextSourcePixelBudget
      budgetedItems.push(candidate.item)
    }

    return budgetedItems
  }, [
    imageRuntimeRouteById,
    isViewportInteracting,
    selectedIds,
    stagePos,
    stagePosRef,
    stageScale,
    stageScaleRef,
    stageSize,
    visibleItems
  ])
  const shouldUseDenseWebglImageProxyBudget =
    webglImageItems.length > PROJECT_CANVAS_DENSE_WEBGL_IMAGE_PROXY_LIMIT ||
    webglPrimaryImageCount > PROJECT_CANVAS_DENSE_WEBGL_IMAGE_PROXY_LIMIT
  const getImageRuntimeRoute = React.useCallback(
    (item: CanvasImageItem) => imageRuntimeRouteById.get(item.id) ?? 'fallback-image-proxy',
    [imageRuntimeRouteById]
  )
  const activePlaceholderDragItemId = dragContextRef?.current?.draggingId ?? null
  const { interactiveImageOverlayItems, placeholderProxyImageItems, renderableMediaItemMap } =
    React.useMemo(() => {
      const nextRenderableMediaItemMap = new Map<string, (typeof renderableMediaItems)[number]>()
      const nextInteractiveImageOverlayItems: CanvasImageItem[] = []
      const nextPlaceholderProxyImageItems: CanvasImageItem[] = []

      for (const renderableItem of renderableMediaItems) {
        nextRenderableMediaItemMap.set(renderableItem.id, renderableItem)

        if (renderableItem.kind !== 'image') {
          continue
        }

        const runtimeRoute = imageRuntimeRouteById.get(renderableItem.id)
        if (runtimeRoute === 'crop-excluded') {
          continue
        }

        const isActivePlaceholderDrag = activePlaceholderDragItemId === renderableItem.id
        if (isViewportInteracting && runtimeRoute === 'webgl-primary' && !isActivePlaceholderDrag) {
          continue
        }
        const isSingleSelectedImage =
          tool === 'select' && selectedIds.size === 1 && selectedIds.has(renderableItem.id)
        const imageFallbackReason = imageFallbackReasonById.get(renderableItem.id)
        const shouldKeepFallbackProxy =
          runtimeRoute === 'fallback-image-proxy' &&
          (!webglImageLayerReady ||
            imageFallbackReason === 'failed' ||
            imageFallbackReason === 'unsupported')
        const activeRuntimeRoute = runtimeRoute ?? 'fallback-image-proxy'
        if (
          shouldUseDenseWebglImageProxyBudget &&
          !shouldKeepFallbackProxy &&
          !isSingleSelectedImage &&
          !isActivePlaceholderDrag &&
          tool !== 'select'
        ) {
          continue
        }

        const interactionMode = isActivePlaceholderDrag
          ? 'placeholder-hit-proxy'
          : resolveProjectCanvasImageInteractionMode({
              item: renderableItem.item,
              runtimeRoute: activeRuntimeRoute,
              tool,
              isSingleSelected: isSingleSelectedImage
            })

        if (interactionMode === 'dom-image-overlay') {
          nextInteractiveImageOverlayItems.push(renderableItem.item)
        } else if (interactionMode === 'placeholder-hit-proxy') {
          nextPlaceholderProxyImageItems.push(renderableItem.item)
        }
      }

      return {
        interactiveImageOverlayItems: nextInteractiveImageOverlayItems,
        placeholderProxyImageItems: nextPlaceholderProxyImageItems,
        renderableMediaItemMap: nextRenderableMediaItemMap
      }
    }, [
      activePlaceholderDragItemId,
      imageFallbackReasonById,
      imageRuntimeRouteById,
      isViewportInteracting,
      renderableMediaItems,
      selectedIds,
      shouldUseDenseWebglImageProxyBudget,
      tool,
      webglImageLayerReady
    ])
  const placeholderProxyImageIdSet = React.useMemo(
    () => new Set(placeholderProxyImageItems.map((item) => item.id)),
    [placeholderProxyImageItems]
  )
  const shouldSuppressSelectionChromeForSelectionRect =
    selectionRect != null &&
    (selectionRect.w > PROJECT_CANVAS_SELECTION_RECT_ACTIVE_THRESHOLD_PX ||
      selectionRect.h > PROJECT_CANVAS_SELECTION_RECT_ACTIVE_THRESHOLD_PX)
  const shouldSuppressSelectionChrome =
    shouldSuppressSelectionChromeForSelectionRect || suppressSelectionChromeAfterMarquee
  const shouldRenderImageInteractionLayer = interactiveImageOverlayItems.length > 0
  const { activeRegionSelectionImageItem, multiSelectionTransformItems, selectedSingleItem } =
    React.useMemo(() => {
      let nextActiveRegionSelectionImageItem: CanvasImageItem | null = null
      let nextSelectedSingleItem: CanvasItem | null = null
      const nextMultiSelectionTransformItems: CanvasItem[] = []
      const shouldResolveSingleSelection = tool === 'select' && selectedIds.size === 1
      const cropTargetItemId = cropTargetId

      for (const item of visibleItems) {
        if (
          cropTargetItemId &&
          nextActiveRegionSelectionImageItem == null &&
          item.type === 'image' &&
          item.id === cropTargetItemId
        ) {
          nextActiveRegionSelectionImageItem = item
        }

        if (!selectedIds.has(item.id)) {
          continue
        }

        if (shouldResolveSingleSelection && nextSelectedSingleItem == null) {
          nextSelectedSingleItem = item
        }

        if (
          suppressSelectionChromeAfterMarquee ||
          item.id === cropTargetItemId ||
          item.type === 'html'
        ) {
          continue
        }

        if (renderableMediaItemMap.get(item.id)?.interactionProxy === 'html-overlay') {
          continue
        }

        nextMultiSelectionTransformItems.push(item)
      }

      return {
        activeRegionSelectionImageItem: nextActiveRegionSelectionImageItem,
        multiSelectionTransformItems: nextMultiSelectionTransformItems,
        selectedSingleItem: nextSelectedSingleItem
      }
    }, [
      cropTargetId,
      renderableMediaItemMap,
      selectedIds,
      suppressSelectionChromeAfterMarquee,
      tool,
      visibleItems
    ])
  const selectedSingleFileItem = React.useMemo<CanvasFileItem | null>(
    () =>
      tool === 'select' &&
      selectedSingleItem?.type === 'file' &&
      activePlaceholderDragItemId !== selectedSingleItem.id
        ? (selectedSingleItem as CanvasFileItem)
        : null,
    [activePlaceholderDragItemId, selectedSingleItem, tool]
  )
  const selectedSingleTextItem = React.useMemo<CanvasTextItem | null>(
    () =>
      tool === 'select' &&
      selectedSingleItem?.type === 'text' &&
      activePlaceholderDragItemId !== selectedSingleItem.id
        ? (selectedSingleItem as CanvasTextItem)
        : null,
    [activePlaceholderDragItemId, selectedSingleItem, tool]
  )
  const selectedSingleAnnotationItem = React.useMemo<CanvasAnnotationItem | null>(() => {
    if (
      tool !== 'select' ||
      selectedSingleItem?.type !== 'annotation' ||
      activePlaceholderDragItemId === selectedSingleItem.id
    ) {
      return null
    }

    const annotationItem = selectedSingleItem as CanvasAnnotationItem

    if (!isCanvasAnnotationDomRectInteractionEligible(annotationItem, itemIdSet)) {
      return null
    }

    return annotationItem
  }, [activePlaceholderDragItemId, itemIdSet, selectedSingleItem, tool])
  const selectedSingleAnnotationOverlayItem =
    React.useMemo<CanvasAnnotationInteractionOverlayItem | null>(
      () =>
        selectedSingleAnnotationItem
          ? getCanvasAnnotationInteractionOverlayItem(selectedSingleAnnotationItem)
          : null,
      [selectedSingleAnnotationItem]
    )
  React.useEffect(() => {
    if (tool !== 'select' || multiSelectionTransformItems.length <= 1) {
      onLiveMultiSelectionBoundsChange?.(null)
    }
  }, [multiSelectionTransformItems.length, onLiveMultiSelectionBoundsChange, tool])
  const multiSelectionLivePreviewSyncItemIds = React.useMemo(() => {
    const itemIds = new Set<string>()

    for (const item of multiSelectionTransformItems) {
      if (item.type === 'image') {
        if (domPreviewSyncParentIdSet.has(item.id)) {
          itemIds.add(item.id)
        }
        continue
      }

      if (item.type !== 'file') {
        itemIds.add(item.id)
      }
    }

    return itemIds
  }, [domPreviewSyncParentIdSet, multiSelectionTransformItems])
  const selectedSinglePlaceholderItem = React.useMemo<CanvasPlaceholderItem | null>(() => {
    if (
      tool !== 'select' ||
      !selectedSingleItem ||
      activePlaceholderDragItemId === selectedSingleItem.id ||
      selectedSingleItem.type === 'file' ||
      selectedSingleItem.type === 'text' ||
      selectedSingleItem.type === 'annotation' ||
      selectedSingleItem.type === 'html'
    ) {
      return null
    }

    const renderableItem = renderableMediaItemMap.get(selectedSingleItem.id)
    if (
      !renderableItem ||
      (renderableItem.interactionProxy !== 'canvas-image-node' &&
        renderableItem.interactionProxy !== 'canvas-placeholder')
    ) {
      return null
    }

    if (selectedSingleItem.type === 'image') {
      return null
    }

    if (
      !isCanvasPlaceholderDomRectInteractionEligible(selectedSingleItem as CanvasPlaceholderItem)
    ) {
      return null
    }

    return selectedSingleItem as CanvasPlaceholderItem
  }, [activePlaceholderDragItemId, renderableMediaItemMap, selectedSingleItem, tool])
  const selectedSinglePlaceholderOverlayItem =
    React.useMemo<CanvasPlaceholderInteractionOverlayItem | null>(
      () =>
        selectedSinglePlaceholderItem
          ? getCanvasPlaceholderInteractionOverlayItem(selectedSinglePlaceholderItem)
          : null,
      [selectedSinglePlaceholderItem]
    )
  const renderSurfaceSummary = React.useMemo(
    () =>
      summarizeProjectCanvasRuntimeSurfaces({
        items: visibleItems,
        cropTargetId,
        webglReady: webglImageLayerReady,
        loadedImageIds: webglResolvedImageIds,
        residentImageIds: webglResidentImageIds,
        failedImageIds: webglFailedImageIds,
        selectedIds,
        stagePos: stagePosRef?.current ?? stagePos,
        stageScale: stageScaleRef?.current ?? stageScale,
        stageSize: stageSizeRef.current
      }),
    [
      cropTargetId,
      selectedIds,
      visibleItems,
      webglFailedImageIds,
      webglImageLayerReady,
      webglResolvedImageIds,
      webglResidentImageIds
    ]
  )
  const fallbackImageSummary = React.useMemo(
    () => summarizeProjectCanvasImageFallbacks(resolvedRenderBoundaryItems),
    [resolvedRenderBoundaryItems]
  )
  const thumbnailCacheMetrics = getCanvasThumbnailRuntimeMetrics()
  const webglResidentImageCount = webglMetrics?.residentImageCount ?? 0
  const webglResidentTextureBytes = webglMetrics?.residentTextureBytes ?? 0
  const webglResidentTextureBudgetBytes =
    webglMetrics?.residentTextureBudgetBytes ?? PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES
  const webglResidentCandidateTextureBytes = webglMetrics?.residentCandidateTextureBytes ?? 0
  const webglResidentRemainingCapacity = Math.max(
    0,
    PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT - webglResidentImageCount
  )
  const webglResidentTextureRemainingBytes = Math.max(
    0,
    webglResidentTextureBudgetBytes - webglResidentTextureBytes
  )
  const webglResidentCountBudgetFull =
    webglResidentImageCount >= PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT
  const webglResidentTextureBudgetFull =
    webglResidentTextureBytes >= webglResidentTextureBudgetBytes
  const webglResidentBudgetState = !webglMetrics?.isInitialized
    ? 'uninitialized'
    : webglResidentCountBudgetFull && webglResidentTextureBudgetFull
      ? 'count-and-texture-full'
      : webglResidentCountBudgetFull
        ? 'count-full'
        : webglResidentTextureBudgetFull
          ? 'texture-full'
          : webglResidentImageCount > 0
            ? 'available'
            : 'empty'
  const metricsSnapshot = React.useMemo(
    () =>
      buildProjectCanvasMetricsSnapshot({
        stageScale,
        stagePos,
        reactCommits: renderCommitCountRef.current,
        totalItemCount: totalCanvasItemCount,
        totalImageItemCount: totalCanvasImageItemCount,
        visibleItemCount: visibleItems.length,
        visibleImageItemCount: renderSurfaceSummary.imageItems,
        renderSurface: renderSurfaceSummary,
        fallbackImages: fallbackImageSummary,
        thumbnailCacheMetrics,
        webglMetrics,
        residentLimit: PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT,
        residentRemainingCapacity: webglResidentRemainingCapacity,
        residentTextureRemainingBytes: webglResidentTextureRemainingBytes,
        residentBudgetState: webglResidentBudgetState
      }),
    [
      fallbackImageSummary,
      renderSurfaceSummary,
      stagePos,
      stageScale,
      thumbnailCacheMetrics,
      totalCanvasImageItemCount,
      totalCanvasItemCount,
      visibleItems.length,
      webglMetrics,
      webglResidentBudgetState,
      webglResidentRemainingCapacity,
      webglResidentTextureRemainingBytes
    ]
  )
  const metricsSnapshotText = React.useMemo(
    () => JSON.stringify(metricsSnapshot),
    [metricsSnapshot]
  )
  const pendingCanvasFocusFrameRef = React.useRef<number | null>(null)
  const activateCanvas = React.useCallback(() => {
    if (canvasActiveRef) {
      canvasActiveRef.current = true
    }

    const container = canvasContainerRef.current
    if (!container) return
    if (container === document.activeElement || container.contains(document.activeElement)) return
    if (pendingCanvasFocusFrameRef.current != null) return

    pendingCanvasFocusFrameRef.current = window.requestAnimationFrame(() => {
      pendingCanvasFocusFrameRef.current = null
      if (
        container.isConnected &&
        container !== document.activeElement &&
        !container.contains(document.activeElement)
      ) {
        container.focus({ preventScroll: true })
      }
    })
  }, [canvasActiveRef, canvasContainerRef])
  React.useEffect(() => {
    return () => {
      if (pendingCanvasFocusFrameRef.current != null) {
        window.cancelAnimationFrame(pendingCanvasFocusFrameRef.current)
        pendingCanvasFocusFrameRef.current = null
      }
    }
  }, [])

  const selectItem = React.useCallback(
    (itemId: string, allowAnnotate = false, additiveSelection = false) => {
      if (tool !== 'select' && (!allowAnnotate || tool !== 'annotate')) return
      if (isMiddleMouseRef.current) return

      activateCanvas()
      lastClickedIdRef.current = itemId
      setSelectedIds((prev: Set<string>) => {
        if (additiveSelection) {
          const next = new Set(prev)
          if (next.has(itemId)) next.delete(itemId)
          else next.add(itemId)
          return next
        }
        if (prev.size === 1 && prev.has(itemId)) {
          return prev
        }
        return new Set([itemId])
      })
    },
    [activateCanvas, isMiddleMouseRef, lastClickedIdRef, setSelectedIds, tool]
  )

  const syncWebGLImagePreview = React.useCallback(
    (itemId: string, preview: ProjectCanvasImagePreview | null) => {
      webglImageLayerRef.current?.syncItemPreview(itemId, preview)
      dispatchCanvasLiveVisualBoundsChange([itemId])
    },
    []
  )
  const handlePlaceholderRectOverlayPreviewChange = React.useCallback(
    (_itemId: string, preview: ProjectCanvasRectItemTransform | null) => {
      if (!selectedSinglePlaceholderItem) {
        return
      }

      const mappedPreview = preview
        ? getCanvasPlaceholderInteractionTransformCommit(selectedSinglePlaceholderItem, preview)
        : null

      if (mappedPreview) {
        scheduleCanvasSync(selectedSinglePlaceholderItem.id, mappedPreview)
      } else {
        cancelCanvasSync(selectedSinglePlaceholderItem.id)
      }

      dispatchCanvasLiveVisualBoundsChange([selectedSinglePlaceholderItem.id])
    },
    [selectedSinglePlaceholderItem]
  )
  const handlePlaceholderRectOverlayDragEnd = React.useCallback(
    (itemId: string, x: number, y: number, evt?: PointerEvent) => {
      if (!selectedSinglePlaceholderItem || !selectedSinglePlaceholderOverlayItem) {
        return
      }

      const mappedTransform = getCanvasPlaceholderInteractionTransformCommit(
        selectedSinglePlaceholderItem,
        {
          x,
          y,
          scaleX: selectedSinglePlaceholderOverlayItem.scaleX,
          scaleY: selectedSinglePlaceholderOverlayItem.scaleY,
          rotation: selectedSinglePlaceholderOverlayItem.rotation
        }
      )

      handleDragEnd(itemId, mappedTransform.x, mappedTransform.y, evt)
    },
    [handleDragEnd, selectedSinglePlaceholderItem, selectedSinglePlaceholderOverlayItem]
  )
  const handlePlaceholderDragStart = React.useCallback(
    (itemId: string) => {
      if (!dragContextRef?.current) {
        return
      }

      dragContextRef.current.draggingId = itemId
    },
    [dragContextRef]
  )
  const handlePlaceholderDragEnd = React.useCallback(
    (itemId: string, x: number, y: number, evt?: PointerEvent) => {
      if (dragContextRef?.current?.draggingId === itemId) {
        dragContextRef.current.draggingId = null
      }

      handleDragEnd(itemId, x, y, evt)
    },
    [dragContextRef, handleDragEnd]
  )
  const handleAnnotationPlaceholderPreviewChange = React.useCallback(
    (
      item: CanvasAnnotationItem,
      overlayItem: CanvasAnnotationInteractionOverlayItem,
      preview: ProjectCanvasRectItemTransform | null
    ) => {
      if (preview) {
        const dragPreview = getCanvasAnnotationDragCommit(item, overlayItem, preview.x, preview.y)
        scheduleCanvasSync(item.id, {
          x: dragPreview.x ?? item.x,
          y: dragPreview.y ?? item.y,
          rotation: preview.rotation,
          scaleX: preview.scaleX,
          scaleY: preview.scaleY
        })
      } else {
        cancelCanvasSync(item.id)
      }

      dispatchCanvasLiveVisualBoundsChange([item.id])
    },
    []
  )
  const handleAnnotationPlaceholderDragEnd = React.useCallback(
    (
      item: CanvasAnnotationItem,
      overlayItem: CanvasAnnotationInteractionOverlayItem,
      itemId: string,
      x: number,
      y: number,
      evt?: PointerEvent
    ) => {
      if (dragContextRef?.current?.draggingId === itemId) {
        dragContextRef.current.draggingId = null
      }

      cancelCanvasSync(itemId)
      const updates = getCanvasAnnotationDragCommit(item, overlayItem, x, y)
      const shape = resolveCanvasAnnotationShape(item)

      if (shape === 'arrow' || shape === 'line' || shape === 'freedraw') {
        handleTransformEnd(itemId, updates)
        return
      }

      handleDragEnd(itemId, updates.x ?? item.x, updates.y ?? item.y, evt)
    },
    [dragContextRef, handleDragEnd, handleTransformEnd]
  )
  const handleSelectedTextOverlayPreviewChange = React.useCallback(
    (
      item: CanvasTextItem,
      preview: ProjectCanvasRectItemTransform | null,
      handle: ProjectCanvasRectItemInteractionHandle | null
    ) => {
      updateCanvasTextLiveBoundsDisplay(item, preview, handle)

      if (preview && handle === 'drag') {
        const syncDetail = {
          x: preview.x,
          y: preview.y,
          rotation: preview.rotation,
          scaleX: preview.scaleX,
          scaleY: preview.scaleY
        }
        cancelCanvasSync(item.id)
        window.dispatchEvent(new CustomEvent(`canvas-sync-${item.id}`, { detail: syncDetail }))
        dispatchCanvasLiveVisualBoundsChange([item.id])
        return
      }

      cancelCanvasSync(item.id)
      dispatchCanvasLiveVisualBoundsChange([item.id])
    },
    []
  )
  const handleSelectedTextOverlayDragEnd = React.useCallback(
    (itemId: string, x: number, y: number, evt?: PointerEvent) => {
      cancelCanvasSync(itemId)
      handleDragEnd(itemId, x, y, evt)
    },
    [handleDragEnd]
  )
  const handlePlaceholderRectOverlayTransformEnd = React.useCallback(
    (itemId: string, attrs: ProjectCanvasRectItemTransform) => {
      if (!selectedSinglePlaceholderItem) {
        return
      }

      handleTransformEnd(
        itemId,
        getCanvasPlaceholderInteractionTransformCommit(selectedSinglePlaceholderItem, attrs)
      )
    },
    [handleTransformEnd, selectedSinglePlaceholderItem]
  )
  const handleSelectedAnnotationOverlayPreviewChange = React.useCallback(
    (
      item: CanvasAnnotationItem,
      overlayItem: CanvasAnnotationInteractionOverlayItem | null,
      preview: ProjectCanvasRectItemTransform | null,
      handle: ProjectCanvasRectItemInteractionHandle | null
    ) => {
      updateCanvasAnnotationLiveBoundsDisplay(item, preview, handle)

      if (preview && handle === 'drag' && overlayItem) {
        const dragPreview = getCanvasAnnotationDragCommit(item, overlayItem, preview.x, preview.y)
        const syncDetail = {
          x: dragPreview.x ?? item.x,
          y: dragPreview.y ?? item.y,
          rotation: preview.rotation,
          scaleX: preview.scaleX,
          scaleY: preview.scaleY
        }
        cancelCanvasSync(item.id)
        window.dispatchEvent(new CustomEvent(`canvas-sync-${item.id}`, { detail: syncDetail }))
        dispatchCanvasLiveVisualBoundsChange([item.id])
        return
      }

      cancelCanvasSync(item.id)
      dispatchCanvasLiveVisualBoundsChange([item.id])
    },
    []
  )
  const handleAnnotationRectOverlayDragEnd = React.useCallback(
    (itemId: string, x: number, y: number, evt?: PointerEvent) => {
      if (!selectedSingleAnnotationItem || !selectedSingleAnnotationOverlayItem) {
        return
      }

      cancelCanvasSync(itemId)
      const updates = getCanvasAnnotationDragCommit(
        selectedSingleAnnotationItem,
        selectedSingleAnnotationOverlayItem,
        x,
        y
      )
      const shape = resolveCanvasAnnotationShape(selectedSingleAnnotationItem)

      if (shape === 'arrow' || shape === 'line' || shape === 'freedraw') {
        handleTransformEnd(itemId, updates)
        return
      }

      handleDragEnd(
        itemId,
        updates.x ?? selectedSingleAnnotationItem.x,
        updates.y ?? selectedSingleAnnotationItem.y,
        evt
      )
    },
    [
      handleDragEnd,
      handleTransformEnd,
      selectedSingleAnnotationItem,
      selectedSingleAnnotationOverlayItem
    ]
  )
  const isImageIdentityCrop = React.useCallback((item: CanvasImageItem) => {
    if (!item.crop) return false

    const sourceWidth =
      typeof item.sourceWidth === 'number' &&
      Number.isFinite(item.sourceWidth) &&
      item.sourceWidth > 0
        ? item.sourceWidth
        : item.width
    const sourceHeight =
      typeof item.sourceHeight === 'number' &&
      Number.isFinite(item.sourceHeight) &&
      item.sourceHeight > 0
        ? item.sourceHeight
        : item.height

    return (
      item.crop.x === 0 &&
      item.crop.y === 0 &&
      item.crop.width === sourceWidth &&
      item.crop.height === sourceHeight
    )
  }, [])
  const handleCanvasContainerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if ('current' in canvasContainerRef) {
        canvasContainerRef.current = node
      }
      setCanvasContainerElement?.(node)
    },
    [canvasContainerRef, setCanvasContainerElement]
  )
  const openCanvasTextInlineEditor = React.useCallback(
    (textItem: CanvasTextItem) => {
      setSelectedIds(new Set())
      const fontSize = textItem.fontSize ?? 36
      const absW = Math.max(10, textItem.width * Math.abs(textItem.scaleX))
      const absH = Math.max(10, textItem.height * Math.abs(textItem.scaleY))
      const sy = textItem.scaleY

      setInlineTextEdit({
        id: textItem.id,
        x: textItem.x,
        y: textItem.y,
        w: absW,
        h: absH,
        text: textItem.text,
        isNew: false,
        fontSize: fontSize * Math.abs(sy),
        fontFamily: textItem.fontFamily,
        fontWeight: textItem.fontWeight,
        fill: textItem.fill
      })
    },
    [setInlineTextEdit, setSelectedIds]
  )
  const handleCropConfirm = React.useCallback(
    (item: CanvasImageItem, updates: Partial<CanvasImageItem>) => {
      lastClickedIdRef.current = item.id
      setSelectedIds(new Set([item.id]))
      setItemsWithHistory((prev: CanvasItem[]) =>
        prev.map((i) => {
          if (i.id === item.id) {
            return { ...i, ...updates }
          }

          if (i.type === 'image' && isImageIdentityCrop(i as CanvasImageItem)) {
            const { crop, ...rest } = i as CanvasImageItem
            return rest as CanvasItem
          }

          return i
        })
      )
      setTool('select')
      setCroppingImageId(null)
    },
    [
      isImageIdentityCrop,
      lastClickedIdRef,
      setCroppingImageId,
      setItemsWithHistory,
      setSelectedIds,
      setTool
    ]
  )
  const handleCropCancel = React.useCallback(() => {
    setTool('select')
    setCroppingImageId(null)
  }, [setCroppingImageId, setTool])
  const handleExtractConfirm = React.useCallback(
    (item: CanvasImageItem, updates: Partial<CanvasImageItem>) => {
      if (!updates.crop) {
        return
      }

      setSelectedIds(new Set([item.id]))
      lastClickedIdRef.current = item.id
      void handleExtractImageRegion?.(item, updates.crop)
    },
    [handleExtractImageRegion, lastClickedIdRef, setSelectedIds]
  )
  const handleExtractCancel = React.useCallback(() => {
    setTool('select')
    setExtractingImageId?.(null)
  }, [setExtractingImageId, setTool])
  const shouldCaptureStageMarqueeSelection =
    tool === 'select' || tool === 'export-select' || tool === 'target-select'
  const isMarqueeCaptureRef = React.useRef(false)
  const isPointerGestureActiveRef = React.useRef(false)
  const pointerGestureMouseGuardRef = React.useRef<number | null>(null)
  const clearPointerGestureMouseGuard = React.useCallback(() => {
    if (pointerGestureMouseGuardRef.current != null) {
      window.clearTimeout(pointerGestureMouseGuardRef.current)
      pointerGestureMouseGuardRef.current = null
    }
    isPointerGestureActiveRef.current = false
  }, [])
  const beginPointerGestureMouseGuard = React.useCallback(() => {
    if (pointerGestureMouseGuardRef.current != null) {
      window.clearTimeout(pointerGestureMouseGuardRef.current)
      pointerGestureMouseGuardRef.current = null
    }
    isPointerGestureActiveRef.current = true
  }, [])
  const armPointerGestureMouseGuard = React.useCallback(() => {
    pointerGestureMouseGuardRef.current = window.setTimeout(() => {
      pointerGestureMouseGuardRef.current = null
      isPointerGestureActiveRef.current = false
    }, 0)
  }, [])
  React.useEffect(() => clearPointerGestureMouseGuard, [clearPointerGestureMouseGuard])
  const shouldIgnoreMouseCompatEvent = React.useCallback(
    (_event: React.MouseEvent<HTMLDivElement>) =>
      isPointerGestureActiveRef.current || pointerGestureMouseGuardRef.current != null,
    []
  )
  const isSupportedStagePointerEvent = React.useCallback(
    (event: PointerEvent) => event.pointerType !== 'touch',
    []
  )
  const handleStageSurfaceMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      isMarqueeCaptureRef.current = shouldCaptureStageMarqueeSelection && event.button === 0
      handleStageMouseDown({
        evt: event.nativeEvent,
        type: event.type
      })
    },
    [handleStageMouseDown, shouldCaptureStageMarqueeSelection, shouldIgnoreMouseCompatEvent]
  )
  const handleStageSurfaceMouseMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      handleStageMouseMove({
        evt: event.nativeEvent,
        type: event.type
      })
    },
    [handleStageMouseMove, shouldIgnoreMouseCompatEvent]
  )
  const handleStageSurfaceMouseUp = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      if (event.type === 'mouseleave' && (event.buttons >= 1 || isMarqueeCaptureRef.current)) {
        return
      }

      handleStageMouseUp({
        evt: event.nativeEvent,
        type: event.type
      })
      isMarqueeCaptureRef.current = false
    },
    [handleStageMouseUp, shouldIgnoreMouseCompatEvent]
  )
  const liveSelectionOverlayGroups = useLiveSelectionOverlayGroups({
    canvasContainerRef,
    selectionOverlayGroups,
    stagePos,
    stageRef,
    stageScale
  })
  const isHandToolCaptureRef = React.useRef(false)
  React.useEffect(() => {
    const container = canvasContainerRef.current
    if (!container || !handleStageWheel) {
      return
    }

    const handleNativeWheelCapture = (event: WheelEvent) => {
      activateCanvas()
      handleStageWheel({
        evt: event,
        type: event.type
      })
    }

    container.addEventListener('wheel', handleNativeWheelCapture, {
      capture: true,
      passive: false
    })

    return () => {
      container.removeEventListener('wheel', handleNativeWheelCapture, true)
    }
  }, [activateCanvas, canvasContainerRef, handleStageWheel])
  const isStageEventLayerTarget = React.useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) {
      return false
    }

    return Boolean(target.closest('[data-project-canvas-stage-event-layer="dom"]'))
  }, [])
  const getStageMarqueeFallbackBlockReason = React.useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return 'non-element'
      }

      if (isStageEventLayerTarget(target)) {
        return 'stage-event-layer'
      }

      return (
        STAGE_MARQUEE_FALLBACK_BLOCKING_SELECTORS.find((selector) =>
          Boolean(target.closest(selector))
        ) ?? null
      )
    },
    [isStageEventLayerTarget]
  )
  const isStageMarqueeFallbackTarget = React.useCallback(
    (target: EventTarget | null) => getStageMarqueeFallbackBlockReason(target) == null,
    [getStageMarqueeFallbackBlockReason]
  )
  const handleStageRootMouseDownCapture = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      activateCanvas()

      const isStageLayerTarget = isStageEventLayerTarget(event.target)
      const shouldCaptureMarqueeFromRootFallback =
        shouldCaptureStageMarqueeSelection &&
        event.button === 0 &&
        !isStageLayerTarget &&
        isStageMarqueeFallbackTarget(event.target)

      if (shouldCaptureMarqueeFromRootFallback) {
        event.preventDefault()
        event.stopPropagation()
        isMarqueeCaptureRef.current = true
        handleStageMouseDown({
          evt: event.nativeEvent,
          type: event.type
        })
        return
      }

      if (event.button === 0 && !isStageLayerTarget) {
        isMarqueeCaptureRef.current = false
      }
      const shouldCaptureHandToolPan = tool === 'hand' && event.button === 0 && !isStageLayerTarget
      if (shouldCaptureHandToolPan) {
        event.preventDefault()
        event.stopPropagation()
        isHandToolCaptureRef.current = true
        handleStageMouseDown({
          evt: event.nativeEvent,
          type: event.type
        })
        return
      }

      if (event.button !== 1 || isStageLayerTarget) {
        return
      }

      handleStageMouseDown({
        evt: event.nativeEvent,
        type: event.type
      })
    },
    [
      activateCanvas,
      handleStageMouseDown,
      isStageEventLayerTarget,
      isStageMarqueeFallbackTarget,
      shouldIgnoreMouseCompatEvent,
      shouldCaptureStageMarqueeSelection,
      tool
    ]
  )
  const handleStageRootMouseMoveCapture = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      if (isHandToolCaptureRef.current) {
        event.preventDefault()
        event.stopPropagation()
        handleStageMouseMove({
          evt: event.nativeEvent,
          type: event.type
        })
        return
      }

      if (isMarqueeCaptureRef.current && !isStageEventLayerTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        handleStageMouseMove({
          evt: event.nativeEvent,
          type: event.type
        })
        return
      }

      if (!isMiddleMouseRef.current || isStageEventLayerTarget(event.target)) {
        return
      }

      handleStageMouseMove({
        evt: event.nativeEvent,
        type: event.type
      })
    },
    [handleStageMouseMove, isMiddleMouseRef, isStageEventLayerTarget, shouldIgnoreMouseCompatEvent]
  )
  const handleStageRootMouseUpCapture = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreMouseCompatEvent(event)) {
        return
      }

      if (isHandToolCaptureRef.current) {
        event.preventDefault()
        event.stopPropagation()
        isHandToolCaptureRef.current = false
        handleStageMouseUp({
          evt: event.nativeEvent,
          type: event.type
        })
        return
      }

      if (isMarqueeCaptureRef.current && !isStageEventLayerTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        handleStageMouseUp({
          evt: event.nativeEvent,
          type: event.type
        })
        isMarqueeCaptureRef.current = false
        return
      }

      if (!isMiddleMouseRef.current || isStageEventLayerTarget(event.target)) {
        return
      }

      handleStageMouseUp({
        evt: event.nativeEvent,
        type: event.type
      })
    },
    [handleStageMouseUp, isMiddleMouseRef, isStageEventLayerTarget, shouldIgnoreMouseCompatEvent]
  )
  React.useEffect(() => {
    if (!isHandToolCaptureRef.current) {
      return
    }

    const releaseHandToolCapture = (nativeEvent: MouseEvent | PointerEvent) => {
      if (!isHandToolCaptureRef.current) {
        return
      }
      isHandToolCaptureRef.current = false
      handleStageMouseUp({
        evt: nativeEvent,
        type: nativeEvent.type
      })
    }

    window.addEventListener('mouseup', releaseHandToolCapture, true)
    window.addEventListener('pointerup', releaseHandToolCapture, true)
    window.addEventListener('pointercancel', releaseHandToolCapture, true)

    return () => {
      window.removeEventListener('mouseup', releaseHandToolCapture, true)
      window.removeEventListener('pointerup', releaseHandToolCapture, true)
      window.removeEventListener('pointercancel', releaseHandToolCapture, true)
    }
  }, [handleStageMouseUp])
  React.useEffect(() => {
    const describeTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return null
      }

      return (
        target.getAttribute('data-project-canvas-stage-event-layer') ||
        target.getAttribute('data-project-canvas-scene-overlay') ||
        target.getAttribute('data-project-canvas-proxy-layer') ||
        target.getAttribute('data-testid') ||
        target.getAttribute('aria-label') ||
        target.className ||
        target.tagName
      )
    }
    const pushPointerBridgeTrace = (
      phase: string,
      nativeEvent: PointerEvent,
      extra?: Record<string, unknown>
    ) => {
      const traceWindow = window as Window & {
        __canvasStagePointerBridgeTrace?: Array<Record<string, unknown>>
      }
      if (!traceWindow.__canvasStagePointerBridgeTrace) {
        traceWindow.__canvasStagePointerBridgeTrace = []
      }

      traceWindow.__canvasStagePointerBridgeTrace.push({
        phase,
        type: nativeEvent.type,
        button: nativeEvent.button,
        buttons: nativeEvent.buttons,
        pointerType: nativeEvent.pointerType,
        target: describeTarget(nativeEvent.target),
        ...extra
      })
      if (traceWindow.__canvasStagePointerBridgeTrace.length > 80) {
        traceWindow.__canvasStagePointerBridgeTrace.shift()
      }
    }
    const handleNativePointerDownCapture = (nativeEvent: PointerEvent) => {
      if (!isSupportedStagePointerEvent(nativeEvent)) {
        pushPointerBridgeTrace('pointer-down-unsupported', nativeEvent)
        return
      }

      const container = canvasContainerRef.current
      if (
        !container ||
        !(nativeEvent.target instanceof Node) ||
        !container.contains(nativeEvent.target)
      ) {
        pushPointerBridgeTrace('pointer-down-outside-container', nativeEvent)
        return
      }

      const isStageLayerTarget = isStageEventLayerTarget(nativeEvent.target)
      const shouldCaptureMarqueeFromRootFallback =
        shouldCaptureStageMarqueeSelection &&
        nativeEvent.button === 0 &&
        !isStageLayerTarget &&
        isStageMarqueeFallbackTarget(nativeEvent.target)
      const shouldCaptureStageSurfaceGesture = isStageLayerTarget
      const shouldCaptureHandToolPan = tool === 'hand' && nativeEvent.button === 0
      const shouldCaptureMiddleMousePan = nativeEvent.button === 1

      if (
        !shouldCaptureStageSurfaceGesture &&
        !shouldCaptureMarqueeFromRootFallback &&
        !shouldCaptureHandToolPan &&
        !shouldCaptureMiddleMousePan
      ) {
        pushPointerBridgeTrace('pointer-down-skip', nativeEvent, {
          isStageLayerTarget,
          marqueeFallbackBlockReason: getStageMarqueeFallbackBlockReason(nativeEvent.target),
          shouldCaptureMarqueeFromRootFallback,
          shouldCaptureStageSurfaceGesture,
          shouldCaptureHandToolPan,
          shouldCaptureMiddleMousePan
        })
        return
      }

      beginPointerGestureMouseGuard()
      activateCanvas()
      pushPointerBridgeTrace('pointer-down-capture', nativeEvent, {
        isStageLayerTarget,
        marqueeFallbackBlockReason: getStageMarqueeFallbackBlockReason(nativeEvent.target),
        shouldCaptureMarqueeFromRootFallback,
        shouldCaptureStageSurfaceGesture,
        shouldCaptureHandToolPan,
        shouldCaptureMiddleMousePan
      })

      if (shouldCaptureStageSurfaceGesture) {
        isMarqueeCaptureRef.current = shouldCaptureStageMarqueeSelection && nativeEvent.button === 0
        handleStageMouseDown({
          evt: nativeEvent,
          type: nativeEvent.type
        })
        return
      }

      if (shouldCaptureMarqueeFromRootFallback) {
        nativeEvent.preventDefault()
        isMarqueeCaptureRef.current = true
        handleStageMouseDown({
          evt: nativeEvent,
          type: nativeEvent.type
        })
        return
      }

      if (nativeEvent.button === 0 && !isStageLayerTarget) {
        isMarqueeCaptureRef.current = false
      }

      if (shouldCaptureHandToolPan && !isStageLayerTarget) {
        isHandToolCaptureRef.current = true
        handleStageMouseDown({
          evt: nativeEvent,
          type: nativeEvent.type
        })
        return
      }

      if (shouldCaptureMiddleMousePan && !isStageLayerTarget) {
        handleStageMouseDown({
          evt: nativeEvent,
          type: nativeEvent.type
        })
      }
    }

    const handleNativePointerMoveCapture = (nativeEvent: PointerEvent) => {
      if (!isSupportedStagePointerEvent(nativeEvent)) {
        return
      }

      if (
        !isPointerGestureActiveRef.current &&
        !isHandToolCaptureRef.current &&
        !isMarqueeCaptureRef.current &&
        !isMiddleMouseRef.current
      ) {
        return
      }

      pushPointerBridgeTrace('pointer-move-forward', nativeEvent, {
        isPointerGestureActive: isPointerGestureActiveRef.current,
        isHandToolCapture: isHandToolCaptureRef.current,
        isMarqueeCapture: isMarqueeCaptureRef.current,
        isMiddleMouse: isMiddleMouseRef.current
      })
      handleStageMouseMove({
        evt: nativeEvent,
        type: nativeEvent.type
      })
    }

    const handleNativePointerUpCapture = (nativeEvent: PointerEvent) => {
      if (!isSupportedStagePointerEvent(nativeEvent)) {
        armPointerGestureMouseGuard()
        return
      }

      const hadActiveGesture =
        isPointerGestureActiveRef.current ||
        isHandToolCaptureRef.current ||
        isMarqueeCaptureRef.current ||
        isMiddleMouseRef.current

      if (!hadActiveGesture) {
        pushPointerBridgeTrace('pointer-up-no-active-gesture', nativeEvent)
        armPointerGestureMouseGuard()
        return
      }

      pushPointerBridgeTrace('pointer-up-forward', nativeEvent, {
        isPointerGestureActive: isPointerGestureActiveRef.current,
        isHandToolCapture: isHandToolCaptureRef.current,
        isMarqueeCapture: isMarqueeCaptureRef.current,
        isMiddleMouse: isMiddleMouseRef.current
      })
      const wasHandToolCapture = isHandToolCaptureRef.current
      const wasMarqueeCapture = isMarqueeCaptureRef.current
      if (wasHandToolCapture) {
        isHandToolCaptureRef.current = false
      }
      if (wasMarqueeCapture) {
        isMarqueeCaptureRef.current = false
      }

      handleStageMouseUp({
        evt: nativeEvent,
        type: nativeEvent.type
      })
      armPointerGestureMouseGuard()
    }

    window.addEventListener('pointerdown', handleNativePointerDownCapture, true)
    window.addEventListener('pointermove', handleNativePointerMoveCapture, true)
    window.addEventListener('pointerup', handleNativePointerUpCapture, true)
    window.addEventListener('pointercancel', handleNativePointerUpCapture, true)

    return () => {
      window.removeEventListener('pointerdown', handleNativePointerDownCapture, true)
      window.removeEventListener('pointermove', handleNativePointerMoveCapture, true)
      window.removeEventListener('pointerup', handleNativePointerUpCapture, true)
      window.removeEventListener('pointercancel', handleNativePointerUpCapture, true)
    }
  }, [
    activateCanvas,
    armPointerGestureMouseGuard,
    beginPointerGestureMouseGuard,
    canvasContainerRef,
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    isMiddleMouseRef,
    isStageEventLayerTarget,
    getStageMarqueeFallbackBlockReason,
    isStageMarqueeFallbackTarget,
    isSupportedStagePointerEvent,
    shouldCaptureStageMarqueeSelection,
    tool
  ])
  React.useEffect(() => {
    const forwardWindowMarqueeMouseMove = (nativeEvent: MouseEvent) => {
      if (!isMarqueeCaptureRef.current) {
        return
      }

      const container = canvasContainerRef.current
      if (
        container &&
        nativeEvent.target instanceof Node &&
        container.contains(nativeEvent.target)
      ) {
        return
      }

      handleStageMouseMove({
        evt: nativeEvent,
        type: nativeEvent.type
      })
    }

    const forwardWindowMarqueeMouseUp = (nativeEvent: MouseEvent) => {
      if (!isMarqueeCaptureRef.current) {
        return
      }

      const container = canvasContainerRef.current
      if (
        container &&
        nativeEvent.target instanceof Node &&
        container.contains(nativeEvent.target)
      ) {
        return
      }

      isMarqueeCaptureRef.current = false
      handleStageMouseUp({
        evt: nativeEvent,
        type: nativeEvent.type
      })
    }

    window.addEventListener('mousemove', forwardWindowMarqueeMouseMove, true)
    window.addEventListener('mouseup', forwardWindowMarqueeMouseUp, true)

    return () => {
      window.removeEventListener('mousemove', forwardWindowMarqueeMouseMove, true)
      window.removeEventListener('mouseup', forwardWindowMarqueeMouseUp, true)
    }
  }, [canvasContainerRef, handleStageMouseMove, handleStageMouseUp])
  const proxyLayerCandidateItems = React.useMemo(() => {
    const candidates: CanvasItem[] = []

    for (const item of visibleItems) {
      if (activeRegionSelectionImageItem?.id === item.id) {
        continue
      }

      const renderableMediaItem = renderableMediaItemMap.get(item.id)

      if (item.type === 'image') {
        if (
          renderableMediaItem?.interactionProxy === 'canvas-image-node' &&
          placeholderProxyImageIdSet.has(item.id)
        ) {
          candidates.push(item)
        }
        continue
      }

      if (item.type === 'text' || item.type === 'file' || item.type === 'annotation') {
        candidates.push(item)
        continue
      }

      if (
        renderableMediaItem?.interactionProxy === 'canvas-placeholder' &&
        renderableMediaItem.kind !== 'video'
      ) {
        candidates.push(item)
      }
    }

    return candidates
  }, [
    activeRegionSelectionImageItem?.id,
    placeholderProxyImageIdSet,
    renderableMediaItemMap,
    visibleItems
  ])
  const proxyLayerElements = React.useMemo(() => {
    return proxyLayerCandidateItems.map((item: CanvasItem) => {
      const isSelected = selectedIds.has(item.id) && tool === 'select'
      const renderableMediaItem = renderableMediaItemMap.get(item.id)

      if (renderableMediaItem?.interactionProxy === 'canvas-image-node') {
        if (item.type === 'image' && !placeholderProxyImageIdSet.has(item.id)) {
          return null
        }

        if (item.type === 'image') {
          const imageItem = item as CanvasImageItem
          const imageRuntimeRoute = getImageRuntimeRoute(imageItem)
          const imageFallbackReason = imageFallbackReasonById.get(item.id)
          const canRenderImagePreview =
            Boolean(imageItem.image) || (tool === 'select' && !!imageItem.src)
          const imageProxyVisualVariant =
            imageRuntimeRoute === 'webgl-primary' ||
            (!canRenderImagePreview && imageFallbackReason === 'unloaded')
              ? 'transparent'
              : 'image-fallback'
          return (
            <CanvasItemPlaceholder
              key={item.id}
              canvasContainerRef={canvasContainerRef}
              item={imageItem}
              isSelected={isSelected}
              isDraggable={tool === 'select' && !(item as CanvasImageItem).locked}
              allowPointerPassthrough={tool === 'hand'}
              renderMode="dom-placeholder-proxy"
              visualVariant={imageProxyVisualVariant}
              stagePos={stagePos}
              stageScale={stageScale}
              stagePosRef={stagePosRef}
              stageScaleRef={stageScaleRef}
              onPreviewChange={tool === 'select' ? syncWebGLImagePreview : undefined}
              onDragStart={handlePlaceholderDragStart}
              onSelect={(additiveSelection) => {
                selectItem(item.id, false, Boolean(additiveSelection))
              }}
              onDragEnd={handlePlaceholderDragEnd}
              onTransformEnd={handleTransformEnd as any}
              onContextMenu={(event) => handleImageContextMenu(event as any, item)}
            />
          )
        }
      }
      if (item.type === 'text') {
        const textItem = item as CanvasTextItem
        const useDomRectOverlay = selectedSingleTextItem?.id === textItem.id
        return (
          <CanvasItemPlaceholder
            key={item.id}
            canvasContainerRef={canvasContainerRef}
            item={textItem}
            isSelected={false}
            isDraggable={tool === 'select' && !textItem.locked && !useDomRectOverlay}
            allowPointerPassthrough={tool === 'hand'}
            renderMode="dom-text-proxy"
            stagePos={stagePos}
            stageScale={stageScale}
            stagePosRef={stagePosRef}
            stageScaleRef={stageScaleRef}
            onDragStart={handlePlaceholderDragStart}
            onSelect={(additiveSelection?: boolean) => {
              selectItem(item.id, false, Boolean(additiveSelection))
            }}
            onDragEnd={handlePlaceholderDragEnd}
            onTransformEnd={handleTransformEnd}
            onContextMenu={(event) => handleImageContextMenu(event as any, item)}
            onDoubleClick={() => openCanvasTextInlineEditor(textItem)}
          />
        )
      }
      if (item.type === 'file') {
        const fileItem = item as CanvasFileItem
        const useDomRectOverlay = selectedSingleFileItem?.id === fileItem.id
        return (
          <CanvasItemPlaceholder
            key={item.id}
            canvasContainerRef={canvasContainerRef}
            item={fileItem}
            isSelected={false}
            isDraggable={tool === 'select' && !fileItem.locked && !useDomRectOverlay}
            allowPointerPassthrough={tool === 'hand'}
            renderMode="dom-file-proxy"
            stagePos={stagePos}
            stageScale={stageScale}
            onDragStart={handlePlaceholderDragStart}
            onSelect={(additiveSelection) => {
              selectItem(item.id, false, Boolean(additiveSelection))
            }}
            onDragEnd={handlePlaceholderDragEnd}
            onTransformEnd={handleTransformEnd as any}
            onDoubleClick={() => handleOpenFileDialog(fileItem.id)}
            onContextMenu={(event) => handleImageContextMenu(event as any, item)}
          />
        )
      }
      if (item.type === 'annotation') {
        const annoItem = item as CanvasAnnotationItem
        const attachedCaption = annoItem as AttachedCaptionAnnotation
        const hasAttachedParent = Boolean(
          attachedCaption.attachedToId && itemIdSet.has(attachedCaption.attachedToId)
        )
        const useDomRectOverlay = selectedSingleAnnotationItem?.id === annoItem.id
        const proxyRect = getCanvasAnnotationInteractionOverlayItem(annoItem)
        return (
          <CanvasItemPlaceholder
            key={item.id}
            canvasContainerRef={canvasContainerRef}
            item={annoItem}
            isSelected={isSelected && !useDomRectOverlay}
            isDraggable={
              tool === 'select' && !annoItem.locked && !hasAttachedParent && !useDomRectOverlay
            }
            allowPointerPassthrough={tool === 'hand'}
            renderMode="dom-annotation-proxy"
            proxyRect={proxyRect}
            stagePos={stagePos}
            stageScale={stageScale}
            stagePosRef={stagePosRef}
            stageScaleRef={stageScaleRef}
            onDragStart={handlePlaceholderDragStart}
            onRectPreviewChange={(_itemId, preview) => {
              handleAnnotationPlaceholderPreviewChange(annoItem, proxyRect, preview)
            }}
            onSelect={(additiveSelection) => {
              selectItem(item.id, true, Boolean(additiveSelection))
            }}
            onDragEnd={(itemId, x, y, evt) => {
              handleAnnotationPlaceholderDragEnd(annoItem, proxyRect, itemId, x, y, evt)
            }}
            onTransformEnd={handleTransformEnd}
            onContextMenu={(event) => handleImageContextMenu(event as any, item)}
            onHoverChange={
              annoItem.ocrBundleId && annoItem.ocrBoxId
                ? (isHovering) => {
                    setActiveOcrHover(
                      isHovering
                        ? {
                            bundleId: annoItem.ocrBundleId!,
                            bboxIds: [annoItem.ocrBoxId!],
                            cellIds: annoItem.ocrCellIds || []
                          }
                        : null
                    )
                  }
                : undefined
            }
            onDoubleClick={() => {
              setSelectedIds(new Set())
              if (annoItem.shape === 'text-anno') {
                const absW = Math.max(10, (annoItem.width || 150) * Math.abs(annoItem.scaleX))
                const absH = Math.max(10, (annoItem.height || 40) * Math.abs(annoItem.scaleY))
                const sy = annoItem.scaleY
                setInlineTextEdit({
                  id: annoItem.id,
                  x: annoItem.x,
                  y: annoItem.y,
                  w: absW,
                  h: absH,
                  text: annoItem.text || '',
                  isNew: false,
                  fontSize: (annoItem.fontSize || 36) * Math.abs(sy),
                  attachedToId: (annoItem as AttachedCaptionAnnotation).attachedToId,
                  attachmentPlacement: (annoItem as AttachedCaptionAnnotation).attachmentPlacement
                })
              } else {
                setLabelDialogItemId(item.id)
                setLabelDialogText(annoItem.label)
                setLabelDialogOpen(true)
              }
            }}
          />
        )
      }
      if (renderableMediaItem?.interactionProxy === 'canvas-placeholder') {
        if (renderableMediaItem.kind === 'video') {
          return null
        }

        const useDomRectOverlay = selectedSinglePlaceholderItem?.id === item.id
        return (
          <CanvasItemPlaceholder
            key={item.id}
            canvasContainerRef={canvasContainerRef}
            item={renderableMediaItem.item}
            isSelected={isSelected && !useDomRectOverlay}
            isDraggable={
              tool === 'select' && !renderableMediaItem.item.locked && !useDomRectOverlay
            }
            allowPointerPassthrough={tool === 'hand'}
            renderMode="dom-model3d-proxy"
            stagePos={stagePos}
            stageScale={stageScale}
            stagePosRef={stagePosRef}
            stageScaleRef={stageScaleRef}
            onDragStart={handlePlaceholderDragStart}
            onSelect={(additiveSelection) => {
              selectItem(item.id, false, Boolean(additiveSelection))
            }}
            onDragEnd={handlePlaceholderDragEnd}
            onDoubleClick={
              renderableMediaItem.kind === 'model3d'
                ? () => handleOpenModel3DViewer(item.id)
                : undefined
            }
            onTransformEnd={handleTransformEnd}
            onContextMenu={(event) => handleImageContextMenu(event as any, item)}
          />
        )
      }

      return null
    })
  }, [
    canvasContainerRef,
    handleImageContextMenu,
    handleOpenFileDialog,
    handleOpenModel3DViewer,
    handlePlaceholderDragEnd,
    handlePlaceholderDragStart,
    handleTransformEnd,
    imageFallbackReasonById,
    itemIdSet,
    openCanvasTextInlineEditor,
    renderableMediaItemMap,
    selectedIds,
    placeholderProxyImageIdSet,
    proxyLayerCandidateItems,
    syncWebGLImagePreview,
    selectedSingleAnnotationItem?.id,
    selectedSingleFileItem?.id,
    selectedSinglePlaceholderItem?.id,
    selectedSingleTextItem?.id,
    selectItem,
    setActiveOcrHover,
    setInlineTextEdit,
    setLabelDialogItemId,
    setLabelDialogOpen,
    setLabelDialogText,
    setSelectedIds,
    stagePosRef,
    stageScaleRef,
    tool
  ])
  const hasProxyLayerElements = proxyLayerElements.some(Boolean)

  return (
    <Box
      ref={handleCanvasContainerRef}
      tabIndex={0}
      data-testid="project-canvas-stage-root"
      data-stage-scale={stageScale}
      data-stage-pos-x={stagePos.x}
      data-stage-pos-y={stagePos.y}
      data-project-canvas-react-commit-count={renderCommitCountRef.current}
      data-project-canvas-total-item-count={totalCanvasItemCount}
      data-project-canvas-total-image-item-count={totalCanvasImageItemCount}
      data-project-canvas-visible-item-count={visibleItems.length}
      data-project-canvas-visible-image-item-count={renderSurfaceSummary.imageItems}
      data-project-canvas-image-interaction-overlay-count={interactiveImageOverlayItems.length}
      data-project-canvas-proxy-layer-candidate-count={proxyLayerCandidateItems.length}
      data-project-canvas-placeholder-image-proxy-count={placeholderProxyImageItems.length}
      data-project-canvas-dense-webgl-image-proxy-mode={String(shouldUseDenseWebglImageProxyBudget)}
      data-project-canvas-metrics-snapshot={metricsSnapshotText}
      data-project-canvas-thumbnail-cache-count={thumbnailCacheMetrics.thumbnailCount}
      data-project-canvas-thumbnail-cache-hit-count={thumbnailCacheMetrics.cacheHitCount}
      data-project-canvas-thumbnail-cache-generated-count={thumbnailCacheMetrics.generatedCount}
      data-project-canvas-thumbnail-cache-stale-count={thumbnailCacheMetrics.staleCount}
      data-project-canvas-render-surface-summary={JSON.stringify(renderSurfaceSummary)}
      data-project-canvas-webgl-primary-image-count={renderSurfaceSummary.webglImageItems}
      data-project-canvas-high-res-dom-image-count={highResolutionDomImagePreviewItems.length}
      data-project-canvas-new-result-hint-count={newResultHintItems.length}
      data-project-canvas-budget-downgraded-image-count={
        renderSurfaceSummary.budgetDowngradedImageItems
      }
      data-project-canvas-fallback-image-count={renderSurfaceSummary.fallbackImageItems}
      data-project-canvas-crop-excluded-image-count={renderSurfaceSummary.cropExcludedImageItems}
      data-project-canvas-tool={tool}
      data-project-canvas-cropping-image-id={cropTargetId || ''}
      data-project-canvas-active-crop-image-id={activeRegionSelectionImageItem?.id || ''}
      data-project-canvas-webgl-initialized={String(Boolean(webglMetrics?.isInitialized))}
      data-project-canvas-webgl-loaded-image-count={webglMetrics?.loadedImageCount ?? 0}
      data-project-canvas-webgl-failed-image-count={webglMetrics?.failedImageCount ?? 0}
      data-project-canvas-unloaded-fallback-image-count={fallbackImageSummary.unloadedImageItems}
      data-project-canvas-failed-fallback-image-count={fallbackImageSummary.failedImageItems}
      data-project-canvas-unsupported-fallback-image-count={
        fallbackImageSummary.unsupportedImageItems
      }
      data-project-canvas-webgl-pending-image-count={webglMetrics?.pendingImageCount ?? 0}
      data-project-canvas-webgl-sprite-count={webglMetrics?.spriteCount ?? 0}
      data-project-canvas-webgl-resident-image-count={webglResidentImageCount}
      data-project-canvas-webgl-resident-candidate-image-count={
        webglMetrics?.residentCandidateImageCount ?? 0
      }
      data-project-canvas-webgl-viewport-culled-image-count={
        webglMetrics?.viewportCulledImageCount ?? 0
      }
      data-project-canvas-webgl-using-preview-image-count={
        webglMetrics?.usingPreviewImageCount ?? 0
      }
      data-project-canvas-webgl-using-source-image-count={webglMetrics?.usingSourceImageCount ?? 0}
      data-project-canvas-webgl-thumbnail-preview-image-count={
        webglMetrics?.thumbnailPreviewImageCount ?? 0
      }
      data-project-canvas-webgl-placeholder-image-count={webglMetrics?.placeholderImageCount ?? 0}
      data-project-canvas-webgl-source-upgrade-suppressed-image-count={
        webglMetrics?.sourceUpgradeSuppressedImageCount ?? 0
      }
      data-project-canvas-webgl-source-upgradeable-preview-image-count={
        webglMetrics?.sourceUpgradeablePreviewImageCount ?? 0
      }
      data-project-canvas-webgl-source-upgrade-pending-image-count={
        webglMetrics?.sourceUpgradePendingImageCount ?? 0
      }
      data-project-canvas-webgl-source-upgrade-failed-image-count={
        webglMetrics?.sourceUpgradeFailedImageCount ?? 0
      }
      data-project-canvas-webgl-missing-image-count={webglMetrics?.missingImageCount ?? 0}
      data-project-canvas-webgl-resident-limit={PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT}
      data-project-canvas-webgl-resident-remaining-capacity={webglResidentRemainingCapacity}
      data-project-canvas-webgl-resident-texture-bytes={webglResidentTextureBytes}
      data-project-canvas-webgl-resident-texture-budget-bytes={webglResidentTextureBudgetBytes}
      data-project-canvas-webgl-resident-texture-remaining-bytes={
        webglResidentTextureRemainingBytes
      }
      data-project-canvas-webgl-resident-candidate-texture-bytes={
        webglResidentCandidateTextureBytes
      }
      data-project-canvas-webgl-resident-budget-state={webglResidentBudgetState}
      data-project-canvas-webgl-render-count={webglMetrics?.renderCount ?? 0}
      data-project-canvas-webgl-last-render-duration-ms={
        webglMetrics?.lastRenderDurationMs != null ? String(webglMetrics.lastRenderDurationMs) : ''
      }
      data-project-canvas-webgl-last-update-reason={webglMetrics?.lastUpdateReason || ''}
      sx={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        zIndex: 0,
        overflow: 'hidden',
        cursor: cursorStyle,
        ...(shouldForceShapeCreationCrosshair && {
          '&, & *': {
            cursor: 'crosshair !important'
          }
        }),
        outline: 'none',
        backgroundColor: bgColor === 'transparent' ? undefined : bgColor,
        ...(bgColor === 'transparent' && {
          backgroundImage: transparentPattern,
          backgroundSize: '20px 20px'
        }),
        '&[data-project-canvas-marquee-active="true"] [data-project-canvas-image-interaction-layer="dom"]':
          {
            pointerEvents: 'none'
          },
        '&[data-project-canvas-marquee-active="true"] [data-project-canvas-proxy-layer="dom"]': {
          pointerEvents: 'none'
        },
        '&[data-project-canvas-marquee-active="true"] [data-project-canvas-high-res-image-layer="dom"]':
          {
            pointerEvents: 'none'
          },
        '&[data-project-canvas-marquee-active="true"] [data-canvas-overlay="image-interaction"], &[data-project-canvas-marquee-active="true"] [data-canvas-overlay="rect-interaction"]':
          {
            pointerEvents: 'none !important',
            outline: 'none !important',
            boxShadow: 'none !important'
          },
        '&[data-project-canvas-marquee-active="true"] [data-canvas-image-handle], &[data-project-canvas-marquee-active="true"] [data-canvas-image-rotate-hotspot], &[data-project-canvas-marquee-active="true"] [data-canvas-rect-handle], &[data-project-canvas-marquee-active="true"] [data-canvas-rect-rotate-hotspot]':
          {
            display: 'none'
          },
        '&[data-project-canvas-marquee-active="true"] [data-project-canvas-multi-selection-transform-overlay="true"]':
          {
            display: 'none'
          }
      }}
      onMouseDownCapture={handleStageRootMouseDownCapture}
      onMouseMoveCapture={handleStageRootMouseMoveCapture}
      onMouseUpCapture={handleStageRootMouseUpCapture}
      onFocus={() => {
        if (canvasActiveRef) {
          canvasActiveRef.current = true
        }
      }}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null
        if (!nextTarget) return

        if (canvasActiveRef && !event.currentTarget.contains(nextTarget)) {
          canvasActiveRef.current = false
        }
      }}
      onDropCapture={handleDrop}
      onDragOverCapture={handleDragOver}
    >
      <MaxSizeLayout onResize={handleResize}>
        <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
          <ProjectCanvasPageSceneGrid
            showGrid={showGrid}
            stagePos={stagePos}
            stageScale={stageScale}
            stageSize={stageSize}
            gridColor={gridColor}
            registerViewportCallback={registerViewportCallback}
          />
          <ProjectCanvasWebGLImageLayer
            ref={webglImageLayerRef}
            items={webglImageItems}
            selectedIds={selectedIds}
            stagePos={stagePos}
            stageScale={stageScale}
            stageSize={stageSize}
            isViewportInteracting={isViewportInteracting}
            onReadyChange={setWebglImageLayerReady}
            onResidentIdsChange={handleWebglResidentIdsChange}
            onResolvedIdsChange={handleWebglResolvedIdsChange}
            onFailedIdsChange={handleWebglFailedIdsChange}
            onMetricsChange={handleWebglMetricsChange}
          />
          {highResolutionDomImagePreviewItems.length > 0 && (
            <Box
              data-project-canvas-high-res-image-layer="dom"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none'
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                {highResolutionDomImagePreviewItems.map((imageItem) => (
                  <Box
                    key={imageItem.id}
                    data-project-canvas-high-res-image-item-id={imageItem.id}
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: imageItem.width,
                      height: imageItem.height,
                      overflow: 'hidden',
                      transform: buildCanvasImageDomTransform(imageItem),
                      transformOrigin: '0 0',
                      pointerEvents: 'none',
                      zIndex: imageItem.zIndex
                    }}
                  >
                    <CanvasImageDomPreview
                      item={imageItem}
                      previewMode="high-res-source"
                      borderRadius="4px"
                      stageScale={stageScale}
                      sourceImagePreview
                    />
                  </Box>
                ))}
              </div>
            </Box>
          )}
          {newResultHintItems.length > 0 && (
            <Box
              data-project-canvas-new-result-hint-layer="dom"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none'
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                {newResultHintItems.map((imageItem) => (
                  <CanvasNewResultHintOverlay
                    key={imageItem.id}
                    item={imageItem}
                    stageScale={stageScale}
                  />
                ))}
              </div>
            </Box>
          )}
          <Box
            data-project-canvas-stage-event-layer="dom"
            sx={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'auto'
            }}
            onMouseDown={handleStageSurfaceMouseDown}
            onMouseMove={handleStageSurfaceMouseMove}
            onMouseUp={handleStageSurfaceMouseUp}
            onMouseLeave={handleStageSurfaceMouseUp}
          />
          {hasProxyLayerElements && (
            <Box
              data-project-canvas-proxy-layer="dom"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none'
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                {proxyLayerElements}
              </div>
            </Box>
          )}
          {activeRegionSelectionImageItem && (
            <ProjectCanvasImageCropOverlay
              ref={cropOverlayRef}
              item={activeRegionSelectionImageItem}
              stagePos={stagePos}
              stageScale={stageScale}
              stagePosRef={stagePosRef}
              stageScaleRef={stageScaleRef}
              registerViewportLayer={registerViewportLayer}
              onConfirm={(updates) => {
                if (tool === 'extract-select') {
                  handleExtractConfirm(activeRegionSelectionImageItem, updates)
                  return
                }

                handleCropConfirm(activeRegionSelectionImageItem, updates)
              }}
              onCancel={tool === 'extract-select' ? handleExtractCancel : handleCropCancel}
            />
          )}
          {shouldRenderImageInteractionLayer && (
            <Box
              data-project-canvas-image-interaction-layer="dom"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none'
              }}
            >
              {interactiveImageOverlayItems.map((imageItem) => {
                const isSelected = selectedIds.has(imageItem.id) && tool === 'select'
                const imageRuntimeRoute = getImageRuntimeRoute(imageItem)
                const suppressDomImagePreview = imageRuntimeRoute === 'webgl-primary'
                const shouldShowSelectionChrome = isSelected && !shouldSuppressSelectionChrome

                return (
                  <Box
                    key={imageItem.id}
                    data-project-canvas-image-interaction-item-id={imageItem.id}
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: 0,
                      height: 0,
                      overflow: 'visible',
                      transformOrigin: '0 0',
                      willChange: 'transform',
                      pointerEvents: 'none',
                      zIndex: imageItem.zIndex
                    }}
                    ref={registerViewportLayer}
                  >
                    <ProjectCanvasImageInteractionOverlay
                      canvasContainerRef={canvasContainerRef}
                      item={imageItem}
                      isSelected={shouldShowSelectionChrome}
                      selectedCount={selectedIds.size}
                      renderMode={imageRuntimeRoute}
                      suppressImagePreview={suppressDomImagePreview}
                      preferDomImagePreview={false}
                      showTransformer={
                        tool === 'select' &&
                        selectedIds.size === 1 &&
                        isSelected &&
                        !shouldSuppressSelectionChrome
                      }
                      isDraggable={
                        tool === 'select' && !imageItem.locked && !shouldSuppressSelectionChrome
                      }
                      allowPointerPassthrough={tool === 'hand' || shouldSuppressSelectionChrome}
                      stagePos={stagePos}
                      stageScale={stageScale}
                      stagePosRef={stagePosRef}
                      stageScaleRef={stageScaleRef}
                      onPreviewChange={tool === 'select' ? syncWebGLImagePreview : undefined}
                      broadcastDomPreviewSync={domPreviewSyncParentIdSet.has(imageItem.id)}
                      onSelect={(additiveSelection) => {
                        selectItem(imageItem.id, false, Boolean(additiveSelection))
                      }}
                      onDragEnd={handleDragEnd}
                      onTransformEnd={handleTransformEnd}
                      onContextMenu={(event) => handleImageContextMenu(event, imageItem)}
                    />
                  </Box>
                )
              })}
            </Box>
          )}
          {selectedSinglePlaceholderItem && selectedSinglePlaceholderOverlayItem && (
            <Box
              data-project-canvas-rect-interaction-layer="dom-placeholder"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex: selectedSinglePlaceholderOverlayItem.zIndex
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                <ProjectCanvasRectItemInteractionOverlay
                  canvasContainerRef={canvasContainerRef}
                  item={selectedSinglePlaceholderOverlayItem}
                  isSelected
                  showTransformer={!selectedSinglePlaceholderItem.locked}
                  isDraggable={!selectedSinglePlaceholderItem.locked}
                  lockCornerAspectRatio={false}
                  stagePos={stagePos}
                  stageScale={stageScale}
                  stagePosRef={stagePosRef}
                  stageScaleRef={stageScaleRef}
                  overlayRole="placeholder-interaction"
                  floatingToolbarSelector={
                    selectedSinglePlaceholderItem.type === 'model3d' ||
                    selectedSinglePlaceholderItem.type === 'video'
                      ? '.blob-item-action-toolbar'
                      : undefined
                  }
                  allowPointerPassthrough={tool === 'hand'}
                  contentPointerPassthrough={selectedSinglePlaceholderItem.type === 'video'}
                  contentDragSurfaceInset={
                    selectedSinglePlaceholderItem.type === 'video'
                      ? {
                          bottom: Math.min(
                            VIDEO_CONTROL_STRIP_MAX_HEIGHT,
                            Math.max(
                              VIDEO_CONTROL_STRIP_MIN_HEIGHT,
                              Math.round(
                                selectedSinglePlaceholderItem.height *
                                  VIDEO_CONTROL_STRIP_HEIGHT_RATIO
                              )
                            )
                          )
                        }
                      : undefined
                  }
                  onPreviewChange={handlePlaceholderRectOverlayPreviewChange}
                  onSelect={(additiveSelection) => {
                    selectItem(selectedSinglePlaceholderItem.id, false, Boolean(additiveSelection))
                  }}
                  onDragEnd={handlePlaceholderRectOverlayDragEnd}
                  onTransformEnd={handlePlaceholderRectOverlayTransformEnd}
                  onDoubleClick={
                    selectedSinglePlaceholderItem.type === 'model3d'
                      ? () => handleOpenModel3DViewer(selectedSinglePlaceholderItem.id)
                      : undefined
                  }
                  onContextMenu={(event) =>
                    handleImageContextMenu(event, selectedSinglePlaceholderItem)
                  }
                />
              </div>
            </Box>
          )}
          {selectedSingleFileItem && (
            <Box
              data-project-canvas-rect-interaction-layer="dom-file"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex: selectedSingleFileItem.zIndex
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                <ProjectCanvasRectItemInteractionOverlay
                  canvasContainerRef={canvasContainerRef}
                  item={selectedSingleFileItem}
                  isSelected
                  showTransformer={!selectedSingleFileItem.locked}
                  isDraggable={!selectedSingleFileItem.locked}
                  stagePos={stagePos}
                  stageScale={stageScale}
                  stagePosRef={stagePosRef}
                  stageScaleRef={stageScaleRef}
                  minWidth={220}
                  minHeight={140}
                  overlayRole="file-interaction"
                  allowPointerPassthrough={tool === 'hand'}
                  onPreviewChange={(itemId) => {
                    dispatchCanvasLiveVisualBoundsChange([itemId])
                  }}
                  onSelect={(additiveSelection) => {
                    selectItem(selectedSingleFileItem.id, false, Boolean(additiveSelection))
                  }}
                  onDragEnd={handleDragEnd}
                  onTransformEnd={(id, attrs) => {
                    handleTransformEnd(id, {
                      x: attrs.x,
                      y: attrs.y,
                      width: Math.max(220, selectedSingleFileItem.width * Math.abs(attrs.scaleX)),
                      height: Math.max(140, selectedSingleFileItem.height * Math.abs(attrs.scaleY)),
                      rotation: attrs.rotation
                    })
                  }}
                  onDoubleClick={() => handleOpenFileDialog(selectedSingleFileItem.id)}
                  onContextMenu={(event) => handleImageContextMenu(event, selectedSingleFileItem)}
                />
              </div>
            </Box>
          )}
          {selectedSingleTextItem && (
            <Box
              data-project-canvas-rect-interaction-layer="dom-text"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex: selectedSingleTextItem.zIndex
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                <ProjectCanvasRectItemInteractionOverlay
                  canvasContainerRef={canvasContainerRef}
                  item={selectedSingleTextItem}
                  isSelected
                  showTransformer={!selectedSingleTextItem.locked}
                  isDraggable={!selectedSingleTextItem.locked}
                  stagePos={stagePos}
                  stageScale={stageScale}
                  stagePosRef={stagePosRef}
                  stageScaleRef={stageScaleRef}
                  minWidth={CANVAS_TEXT_TRANSFORM_MIN_WIDTH}
                  minHeight={CANVAS_TEXT_TRANSFORM_MIN_HEIGHT}
                  overlayRole="text-interaction"
                  allowPointerPassthrough={tool === 'hand'}
                  previewContent={
                    <CanvasTextOverlayFrame
                      item={selectedSingleTextItem}
                      shouldShowSelectionOutline={false}
                    >
                      <CanvasTextOverlayContent item={selectedSingleTextItem} />
                    </CanvasTextOverlayFrame>
                  }
                  onPreviewChange={(_itemId, preview, handle) => {
                    handleSelectedTextOverlayPreviewChange(selectedSingleTextItem, preview, handle)
                  }}
                  onSelect={(additiveSelection) => {
                    selectItem(selectedSingleTextItem.id, false, Boolean(additiveSelection))
                  }}
                  onDragEnd={handleSelectedTextOverlayDragEnd}
                  onTransformEnd={(id, attrs, handle) => {
                    handleTransformEnd(
                      id,
                      getCanvasTextTransformCommit(selectedSingleTextItem, attrs, handle)
                    )
                  }}
                  onDoubleClick={() => openCanvasTextInlineEditor(selectedSingleTextItem)}
                  onContextMenu={(event) => handleImageContextMenu(event, selectedSingleTextItem)}
                />
              </div>
            </Box>
          )}
          {selectedSingleAnnotationItem && (
            <Box
              data-project-canvas-rect-interaction-layer="dom-annotation"
              sx={{
                position: 'absolute',
                inset: 0,
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex:
                  selectedSingleAnnotationOverlayItem?.zIndex ?? selectedSingleAnnotationItem.zIndex
              }}
            >
              <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
                <ProjectCanvasRectItemInteractionOverlay
                  canvasContainerRef={canvasContainerRef}
                  item={selectedSingleAnnotationOverlayItem ?? selectedSingleAnnotationItem}
                  isSelected
                  showTransformer={!selectedSingleAnnotationItem.locked}
                  isDraggable={!selectedSingleAnnotationItem.locked}
                  stagePos={stagePos}
                  stageScale={stageScale}
                  stagePosRef={stagePosRef}
                  stageScaleRef={stageScaleRef}
                  minWidth={CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE}
                  minHeight={CANVAS_ANNOTATION_TRANSFORM_MIN_SIZE}
                  overlayRole="annotation-interaction"
                  allowPointerPassthrough={tool === 'hand'}
                  onPreviewChange={(_itemId, preview, handle) => {
                    handleSelectedAnnotationOverlayPreviewChange(
                      selectedSingleAnnotationItem,
                      selectedSingleAnnotationOverlayItem,
                      preview,
                      handle
                    )
                  }}
                  onSelect={(additiveSelection) => {
                    selectItem(selectedSingleAnnotationItem.id, true, Boolean(additiveSelection))
                  }}
                  onDragEnd={handleAnnotationRectOverlayDragEnd}
                  onTransformEnd={(id, attrs, handle) => {
                    handleTransformEnd(
                      id,
                      getCanvasAnnotationTransformCommit(
                        selectedSingleAnnotationItem,
                        attrs,
                        handle
                      )
                    )
                  }}
                  onDoubleClick={() => {
                    setSelectedIds(new Set())
                    if (selectedSingleAnnotationItem.shape === 'text-anno') {
                      const absW = Math.max(
                        10,
                        (selectedSingleAnnotationItem.width || 150) *
                          Math.abs(selectedSingleAnnotationItem.scaleX)
                      )
                      const absH = Math.max(
                        10,
                        (selectedSingleAnnotationItem.height || 40) *
                          Math.abs(selectedSingleAnnotationItem.scaleY)
                      )
                      const sy = selectedSingleAnnotationItem.scaleY
                      setInlineTextEdit({
                        id: selectedSingleAnnotationItem.id,
                        x: selectedSingleAnnotationItem.x,
                        y: selectedSingleAnnotationItem.y,
                        w: absW,
                        h: absH,
                        text: selectedSingleAnnotationItem.text || '',
                        isNew: false,
                        fontSize: (selectedSingleAnnotationItem.fontSize || 36) * Math.abs(sy),
                        attachedToId: (selectedSingleAnnotationItem as AttachedCaptionAnnotation)
                          .attachedToId,
                        attachmentPlacement: (
                          selectedSingleAnnotationItem as AttachedCaptionAnnotation
                        ).attachmentPlacement
                      })
                    } else {
                      setLabelDialogItemId(selectedSingleAnnotationItem.id)
                      setLabelDialogText(selectedSingleAnnotationItem.label)
                      setLabelDialogOpen(true)
                    }
                  }}
                  onContextMenu={(event) =>
                    handleImageContextMenu(event, selectedSingleAnnotationItem)
                  }
                />
              </div>
            </Box>
          )}
          {tool === 'select' &&
            !isViewportInteracting &&
            !suppressSelectionChromeAfterMarquee &&
            multiSelectionTransformItems.length > 1 && (
              <ProjectCanvasMultiSelectionTransformOverlay
                canvasContainerRef={canvasContainerRef}
                items={multiSelectionTransformItems}
                livePreviewSyncItemIds={multiSelectionLivePreviewSyncItemIds}
                onPreviewBoundsChange={onLiveMultiSelectionBoundsChange}
                registerViewportCallback={registerViewportCallback}
                stagePos={stagePos}
                stagePosRef={stagePosRef}
                stageScale={stageScale}
                stageScaleRef={stageScaleRef}
                onTransformEnd={(updates) => {
                  setItemsWithHistory((prev: CanvasItem[]) =>
                    prev.map((item) => {
                      const update = updates.find((candidate) => candidate.id === item.id)
                      return update ? ({ ...item, ...update.attrs } as CanvasItem) : item
                    })
                  )
                }}
              />
            )}
          {!isViewportInteracting && (
            <ProjectCanvasPageSceneOverlay
              annotationColor={annotationColor}
              annotationFillOpacity={annotationFillOpacity}
              drawingState={drawingState}
              exactSelectedGroup={exactSelectedGroup}
              isFillableShape={isFillableShape}
              onSelectionRectElementsChange={onSelectionRectElementsChange}
              selectionOverlayGroups={liveSelectionOverlayGroups}
              selectionRect={selectionRect}
              selectionRectRenderMode={selectionRectRenderMode}
              stagePos={stagePos}
              stageScale={stageScale}
              tool={tool}
            />
          )}
        </Box>
      </MaxSizeLayout>
    </Box>
  )
}
