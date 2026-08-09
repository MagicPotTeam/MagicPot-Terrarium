import type { CanvasImageSourceIdentity } from './canvasThumbnailTypes'
import {
  createCanvasSpatialTileDescriptor,
  getCanvasSpatialTileScaleDenominator,
  listCanvasSpatialVisibleTiles,
  type CanvasSpatialTileDescriptor,
  type CanvasSpatialTileRect,
  type CanvasSpatialVisibleTile
} from './canvasSpatialTileTypes'
import type { CanvasSpatialTileBrowserCropRequest } from './canvasSpatialTileWorkerProtocol'

export const CANVAS_SPATIAL_TILE_MIN_SOURCE_MAX = 8192
export const CANVAS_SPATIAL_TILE_MIN_PROJECTED_MAX = 4096
export const CANVAS_SPATIAL_TILE_MIN_STAGE_SCALE = 0.15

type Point = { x: number; y: number }
export type CanvasSpatialTilePolicyInput = {
  sourceWidth: number
  sourceHeight: number
  crop: CanvasSpatialTileRect
  item: {
    x: number
    y: number
    width: number
    height: number
    scaleX: number
    scaleY: number
    rotation: number
  }
  stageScale: number
  stagePos: Point
  deviceScale: number
  viewport: CanvasSpatialTileRect
  visible: boolean
  sourceIdentity?: CanvasImageSourceIdentity | null
  source?: Blob | null
  overscanTiles?: number
  tileSize?: number
  gutter?: number
  levels?: readonly number[]
}

export type CanvasSpatialTilePolicyDecision = {
  enabled: boolean
  reason:
    | 'eligible'
    | 'source-size'
    | 'projected-size'
    | 'overview-scale'
    | 'not-visible'
    | 'missing-source'
    | 'invalid-transform'
  level: number | null
  scaleDenominator: number | null
  sourceSpaceVisibleRect: CanvasSpatialTileRect | null
  descriptor: CanvasSpatialTileDescriptor | null
  visibleTiles: CanvasSpatialVisibleTile[]
  tasks: Array<
    CanvasSpatialTileBrowserCropRequest & { tileKey: string; priority: 'visible' | 'overscan' }
  >
}

function empty(reason: CanvasSpatialTilePolicyDecision['reason']): CanvasSpatialTilePolicyDecision {
  return {
    enabled: false,
    reason,
    level: null,
    scaleDenominator: null,
    sourceSpaceVisibleRect: null,
    descriptor: null,
    visibleTiles: [],
    tasks: []
  }
}

