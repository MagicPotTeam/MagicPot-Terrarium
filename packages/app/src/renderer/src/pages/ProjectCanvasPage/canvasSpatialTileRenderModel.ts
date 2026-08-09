import type {
  ProjectCanvasInteractionProxy,
  ProjectCanvasRenderableTransform
} from './projectCanvasRenderBoundary'
import type { CanvasSpatialTileGeometry, CanvasSpatialTileRect } from './canvasSpatialTileTypes'

export type CanvasSpatialTileRenderMode = 'single-sprite' | 'tiles'

export type CanvasSpatialTileRenderInput = {
  mode: CanvasSpatialTileRenderMode
  itemId: string
  zIndex: number
  interactionProxy: ProjectCanvasInteractionProxy
  transform: ProjectCanvasRenderableTransform
  sourceWidth: number
  sourceHeight: number
  crop?: CanvasSpatialTileRect
  tileKey: string
  geometry: CanvasSpatialTileGeometry
}

export type CanvasSpatialTileTextureFrame = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasSpatialTileTextureUv = {
  u0: number
  v0: number
  u1: number
  v1: number
}

export type CanvasSpatialTileContainerTransform = {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

export type CanvasSpatialTileRenderModel = {
  kind: 'spatial-tile'
  itemId: string
  tileKey: string
  geometryKey: string
  transformKey: string
  zIndex: number
  interactionProxy: ProjectCanvasInteractionProxy
  containerTransform: CanvasSpatialTileContainerTransform
  child: {
    position: { x: number; y: number }
    size: { width: number; height: number }
  }
  texture: {
    contentFrame: CanvasSpatialTileTextureFrame
    uv: CanvasSpatialTileTextureUv
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function intersectRects(left: CanvasSpatialTileRect, right: CanvasSpatialTileRect) {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const rightEdge = Math.min(left.x + left.width, right.x + right.width)
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height)
  if (rightEdge <= x || bottomEdge <= y) return null
  return { x, y, width: rightEdge - x, height: bottomEdge - y }
}

function getSourceToLevelScale(geometry: CanvasSpatialTileGeometry) {
  return {
    x:
      geometry.levelRect.width > 0
        ? geometry.originalSourceRect.width / geometry.levelRect.width
        : 1,
    y:
      geometry.levelRect.height > 0
        ? geometry.originalSourceRect.height / geometry.levelRect.height
        : 1
  }
}

function getRectKey(rect: CanvasSpatialTileRect | undefined) {
  return rect ? [rect.x, rect.y, rect.width, rect.height].join(',') : 'full'
}

function getTransformKey(transform: ProjectCanvasRenderableTransform, crop: CanvasSpatialTileRect) {
  return [
    transform.x,
    transform.y,
    transform.width,
    transform.height,
    transform.scaleX,
    transform.scaleY,
    transform.rotation,
    getRectKey(crop)
  ].join('|')
}

function getGeometryKey(
  geometry: CanvasSpatialTileGeometry,
  tileSourceRect: CanvasSpatialTileRect,
  crop: CanvasSpatialTileRect
) {
  return [
    getRectKey(geometry.originalSourceRect),
    getRectKey(geometry.decodeRect),
    geometry.contentOffset.x,
    geometry.contentOffset.y,
    getRectKey(tileSourceRect),
    getRectKey(crop)
  ].join('|')
}

export function buildCanvasSpatialTileRenderModel(
  input: CanvasSpatialTileRenderInput
): CanvasSpatialTileRenderModel | null {
  if (input.mode !== 'tiles') return null
  if (
    !isPositiveFinite(input.sourceWidth) ||
    !isPositiveFinite(input.sourceHeight) ||
    !isPositiveFinite(input.transform.width) ||
    !isPositiveFinite(input.transform.height)
  )
    return null

  const sourceBounds = { x: 0, y: 0, width: input.sourceWidth, height: input.sourceHeight }
  const crop = input.crop === undefined ? sourceBounds : intersectRects(input.crop, sourceBounds)
  if (!crop) return null

  const tileSourceRect = intersectRects(input.geometry.originalSourceRect, crop)
  if (!tileSourceRect) return null

  const scale = getSourceToLevelScale(input.geometry)
  const frameX =
    input.geometry.contentOffset.x +
    (tileSourceRect.x - input.geometry.originalSourceRect.x) / scale.x
  const frameY =
    input.geometry.contentOffset.y +
    (tileSourceRect.y - input.geometry.originalSourceRect.y) / scale.y
  const frameWidth = tileSourceRect.width / scale.x
  const frameHeight = tileSourceRect.height / scale.y
  const decodeWidth = input.geometry.decodeRect.width
  const decodeHeight = input.geometry.decodeRect.height

  if (
    !isPositiveFinite(scale.x) ||
    !isPositiveFinite(scale.y) ||
    !isPositiveFinite(frameWidth) ||
    !isPositiveFinite(frameHeight) ||
    !isPositiveFinite(decodeWidth) ||
    !isPositiveFinite(decodeHeight)
  )
    return null

  return {
    kind: 'spatial-tile',
    itemId: input.itemId,
    tileKey: input.tileKey,
    geometryKey: getGeometryKey(input.geometry, tileSourceRect, crop),
    transformKey: getTransformKey(input.transform, crop),
    zIndex: input.zIndex,
    interactionProxy: input.interactionProxy,
    containerTransform: {
      x: input.transform.x,
      y: input.transform.y,
      rotation: input.transform.rotation,
      scaleX: (input.transform.width / crop.width) * input.transform.scaleX,
      scaleY: (input.transform.height / crop.height) * input.transform.scaleY
    },
    child: {
      position: { x: tileSourceRect.x - crop.x, y: tileSourceRect.y - crop.y },
      size: { width: tileSourceRect.width, height: tileSourceRect.height }
    },
    texture: {
      contentFrame: { x: frameX, y: frameY, width: frameWidth, height: frameHeight },
      uv: {
        u0: frameX / decodeWidth,
        v0: frameY / decodeHeight,
        u1: (frameX + frameWidth) / decodeWidth,
        v1: (frameY + frameHeight) / decodeHeight
      }
    }
  }
}
