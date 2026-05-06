export type CanvasViewportBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasViewportPlacementSize = {
  width: number
  height: number
}

export type CanvasViewportBatchLayoutEntry = {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_GRID_GAP = 32
const DEFAULT_MIN_CELL_WIDTH = 220
const DEFAULT_MIN_CELL_HEIGHT = 180
const DEFAULT_MAX_COLUMNS = 4

type CanvasViewportBatchLayoutOptions = {
  gap?: number
  minColumns?: number
  maxColumns?: number
  allowUpscale?: boolean
}

export function getCanvasViewportBounds(
  stagePos: { x: number; y: number },
  stageSize: { width: number; height: number },
  stageScale: number
): CanvasViewportBounds {
  const scaleSign = stageScale < 0 ? -1 : 1
  const safeScale = Math.max(Math.abs(stageScale), 0.0001) * scaleSign
  return {
    x: -stagePos.x / safeScale,
    y: -stagePos.y / safeScale,
    width: stageSize.width / safeScale,
    height: stageSize.height / safeScale
  }
}

export function getCenteredViewportPosition(
  viewport: CanvasViewportBounds,
  size: CanvasViewportPlacementSize
): { x: number; y: number } {
  return {
    x: viewport.x + (viewport.width - size.width) / 2,
    y: viewport.y + (viewport.height - size.height) / 2
  }
}

export function getCenteredViewportBatchPlacements(
  viewport: CanvasViewportBounds,
  sizes: CanvasViewportPlacementSize[],
  options?: {
    gap?: number
    minCellWidth?: number
    minCellHeight?: number
    maxColumns?: number
  }
): { x: number; y: number }[] {
  if (sizes.length === 0) return []

  const gap = options?.gap ?? DEFAULT_GRID_GAP
  const minCellWidth = options?.minCellWidth ?? DEFAULT_MIN_CELL_WIDTH
  const minCellHeight = options?.minCellHeight ?? DEFAULT_MIN_CELL_HEIGHT
  const maxColumns = options?.maxColumns ?? DEFAULT_MAX_COLUMNS

  const cellWidth = Math.max(minCellWidth, ...sizes.map((size) => size.width))
  const cellHeight = Math.max(minCellHeight, ...sizes.map((size) => size.height))
  const maxColumnsByViewport = Math.max(1, Math.floor((viewport.width + gap) / (cellWidth + gap)))
  const preferredColumns = Math.max(1, Math.ceil(Math.sqrt(sizes.length)))
  const columns = Math.max(
    1,
    Math.min(maxColumns, maxColumnsByViewport, preferredColumns, sizes.length)
  )
  const rows = Math.ceil(sizes.length / columns)
  const totalWidth = columns * cellWidth + (columns - 1) * gap
  const totalHeight = rows * cellHeight + (rows - 1) * gap
  const startX = viewport.x + (viewport.width - totalWidth) / 2
  const startY = viewport.y + (viewport.height - totalHeight) / 2

  return sizes.map((size, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cellX = startX + column * (cellWidth + gap)
    const cellY = startY + row * (cellHeight + gap)
    return {
      x: cellX + (cellWidth - size.width) / 2,
      y: cellY + (cellHeight - size.height) / 2
    }
  })
}

export function getViewportBatchGridLayout(
  viewport: CanvasViewportBounds,
  sizes: CanvasViewportPlacementSize[],
  options?: CanvasViewportBatchLayoutOptions
): CanvasViewportBatchLayoutEntry[] {
  if (sizes.length === 0) return []

  const viewportWidth = Math.max(1, viewport.width)
  const viewportHeight = Math.max(1, viewport.height)
  const viewportArea = viewportWidth * viewportHeight
  const baseGap = Math.max(0, options?.gap ?? DEFAULT_GRID_GAP)
  const allowUpscale = options?.allowUpscale ?? false
  const minColumns = Math.max(1, Math.floor(options?.minColumns ?? 1))
  const maxColumns = Math.max(
    minColumns,
    Math.min(sizes.length, Math.floor(options?.maxColumns ?? sizes.length))
  )

  let bestLayout: CanvasViewportBatchLayoutEntry[] | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  let bestUsedArea = Number.NEGATIVE_INFINITY
  let bestBoundsArea = Number.NEGATIVE_INFINITY

  for (let columns = minColumns; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(sizes.length / columns)
    const gap = Math.min(
      baseGap,
      viewportWidth / Math.max(columns + 1, 2),
      viewportHeight / Math.max(rows + 1, 2)
    )
    const cellWidth = Math.max(1, (viewportWidth - gap * (columns - 1)) / columns)
    const cellHeight = Math.max(1, (viewportHeight - gap * (rows - 1)) / rows)

    const scaledEntries = sizes.map((size, index) => {
      const safeWidth = Math.max(1, size.width)
      const safeHeight = Math.max(1, size.height)
      const fitScale = Math.min(cellWidth / safeWidth, cellHeight / safeHeight)
      const scale = allowUpscale ? fitScale : Math.min(fitScale, 1)
      return {
        column: index % columns,
        row: Math.floor(index / columns),
        width: Math.max(1, safeWidth * scale),
        height: Math.max(1, safeHeight * scale)
      }
    })

    const columnWidths = Array.from({ length: columns }, () => 0)
    const rowHeights = Array.from({ length: rows }, () => 0)

    for (const entry of scaledEntries) {
      columnWidths[entry.column] = Math.max(columnWidths[entry.column], entry.width)
      rowHeights[entry.row] = Math.max(rowHeights[entry.row], entry.height)
    }

    const totalWidth = columnWidths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1)
    const totalHeight = rowHeights.reduce((sum, value) => sum + value, 0) + gap * (rows - 1)
    const startX = viewport.x + (viewport.width - totalWidth) / 2
    const startY = viewport.y + (viewport.height - totalHeight) / 2

    const layout: CanvasViewportBatchLayoutEntry[] = []
    let usedArea = 0

    for (const entry of scaledEntries) {
      let x = startX
      for (let columnIndex = 0; columnIndex < entry.column; columnIndex += 1) {
        x += columnWidths[columnIndex] + gap
      }

      let y = startY
      for (let rowIndex = 0; rowIndex < entry.row; rowIndex += 1) {
        y += rowHeights[rowIndex] + gap
      }

      const width = entry.width
      const height = entry.height
      usedArea += width * height

      layout.push({
        x: Math.round(x + (columnWidths[entry.column] - width) / 2),
        y: Math.round(y + (rowHeights[entry.row] - height) / 2),
        width: Math.round(width),
        height: Math.round(height)
      })
    }

    const widthFill = Math.min(totalWidth / viewportWidth, 1)
    const heightFill = Math.min(totalHeight / viewportHeight, 1)
    const boundsArea = totalWidth * totalHeight
    const score =
      usedArea / viewportArea +
      widthFill * 0.08 +
      heightFill * 0.08 -
      Math.abs(widthFill - heightFill) * 0.02

    if (
      score > bestScore ||
      (score === bestScore &&
        (usedArea > bestUsedArea || (usedArea === bestUsedArea && boundsArea > bestBoundsArea)))
    ) {
      bestLayout = layout
      bestScore = score
      bestUsedArea = usedArea
      bestBoundsArea = boundsArea
    }
  }

  if (bestLayout) {
    return bestLayout
  }

  return sizes.map((size) => ({
    ...getCenteredViewportPosition(viewport, size),
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height))
  }))
}