function intersect(a: CanvasSpatialTileRect, b: CanvasSpatialTileRect): CanvasSpatialTileRect {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function mapCanvasSpatialTileScreenPointToSource(
  point: Point,
  input: Pick<CanvasSpatialTilePolicyInput, 'crop' | 'item' | 'stageScale' | 'stagePos'>
): Point {
  const stagePoint = {
    x: (point.x - input.stagePos.x) / input.stageScale,
    y: (point.y - input.stagePos.y) / input.stageScale
  }
  const dx = stagePoint.x - input.item.x
  const dy = stagePoint.y - input.item.y
  const radians = (input.item.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const rx = cos * dx + sin * dy
  const ry = -sin * dx + cos * dy
  return {
    x: input.crop.x + rx / ((input.item.width / input.crop.width) * input.item.scaleX),
    y: input.crop.y + ry / ((input.item.height / input.crop.height) * input.item.scaleY)
  }
}

export function chooseCanvasSpatialTileLevel(input: {
  levels: readonly number[]
  cropWidth: number
  cropHeight: number
  itemWidth: number
  itemHeight: number
  scaleX: number
  scaleY: number
  stageScale: number
  deviceScale: number
}): number {
  if (!input.levels.length) throw new Error('At least one spatial tile level is required.')
  const pixelsPerDevicePixel = Math.max(
    input.cropWidth /
      (input.itemWidth * Math.abs(input.scaleX) * input.stageScale * input.deviceScale),
    input.cropHeight /
      (input.itemHeight * Math.abs(input.scaleY) * input.stageScale * input.deviceScale)
  )
  if (!(pixelsPerDevicePixel > 0) || !Number.isFinite(pixelsPerDevicePixel))
    return Math.min(...input.levels)
  const eligible = input.levels.filter((level) => 2 ** level <= pixelsPerDevicePixel)
  return eligible.length ? Math.max(...eligible) : Math.min(...input.levels)
}

export function buildCanvasSpatialTilePolicy(
  input: CanvasSpatialTilePolicyInput
): CanvasSpatialTilePolicyDecision {
  const invalid =
    !Number.isFinite(input.sourceWidth) ||
    input.sourceWidth <= 0 ||
    !Number.isFinite(input.sourceHeight) ||
    input.sourceHeight <= 0 ||
    !Number.isFinite(input.crop.x) ||
    !Number.isFinite(input.crop.y) ||
    !Number.isFinite(input.crop.width) ||
    input.crop.width <= 0 ||
    !Number.isFinite(input.crop.height) ||
    input.crop.height <= 0 ||
    !Number.isFinite(input.item.x) ||
    !Number.isFinite(input.item.y) ||
    !Number.isFinite(input.item.width) ||
    input.item.width <= 0 ||
    !Number.isFinite(input.item.height) ||
    input.item.height <= 0 ||
    !Number.isFinite(input.item.scaleX) ||
    input.item.scaleX === 0 ||
    !Number.isFinite(input.item.scaleY) ||
    input.item.scaleY === 0 ||
    !Number.isFinite(input.item.rotation) ||
    !Number.isFinite(input.stageScale) ||
    input.stageScale <= 0 ||
    !Number.isFinite(input.stagePos.x) ||
    !Number.isFinite(input.stagePos.y) ||
    !Number.isFinite(input.deviceScale) ||
    input.deviceScale <= 0 ||
    !Number.isFinite(input.viewport.x) ||
    !Number.isFinite(input.viewport.y) ||
    !Number.isFinite(input.viewport.width) ||
    input.viewport.width < 0 ||
    !Number.isFinite(input.viewport.height) ||
    input.viewport.height < 0
  if (invalid) return empty('invalid-transform')
  const sourceMax = Math.max(input.sourceWidth, input.sourceHeight)
  const projectedMax = Math.max(
    input.item.width * Math.abs(input.item.scaleX) * input.stageScale * input.deviceScale,
    input.item.height * Math.abs(input.item.scaleY) * input.stageScale * input.deviceScale
  )
  if (sourceMax < CANVAS_SPATIAL_TILE_MIN_SOURCE_MAX) return empty('source-size')
  if (!(input.stageScale > CANVAS_SPATIAL_TILE_MIN_STAGE_SCALE)) return empty('overview-scale')
  if (projectedMax < CANVAS_SPATIAL_TILE_MIN_PROJECTED_MAX) return empty('projected-size')
  if (!input.visible) return empty('not-visible')
  if (!input.sourceIdentity || !input.source) return empty('missing-source')

  const levels = input.levels ?? [0, 1, 2, 3, 4, 5]
  const level = chooseCanvasSpatialTileLevel({
    levels,
    cropWidth: input.crop.width,
    cropHeight: input.crop.height,
    itemWidth: input.item.width,
    itemHeight: input.item.height,
    scaleX: input.item.scaleX,
    scaleY: input.item.scaleY,
    stageScale: input.stageScale,
    deviceScale: input.deviceScale
  })
  const descriptor = createCanvasSpatialTileDescriptor({
    sourceIdentity: input.sourceIdentity,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    tileSize: input.tileSize,
    gutter: input.gutter,
    levels
  })
  const corners = [
    { x: input.viewport.x, y: input.viewport.y },
    { x: input.viewport.x + input.viewport.width, y: input.viewport.y },
    { x: input.viewport.x, y: input.viewport.y + input.viewport.height },
    { x: input.viewport.x + input.viewport.width, y: input.viewport.y + input.viewport.height }
  ].map((point) => mapCanvasSpatialTileScreenPointToSource(point, input))
  const sourceSpaceVisibleRect = intersect(
    {
      x: Math.min(...corners.map((p) => p.x)),
      y: Math.min(...corners.map((p) => p.y)),
      width: Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x)),
      height: Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y))
    },
    input.crop
  )
  if (sourceSpaceVisibleRect.width <= 0 || sourceSpaceVisibleRect.height <= 0)
    return empty('not-visible')
  const visibleTiles = listCanvasSpatialVisibleTiles({
    descriptor,
    level,
    viewport: sourceSpaceVisibleRect,
    overscanTiles: input.overscanTiles
  })
  const visibleKeys = new Set(
    listCanvasSpatialVisibleTiles({ descriptor, level, viewport: sourceSpaceVisibleRect }).map(
      (tile) => tile.key
    )
  )
  const scaleDenominator = getCanvasSpatialTileScaleDenominator(level)
  const tasks = visibleTiles.map((tile) => ({
    source: input.source!,
    descriptor: { sourceWidth: input.sourceWidth, sourceHeight: input.sourceHeight },
    geometry: tile.geometry,
    scaleDenominator,
    tileKey: tile.key,
    priority: visibleKeys.has(tile.key) ? ('visible' as const) : ('overscan' as const)
  }))
  return {
    enabled: true,
    reason: 'eligible',
    level,
    scaleDenominator,
    sourceSpaceVisibleRect,
    descriptor,
    visibleTiles,
    tasks
  }
}
