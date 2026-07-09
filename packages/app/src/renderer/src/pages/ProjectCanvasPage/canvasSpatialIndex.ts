import type { CanvasItem } from './types'
import {
  createCanvasSpatialIndexAccelerator,
  getCanvasSpatialIndexAcceleratorReadyVersion,
  shouldAttemptCanvasSpatialIndexAcceleration,
  type CanvasSpatialIndexAccelerator
} from './canvasSpatialIndexAccelerator'

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
  accelerator?: CanvasSpatialIndexAccelerator | null
  acceleratorAttemptVersion?: number
  disposed?: boolean
}

export const CANVAS_SPATIAL_INDEX_CELL_SIZE = 512
export const CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY = 4096
export const CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS = 16384
const CANVAS_SPATIAL_INDEX_BOUNDS_STRIDE = 4

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
    overflowEntryIndexes,
    accelerator: null
  }
}

export function attachCanvasSpatialIndexAccelerator<T>(
  index: CanvasSpatialIndex<T> | null | undefined
): CanvasSpatialIndexAccelerator | null {
  if (!index || index.disposed) {
    return null
  }
  if (index.accelerator) {
    return index.accelerator
  }
  if (!shouldAttemptCanvasSpatialIndexAcceleration(index.entries.length)) {
    return null
  }

  const readyVersion = getCanvasSpatialIndexAcceleratorReadyVersion()
  if (index.acceleratorAttemptVersion === readyVersion) {
    return null
  }
  index.acceleratorAttemptVersion = readyVersion

  const flattenedBounds = new Float64Array(
    index.entries.length * CANVAS_SPATIAL_INDEX_BOUNDS_STRIDE
  )
  index.entries.forEach((entry, entryIndex) => {
    const offset = entryIndex * CANVAS_SPATIAL_INDEX_BOUNDS_STRIDE
    flattenedBounds[offset] = entry.bounds.minX
    flattenedBounds[offset + 1] = entry.bounds.minY
    flattenedBounds[offset + 2] = entry.bounds.maxX
    flattenedBounds[offset + 3] = entry.bounds.maxY
  })

  index.accelerator = createCanvasSpatialIndexAccelerator(flattenedBounds, {
    cellSize: index.cellSize,
    maxIndexedCellsPerEntry: CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY,
    maxQueryCells: CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS
  })
  return index.accelerator ?? null
}

export function disposeCanvasSpatialIndex<T>(
  index: CanvasSpatialIndex<T> | null | undefined
): void {
  if (!index || index.disposed) {
    return
  }
  index.disposed = true
  index.accelerator?.dispose?.()
  index.accelerator = null
}

function discardCanvasSpatialIndexAccelerator<T>(index: CanvasSpatialIndex<T>): void {
  const accelerator = index.accelerator
  if (!accelerator) {
    return
  }
  index.accelerator = null
  accelerator.dispose?.()
}

function queryCanvasSpatialIndexAccelerator<T>(
  index: CanvasSpatialIndex<T>,
  normalizedQueryBounds: CanvasSpatialBounds,
  preserveEntryOrder: boolean
): T[] | null {
  if (index.disposed || !index.accelerator) {
    return null
  }

  try {
    const candidateIndexes = index.accelerator.queryIndexes(normalizedQueryBounds)
    if (!candidateIndexes) {
      return null
    }

    const orderedCandidateIndexes = preserveEntryOrder
      ? Array.from(candidateIndexes).sort((left, right) => left - right)
      : candidateIndexes
    const seenCandidateIndexes = new Set<number>()
    const matches: T[] = []
    for (const entryIndex of orderedCandidateIndexes) {
      if (seenCandidateIndexes.has(entryIndex)) {
        continue
      }
      seenCandidateIndexes.add(entryIndex)

      const entry = index.entries[entryIndex]
      if (!entry) {
        discardCanvasSpatialIndexAccelerator(index)
        return null
      }
      if (doCanvasSpatialBoundsIntersect(entry.bounds, normalizedQueryBounds)) {
        matches.push(entry.item)
      }
    }
    return matches
  } catch {
    discardCanvasSpatialIndexAccelerator(index)
    return null
  }
}

type QueryCanvasSpatialIndexOptions = {
  preserveEntryOrder: boolean
}

function queryCanvasSpatialIndexInternal<T>(
  index: CanvasSpatialIndex<T>,
  queryBounds: CanvasSpatialBounds,
  options: QueryCanvasSpatialIndexOptions
): T[] {
  const normalizedQueryBounds = normalizeCanvasSpatialBounds(queryBounds)
  if (!normalizedQueryBounds) {
    return []
  }

  attachCanvasSpatialIndexAccelerator(index)
  const acceleratorMatches = queryCanvasSpatialIndexAccelerator(
    index,
    normalizedQueryBounds,
    options.preserveEntryOrder
  )
  if (acceleratorMatches) {
    return acceleratorMatches
  }

  const range = getCanvasSpatialCellRange(normalizedQueryBounds, index.cellSize)
  if (!range || range.cellCount > CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS) {
    return index.entries
      .filter((entry) => doCanvasSpatialBoundsIntersect(entry.bounds, normalizedQueryBounds))
      .map((entry) => entry.item)
  }

  if (options.preserveEntryOrder) {
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

  const candidateIndexes: number[] = []
  const seenCandidateIndexes = new Uint8Array(index.entries.length)
  const addCandidateIndex = (entryIndex: number) => {
    if (seenCandidateIndexes[entryIndex] === 1) {
      return
    }
    seenCandidateIndexes[entryIndex] = 1
    candidateIndexes.push(entryIndex)
  }

  for (const entryIndex of index.overflowEntryIndexes) {
    addCandidateIndex(entryIndex)
  }

  forEachCoveredCanvasSpatialCell(normalizedQueryBounds, index.cellSize, (cellX, cellY) => {
    const bucket = index.cells.get(getCanvasSpatialCellKey(cellX, cellY))
    if (!bucket) {
      return
    }

    for (const entryIndex of bucket) {
      addCandidateIndex(entryIndex)
    }
  })

  const matches: T[] = []
  for (const entryIndex of candidateIndexes) {
    const entry = index.entries[entryIndex]
    if (entry && doCanvasSpatialBoundsIntersect(entry.bounds, normalizedQueryBounds)) {
      matches.push(entry.item)
    }
  }

  return matches
}

export function queryCanvasSpatialIndex<T>(
  index: CanvasSpatialIndex<T>,
  queryBounds: CanvasSpatialBounds
): T[] {
  return queryCanvasSpatialIndexInternal(index, queryBounds, { preserveEntryOrder: true })
}

export function queryCanvasSpatialIndexUnordered<T>(
  index: CanvasSpatialIndex<T>,
  queryBounds: CanvasSpatialBounds
): T[] {
  return queryCanvasSpatialIndexInternal(index, queryBounds, { preserveEntryOrder: false })
}

export function queryOwnedCanvasSpatialIndex<T>(
  index: CanvasSpatialIndex<T>,
  queryBounds: CanvasSpatialBounds
): T[] {
  try {
    return queryCanvasSpatialIndex(index, queryBounds)
  } finally {
    disposeCanvasSpatialIndex(index)
  }
}

export function buildCanvasItemSpatialIndex(
  items: readonly CanvasItem[],
  getBounds: (item: CanvasItem) => CanvasSpatialBounds,
  cellSize = CANVAS_SPATIAL_INDEX_CELL_SIZE
) {
  return buildCanvasSpatialIndex(items, getBounds, cellSize)
}
