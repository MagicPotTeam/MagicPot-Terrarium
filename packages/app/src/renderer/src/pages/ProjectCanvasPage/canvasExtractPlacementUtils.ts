import { buildCanvasItemSpatialIndex, queryOwnedCanvasSpatialIndex } from './canvasSpatialIndex'
import { getCanvasItemBounds, translateCanvasItem } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

export type CanvasRect = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type ExtractedCanvasPieceSize = {
  id: string
  width: number
  height: number
}

export type ExtractedCanvasPiecePlacement = ExtractedCanvasPieceSize & {
  x: number
  y: number
}

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
  padding: number
) {
  return (
    left.x < right.x + right.width + padding &&
    left.x + left.width > right.x - padding &&
    left.y < right.y + right.height + padding &&
    left.y + left.height > right.y - padding
  )
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number) {
  return minA < maxB && maxA > minB
}

export function packExtractedPiecesToRight(
  anchorBounds: CanvasRect,
  pieces: readonly ExtractedCanvasPieceSize[],
  options?: {
    sourceGap?: number
    itemGap?: number
    maxRowWidth?: number
  }
) {
  const sourceGap = options?.sourceGap ?? 48
  const itemGap = options?.itemGap ?? 16
  const anchorWidth = Math.max(anchorBounds.maxX - anchorBounds.minX, 1)
  const resolvedMaxRowWidth = Math.max(
    options?.maxRowWidth ?? anchorWidth * 1.4,
    Math.min(anchorWidth * 2, 360)
  )
  const startX = anchorBounds.maxX + sourceGap
  const startY = anchorBounds.minY

  const placements: ExtractedCanvasPiecePlacement[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  let maxPlacedX = startX
  let maxPlacedY = startY

  pieces.forEach((piece, index) => {
    const pieceWidth = Math.max(1, piece.width)
    const pieceHeight = Math.max(1, piece.height)

    if (index > 0 && cursorX > 0 && cursorX + pieceWidth > resolvedMaxRowWidth) {
      cursorX = 0
      cursorY += rowHeight + itemGap
      rowHeight = 0
    }

    const x = startX + cursorX
    const y = startY + cursorY
    placements.push({
      ...piece,
      x,
      y
    })

    cursorX += pieceWidth + itemGap
    rowHeight = Math.max(rowHeight, pieceHeight)
    maxPlacedX = Math.max(maxPlacedX, x + pieceWidth)
    maxPlacedY = Math.max(maxPlacedY, y + pieceHeight)
  })

  return {
    placements,
    bounds: {
      minX: startX,
      minY: startY,
      maxX: maxPlacedX,
      maxY: maxPlacedY
    } satisfies CanvasRect
  }
}

export function placeNextExtractedPieceToRight(
  anchorBounds: CanvasRect,
  existingPlacements: readonly ExtractedCanvasPiecePlacement[],
  piece: ExtractedCanvasPieceSize,
  options?: {
    sourceGap?: number
    itemGap?: number
    maxRowWidth?: number
  }
) {
  const itemGap = options?.itemGap ?? 16
  const { placements } = packExtractedPiecesToRight(
    anchorBounds,
    [
      ...existingPlacements.map((existingPlacement) => ({
        id: existingPlacement.id,
        width: existingPlacement.width,
        height: existingPlacement.height
      })),
      piece
    ],
    options
  )

  let nextPlacement =
    placements[placements.length - 1] ??
    ({
      ...piece,
      x: anchorBounds.maxX + (options?.sourceGap ?? 48),
      y: anchorBounds.minY
    } satisfies ExtractedCanvasPiecePlacement)

  for (let guard = 0; guard < existingPlacements.length + 4; guard += 1) {
    const overlappingPlacements = existingPlacements.filter((existingPlacement) =>
      rectsOverlap(nextPlacement, existingPlacement, itemGap)
    )
    if (overlappingPlacements.length === 0) {
      break
    }

    nextPlacement = {
      ...nextPlacement,
      y: Math.max(
        ...overlappingPlacements.map(
          (existingPlacement) => existingPlacement.y + existingPlacement.height + itemGap
        )
      )
    }
  }

  return {
    placement: nextPlacement,
    bounds: {
      minX: nextPlacement.x,
      minY: nextPlacement.y,
      maxX: nextPlacement.x + nextPlacement.width,
      maxY: nextPlacement.y + nextPlacement.height
    } satisfies CanvasRect
  }
}

export function shiftCanvasItemsToMakeRoom(
  items: readonly CanvasItem[],
  targetRect: CanvasRect,
  preservedIds: ReadonlySet<string>,
  padding = 32
) {
  const collisions = queryOwnedCanvasSpatialIndex(
    buildCanvasItemSpatialIndex(items, getCanvasItemBounds),
    {
      minX: targetRect.minX - padding,
      minY: targetRect.minY - padding,
      maxX: targetRect.maxX + padding,
      maxY: targetRect.maxY + padding
    }
  ).filter((item) => !preservedIds.has(item.id))

  if (collisions.length === 0) {
    return items as CanvasItem[]
  }

  const verticalBandMin = targetRect.minY - padding
  const verticalBandMax = targetRect.maxY + padding
  const movableItems = items.filter((item) => {
    if (preservedIds.has(item.id)) {
      return false
    }

    const bounds = getCanvasItemBounds(item)
    return (
      bounds.maxX > targetRect.minX - padding &&
      rangesOverlap(bounds.minY, bounds.maxY, verticalBandMin, verticalBandMax)
    )
  })

  if (movableItems.length === 0) {
    return items as CanvasItem[]
  }

  const minMovableX = movableItems.reduce(
    (minValue, item) => Math.min(minValue, getCanvasItemBounds(item).minX),
    Number.POSITIVE_INFINITY
  )

  if (!Number.isFinite(minMovableX)) {
    return items as CanvasItem[]
  }

  const deltaX = targetRect.maxX + padding - minMovableX
  if (deltaX <= 0) {
    return items as CanvasItem[]
  }

  const movableIds = new Set(movableItems.map((item) => item.id))
  return items.map((item) =>
    movableIds.has(item.id) ? translateCanvasItem(item, deltaX, 0) : item
  ) as CanvasItem[]
}
