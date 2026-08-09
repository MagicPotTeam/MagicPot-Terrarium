import type { CanvasImageSourceIdentity } from './canvasThumbnailTypes'

export const CANVAS_SPATIAL_TILE_DESCRIPTOR_VERSION = 1 as const
export const CANVAS_SPATIAL_TILE_DEFAULT_SIZE = 512 as const
export const CANVAS_SPATIAL_TILE_DEFAULT_GUTTER = 2 as const

export type CanvasSpatialTileRect = { x: number; y: number; width: number; height: number }

export type CanvasSpatialTileLevel = {
  level: number
  scaleDenominator: number
  levelWidth: number
  levelHeight: number
  cols: number
  rows: number
}

export type CanvasSpatialTileDescriptor = {
  version: 1
  kind: 'spatial-tile-descriptor'
  sourceIdentity: CanvasImageSourceIdentity
  sourceWidth: number
  sourceHeight: number
  tileSize: number
  gutter: number
  levels: CanvasSpatialTileLevel[]
}

export type CanvasSpatialTileAddress = { level: number; x: number; y: number }

export type CanvasSpatialTileGeometry = {
  levelRect: CanvasSpatialTileRect
  decodeRect: CanvasSpatialTileRect
  originalSourceRect: CanvasSpatialTileRect
  contentOffset: { x: number; y: number }
}

export type CanvasSpatialVisibleTile = {
  key: string
  address: CanvasSpatialTileAddress
  geometry: CanvasSpatialTileGeometry
}

export type CanvasSpatialTileViewport = CanvasSpatialTileRect

function positiveInteger(value: number, name: string): number {
  const normalized = Math.floor(value)
  if (!Number.isFinite(normalized) || normalized <= 0)
    throw new Error(`${name} must be a positive integer.`)
  return normalized
}

function nonNegativeInteger(value: number, name: string): number {
  const normalized = Math.floor(value)
  if (!Number.isFinite(normalized) || normalized < 0)
    throw new Error(`${name} must be a non-negative integer.`)
  return normalized
}

export function getCanvasSpatialTileScaleDenominator(level: number): number {
  return 2 ** nonNegativeInteger(level, 'level')
}

export function buildCanvasSpatialTileLevel(input: {
  sourceWidth: number
  sourceHeight: number
  level: number
  tileSize: number
}): CanvasSpatialTileLevel {
  const sourceWidth = positiveInteger(input.sourceWidth, 'sourceWidth')
  const sourceHeight = positiveInteger(input.sourceHeight, 'sourceHeight')
  const tileSize = positiveInteger(input.tileSize, 'tileSize')
  const level = nonNegativeInteger(input.level, 'level')
  const scaleDenominator = getCanvasSpatialTileScaleDenominator(level)
  const levelWidth = Math.max(1, Math.ceil(sourceWidth / scaleDenominator))
  const levelHeight = Math.max(1, Math.ceil(sourceHeight / scaleDenominator))
  return {
    level,
    scaleDenominator,
    levelWidth,
    levelHeight,
    cols: Math.ceil(levelWidth / tileSize),
    rows: Math.ceil(levelHeight / tileSize)
  }
}

export function createCanvasSpatialTileDescriptor(input: {
  sourceIdentity: CanvasImageSourceIdentity
  sourceWidth: number
  sourceHeight: number
  tileSize?: number
  gutter?: number
  levels: readonly number[]
}): CanvasSpatialTileDescriptor {
  const sourceWidth = positiveInteger(input.sourceWidth, 'sourceWidth')
  const sourceHeight = positiveInteger(input.sourceHeight, 'sourceHeight')
  const tileSize = positiveInteger(input.tileSize ?? CANVAS_SPATIAL_TILE_DEFAULT_SIZE, 'tileSize')
  const gutter = nonNegativeInteger(input.gutter ?? CANVAS_SPATIAL_TILE_DEFAULT_GUTTER, 'gutter')
  const levels = [...new Set(input.levels.map((level) => nonNegativeInteger(level, 'level')))]
    .sort((a, b) => a - b)
    .map((level) => buildCanvasSpatialTileLevel({ sourceWidth, sourceHeight, level, tileSize }))
  if (levels.length === 0) throw new Error('At least one level is required.')
  return {
    version: CANVAS_SPATIAL_TILE_DESCRIPTOR_VERSION,
    kind: 'spatial-tile-descriptor',
    sourceIdentity: input.sourceIdentity,
    sourceWidth,
    sourceHeight,
    tileSize,
    gutter,
    levels
  }
}

