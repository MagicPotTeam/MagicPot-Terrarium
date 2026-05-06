import type { CanvasItem } from './types'

export type GroupAutoArrangePositionEntry = {
  name: string
  minX: number
  minY: number
  order: number
}

export type SpatialLayoutEntry = {
  index: number
  minX: number
  minY: number
  width: number
  height: number
}

export type SpatialGridAssignment = {
  index: number
  row: number
  col: number
}

const GROUP_AUTO_ARRANGE_ROW_TOLERANCE = 24
const GROUP_AUTO_ARRANGE_BALANCED_MIN_ITEMS = 16
const GROUP_AUTO_ARRANGE_DEGENERATE_RATIO = 3
const GROUP_AUTO_ARRANGE_TARGET_ASPECT = 16 / 10

const AUTO_ARRANGE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

function tryDecodeFileName(fileName: string): string {
  try {
    return decodeURIComponent(fileName)
  } catch {
    return fileName
  }
}

export function extractCanvasFileNameFromSrc(src: string): string {
  if (!src) return ''

  const withoutQuery = src.split('?')[0]?.split('#')[0] || src
  const normalized = withoutQuery.replace(/^local-media:\/\/\/?/i, '').replace(/^file:\/\/\/?/i, '')
  const fileName = normalized.split('/').pop()?.split('\\').pop() || ''

  return tryDecodeFileName(fileName.trim())
}

export function getCanvasItemAutoArrangeSortName(item: CanvasItem): string {
  if ('fileName' in item && typeof item.fileName === 'string' && item.fileName.trim()) {
    return item.fileName.trim()
  }

  if (item.type === 'image') {
    const comfyFileName = item.fileItem?.filename?.trim() || ''
    if (comfyFileName) return comfyFileName
  }

  if ('src' in item && typeof item.src === 'string') {
    const fileNameFromSrc = extractCanvasFileNameFromSrc(item.src)
    if (fileNameFromSrc) return fileNameFromSrc
  }

  if (item.type === 'text') return item.text.trim() || item.id
  if (item.type === 'annotation') return item.label.trim() || item.text?.trim() || item.id

  return item.id
}

export function compareGroupAutoArrangePositionEntries(
  left: GroupAutoArrangePositionEntry,
  right: GroupAutoArrangePositionEntry
): number {
  const leftHasName = left.name.trim().length > 0
  const rightHasName = right.name.trim().length > 0

  const dy = left.minY - right.minY
  if (Math.abs(dy) > GROUP_AUTO_ARRANGE_ROW_TOLERANCE) {
    return dy
  }

  const dx = left.minX - right.minX
  if (dx !== 0) {
    return dx
  }

  return left.order - right.order
}

/**
 * Detect the spatial grid layout from item positions.
 *
 * Algorithm:
 * 1. Sort items by Y → cluster into rows using adaptive tolerance
 * 2. Within each row sort by X → derive column assignment
 * 3. Return per-item (row, col) assignments + grid dimensions
 *
 * The tolerance is adaptive: max(GROUP_AUTO_ARRANGE_ROW_TOLERANCE, minItemHeight * 0.5)
 * so that items clearly on the same visual row are grouped together.
 */
