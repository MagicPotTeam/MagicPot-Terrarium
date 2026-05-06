import type { CanvasItem } from './types'

export type CanvasSpatialBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type CanvasSpatialIndexEntry<T> = {
  item: T
  bounds: CanvasSpatialBounds
}

export type CanvasSpatialIndex<T> = {
  cellSize: number
  entries: Array<CanvasSpatialIndexEntry<T>>
  cells: Map<string, number[]>
  overflowEntryIndexes: number[]
}

export const CANVAS_SPATIAL_INDEX_CELL_SIZE = 512
export const CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY = 4096
export const CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS = 16384

type CanvasSpatialCellRange = {
  minCellX: number
  maxCellX: number
  minCellY: number
  maxCellY: number
  cellCount: number
}

function getCanvasSpatialCellKey(x: number, y: number) {
  return `${x}:${y}`
}

function normalizeCanvasSpatialBounds(bounds: CanvasSpatialBounds): CanvasSpatialBounds | null {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    return null
  }

  return {
    minX: Math.min(bounds.minX, bounds.maxX),
    minY: Math.min(bounds.minY, bounds.maxY),
    maxX: Math.max(bounds.minX, bounds.maxX),
    maxY: Math.max(bounds.minY, bounds.maxY)
  }
}

function getCanvasSpatialCellRange(
  bounds: CanvasSpatialBounds,
  cellSize: number
): CanvasSpatialCellRange | null {
  const normalizedBounds = normalizeCanvasSpatialBounds(bounds)
  const safeCellSize =
    Number.isFinite(cellSize) && cellSize > 0 ? cellSize : CANVAS_SPATIAL_INDEX_CELL_SIZE
  if (!normalizedBounds) {
    return null
  }

  const minCellX = Math.floor(normalizedBounds.minX / safeCellSize)
  const maxCellX = Math.floor(normalizedBounds.maxX / safeCellSize)
  const minCellY = Math.floor(normalizedBounds.minY / safeCellSize)
  const maxCellY = Math.floor(normalizedBounds.maxY / safeCellSize)
  const columns = maxCellX - minCellX + 1
  const rows = maxCellY - minCellY + 1
  const cellCount = columns * rows
  if (
    !Number.isFinite(minCellX) ||
    !Number.isFinite(maxCellX) ||
    !Number.isFinite(minCellY) ||
    !Number.isFinite(maxCellY) ||
    !Number.isFinite(cellCount) ||
    columns <= 0 ||
    rows <= 0
  ) {
    return null
  }

  return {
    minCellX,
    maxCellX,
    minCellY,
    maxCellY,
    cellCount
  }
}

function forEachCoveredCanvasSpatialCell(
  bounds: CanvasSpatialBounds,
  cellSize: number,
  callback: (cellX: number, cellY: number) => void
) {
  const range = getCanvasSpatialCellRange(bounds, cellSize)
  if (!range) {
    return
  }

  for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
    for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
      callback(cellX, cellY)
    }
  }
}

export function doCanvasSpatialBoundsIntersect(
  left: CanvasSpatialBounds,
  right: CanvasSpatialBounds
) {
  return (
    left.minX < right.maxX &&
    left.maxX > right.minX &&
    left.minY < right.maxY &&
    left.maxY > right.minY
  )
}

export function buildCanvasSpatialIndex<T>(
  items: readonly T[],
  getBounds: (item: T) => CanvasSpatialBounds,
  cellSize = CANVAS_SPATIAL_INDEX_CELL_SIZE
): CanvasSpatialIndex<T> {
  const entries: Array<CanvasSpatialIndexEntry<T>> = []
  const cells = new Map<string, number[]>()
  const overflowEntryIndexes: number[] = []

  items.forEach((item) => {
    const bounds = normalizeCanvasSpatialBounds(getBounds(item))
    if (!bounds) {
      return
    }

    const entryIndex = entries.push({ item, bounds }) - 1
    const range = getCanvasSpatialCellRange(bounds, cellSize)
    if (!range) {
      return
    }

    if (range.cellCount > CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY) {
      overflowEntryIndexes.push(entryIndex)
      return
    }

    forEachCoveredCanvasSpatialCell(bounds, cellSize, (cellX, cellY) => {
      const key = getCanvasSpatialCellKey(cellX, cellY)
      const bucket = cells.get(key)
      if (bucket) {
        bucket.push(entryIndex)
      } else {
        cells.set(key, [entryIndex])
      }
    })
  })

  return {
    cellSize,
    entries,
    cells,
    overflowEntryIndexes
  }
}

export function queryCanvasSpatialIndex<T>(
  index: CanvasSpatialIndex<T>,
  queryBounds: CanvasSpatialBounds
): T[] {
  const normalizedQueryBounds = normalizeCanvasSpatialBounds(queryBounds)
  if (!normalizedQueryBounds) {
    return []
  }

  const range = getCanvasSpatialCellRange(normalizedQueryBounds, index.cellSize)
  if (!range || range.cellCount > CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS) {
    return index.entries
      .filter((entry) => doCanvasSpatialBoundsIntersect(entry.bounds, normalizedQueryBounds))
      .map((entry) => entry.item)
  }

  const candidateIndexes = new Set<number>()

  for (const entryIndex of index.overflowEntryIndexes) {
    candidateIndexes.add(entryIndex)
  }

  forEachCoveredCanvasSpatialCell(normalizedQueryBounds, index.cellSize, (cellX, cellY) => {
    const bucket = index.cells.get(getCanvasSpatialCellKey(cellX, cellY))
    if (!bucket) {
      return
    }

    for (const entryIndex of bucket) {
      candidateIndexes.add(entryIndex)
    }
  })

  const matches: T[] = []
  Array.from(candidateIndexes)
    .sort((left, right) => left - right)
    .forEach((entryIndex) => {
      const entry = index.entries[entryIndex]
      if (entry && doCanvasSpatialBoundsIntersect(entry.bounds, normalizedQueryBounds)) {
        matches.push(entry.item)
      }
    })

  return matches
}

export function buildCanvasItemSpatialIndex(
  items: readonly CanvasItem[],
  getBounds: (item: CanvasItem) => CanvasSpatialBounds,
  cellSize = CANVAS_SPATIAL_INDEX_CELL_SIZE
) {
  return buildCanvasSpatialIndex(items, getBounds, cellSize)
}