function getLevel(descriptor: CanvasSpatialTileDescriptor, level: number): CanvasSpatialTileLevel {
  const found = descriptor.levels.find((candidate) => candidate.level === level)
  if (!found) throw new Error(`Level ${level} is not present in the descriptor.`)
  return found
}

export function buildCanvasSpatialTileKey(
  descriptor: CanvasSpatialTileDescriptor,
  address: CanvasSpatialTileAddress
): string {
  const level = getLevel(descriptor, address.level)
  const x = nonNegativeInteger(address.x, 'x')
  const y = nonNegativeInteger(address.y, 'y')
  if (x >= level.cols || y >= level.rows) throw new Error('Tile address is outside the level grid.')
  return `spatial-tile:v${descriptor.version}:${descriptor.sourceIdentity.version}:${descriptor.sourceIdentity.kind}:${descriptor.sourceIdentity.cacheKey}:${level.level}:${x}:${y}:${descriptor.tileSize}:${descriptor.gutter}`
}

export function getCanvasSpatialTileGeometry(
  descriptor: CanvasSpatialTileDescriptor,
  address: CanvasSpatialTileAddress
): CanvasSpatialTileGeometry {
  const level = getLevel(descriptor, address.level)
  const x = nonNegativeInteger(address.x, 'x')
  const y = nonNegativeInteger(address.y, 'y')
  if (x >= level.cols || y >= level.rows) throw new Error('Tile address is outside the level grid.')
  const levelX = x * descriptor.tileSize
  const levelY = y * descriptor.tileSize
  const levelRect = {
    x: levelX,
    y: levelY,
    width: Math.min(descriptor.tileSize, level.levelWidth - levelX),
    height: Math.min(descriptor.tileSize, level.levelHeight - levelY)
  }
  const decodeX = Math.max(0, levelX - descriptor.gutter)
  const decodeY = Math.max(0, levelY - descriptor.gutter)
  const decodeRight = Math.min(level.levelWidth, levelX + levelRect.width + descriptor.gutter)
  const decodeBottom = Math.min(level.levelHeight, levelY + levelRect.height + descriptor.gutter)
  return {
    levelRect,
    decodeRect: {
      x: decodeX,
      y: decodeY,
      width: decodeRight - decodeX,
      height: decodeBottom - decodeY
    },
    originalSourceRect: {
      x: levelX * level.scaleDenominator,
      y: levelY * level.scaleDenominator,
      width: Math.min(
        descriptor.sourceWidth - levelX * level.scaleDenominator,
        levelRect.width * level.scaleDenominator
      ),
      height: Math.min(
        descriptor.sourceHeight - levelY * level.scaleDenominator,
        levelRect.height * level.scaleDenominator
      )
    },
    contentOffset: { x: levelX - decodeX, y: levelY - decodeY }
  }
}

export function listCanvasSpatialVisibleTiles(input: {
  descriptor: CanvasSpatialTileDescriptor
  level: number
  viewport: CanvasSpatialTileViewport
  overscanTiles?: number
}): CanvasSpatialVisibleTile[] {
  const level = getLevel(input.descriptor, input.level)
  const overscan = nonNegativeInteger(input.overscanTiles ?? 0, 'overscanTiles')
  if (input.viewport.width <= 0 || input.viewport.height <= 0) return []
  const scale = level.scaleDenominator
  const x0 = Math.max(
    0,
    Math.floor(input.viewport.x / scale / input.descriptor.tileSize) - overscan
  )
  const y0 = Math.max(
    0,
    Math.floor(input.viewport.y / scale / input.descriptor.tileSize) - overscan
  )
  const x1 = Math.min(
    level.cols - 1,
    Math.ceil((input.viewport.x + input.viewport.width) / scale / input.descriptor.tileSize) -
      1 +
      overscan
  )
  const y1 = Math.min(
    level.rows - 1,
    Math.ceil((input.viewport.y + input.viewport.height) / scale / input.descriptor.tileSize) -
      1 +
      overscan
  )
  const result: CanvasSpatialVisibleTile[] = []
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      const address = { level: input.level, x, y }
      result.push({
        key: buildCanvasSpatialTileKey(input.descriptor, address),
        address,
        geometry: getCanvasSpatialTileGeometry(input.descriptor, address)
      })
    }
  return result
}