export function detectSpatialGridLayout(entries: SpatialLayoutEntry[]): {
  assignments: SpatialGridAssignment[]
  rows: number
  columns: number
} {
  if (entries.length === 0) return { assignments: [], rows: 0, columns: 0 }
  if (entries.length === 1) {
    return {
      assignments: [{ index: entries[0].index, row: 0, col: 0 }],
      rows: 1,
      columns: 1
    }
  }

  // Adaptive row tolerance based on minimum item height
  const minHeight = Math.min(...entries.map((e) => e.height))
  const rowTolerance = Math.max(GROUP_AUTO_ARRANGE_ROW_TOLERANCE, minHeight * 0.5)

  // Sort by Y to detect rows
  const sortedByY = [...entries].sort((a, b) => a.minY - b.minY)

  // Cluster into rows: items within rowTolerance of the row's first item
  const rowGroups: SpatialLayoutEntry[][] = []
  let currentRow: SpatialLayoutEntry[] = [sortedByY[0]]
  let rowStartY = sortedByY[0].minY

  for (let i = 1; i < sortedByY.length; i++) {
    if (sortedByY[i].minY - rowStartY > rowTolerance) {
      rowGroups.push(currentRow)
      currentRow = [sortedByY[i]]
      rowStartY = sortedByY[i].minY
    } else {
      currentRow.push(sortedByY[i])
    }
  }
  rowGroups.push(currentRow)

  // Sort each row by X
  for (const row of rowGroups) {
    row.sort((a, b) => a.minX - b.minX)
  }

  // Build assignments
  const maxColumns = Math.max(...rowGroups.map((r) => r.length))
  const assignments: SpatialGridAssignment[] = []

  for (let r = 0; r < rowGroups.length; r++) {
    for (let c = 0; c < rowGroups[r].length; c++) {
      assignments.push({ index: rowGroups[r][c].index, row: r, col: c })
    }
  }

  return { assignments, rows: rowGroups.length, columns: maxColumns }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function getAverageEntrySize(entries: SpatialLayoutEntry[]): { width: number; height: number } {
  if (entries.length === 0) return { width: 1, height: 1 }

  const totals = entries.reduce(
    (sum, entry) => ({
      width: sum.width + Math.max(1, entry.width),
      height: sum.height + Math.max(1, entry.height)
    }),
    { width: 0, height: 0 }
  )

  return {
    width: totals.width / entries.length,
    height: totals.height / entries.length
  }
}

function getEntryBoundsDegenerateRatio(entries: SpatialLayoutEntry[]): number {
  if (entries.length === 0) return 1

  const bounds = entries.reduce(
    (nextBounds, entry) => ({
      minX: Math.min(nextBounds.minX, entry.minX),
      minY: Math.min(nextBounds.minY, entry.minY),
      maxX: Math.max(nextBounds.maxX, entry.minX + Math.max(1, entry.width)),
      maxY: Math.max(nextBounds.maxY, entry.minY + Math.max(1, entry.height))
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  )
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)

  return Math.max(width / height, height / width)
}

function shouldUseBalancedGrid(
  entries: SpatialLayoutEntry[],
  detected: { rows: number; columns: number }
): boolean {
  if (entries.length < GROUP_AUTO_ARRANGE_BALANCED_MIN_ITEMS) return false
  if (detected.rows <= 0 || detected.columns <= 0) return false

  const rowColumnRatio = detected.rows / detected.columns
  const columnRowRatio = detected.columns / detected.rows

  return (
    rowColumnRatio >= GROUP_AUTO_ARRANGE_DEGENERATE_RATIO ||
    columnRowRatio >= GROUP_AUTO_ARRANGE_DEGENERATE_RATIO ||
    getEntryBoundsDegenerateRatio(entries) >= GROUP_AUTO_ARRANGE_DEGENERATE_RATIO
  )
}

function buildBalancedGridLayout(entries: SpatialLayoutEntry[]): {
  assignments: SpatialGridAssignment[]
  rows: number
  columns: number
} {
  if (entries.length === 0) return { assignments: [], rows: 0, columns: 0 }

  const averageSize = getAverageEntrySize(entries)
  const preferredColumns = Math.sqrt(
    entries.length * GROUP_AUTO_ARRANGE_TARGET_ASPECT * (averageSize.height / averageSize.width)
  )
  const columns = clampInteger(preferredColumns, 1, entries.length)
  const rows = Math.ceil(entries.length / columns)

  return {
    assignments: entries.map((entry, order) => ({
      index: entry.index,
      row: Math.floor(order / columns),
      col: order % columns
    })),
    rows,
    columns
  }
}

export function resolveAutoArrangeSpatialGridLayout(entries: SpatialLayoutEntry[]): {
  assignments: SpatialGridAssignment[]
  rows: number
  columns: number
} {
  const detected = detectSpatialGridLayout(entries)
  if (!shouldUseBalancedGrid(entries, detected)) return detected

  const entriesByIndex = new Map(entries.map((entry) => [entry.index, entry]))
  const detectedOrder = detected.assignments
    .map((assignment) => entriesByIndex.get(assignment.index))
    .filter((entry): entry is SpatialLayoutEntry => Boolean(entry))

  return buildBalancedGridLayout(detectedOrder.length === entries.length ? detectedOrder : entries)
}
