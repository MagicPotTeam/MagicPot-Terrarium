import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasGroup, CanvasItem } from './types'

export type CanvasFocusBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function getCanvasItemFocusBounds(item: CanvasItem): CanvasFocusBounds {
  if (item.type === 'annotation') {
    if (
      (item.shape === 'arrow' || item.shape === 'line') &&
      item.endX != null &&
      item.endY != null
    ) {
      return {
        minX: Math.min(item.x, item.endX),
        minY: Math.min(item.y, item.endY),
        maxX: Math.max(item.x, item.endX),
        maxY: Math.max(item.y, item.endY)
      }
    }

    if (item.shape === 'freedraw' && item.points && item.points.length >= 2) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      for (let index = 0; index < item.points.length; index += 2) {
        const x = item.points[index]
        const y = item.points[index + 1]
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }

      if (Number.isFinite(minX) && Number.isFinite(minY)) {
        return { minX, minY, maxX, maxY }
      }
    }
  }

  const x2 = item.x + item.width * (item.scaleX || 1)
  const y2 = item.y + item.height * (item.scaleY || 1)

  return {
    minX: Math.min(item.x, x2),
    minY: Math.min(item.y, y2),
    maxX: Math.max(item.x, x2),
    maxY: Math.max(item.y, y2)
  }
}

function getCanvasItemsFocusBounds(targetItems: CanvasItem[]): CanvasFocusBounds | null {
  if (targetItems.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const item of targetItems) {
    const bounds = getCanvasItemFocusBounds(item)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
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

export function canvasExportBoundsToFocusBounds(
  bounds: CanvasExportBounds | null | undefined
): CanvasFocusBounds | null {
  if (!bounds) return null

  return {
    minX: bounds.x,
    minY: bounds.y,
    maxX: bounds.x + bounds.width,
    maxY: bounds.y + bounds.height
  }
}

export function resolveCanvasFitBounds(options: {
  items: CanvasItem[]
  selectedIds: Set<string>
  exactSelectedGroupBounds?: CanvasExportBounds | null
  getCanvasItemsVisualBounds: (targetItems: CanvasItem[]) => CanvasExportBounds | null
}): CanvasFocusBounds | null {
  const { items, selectedIds, exactSelectedGroupBounds, getCanvasItemsVisualBounds } = options

  if (selectedIds.size > 0) {
    const selectedItems = items.filter((item) => selectedIds.has(item.id))
    if (selectedItems.length > 0) {
      return (
        canvasExportBoundsToFocusBounds(
          exactSelectedGroupBounds ?? getCanvasItemsVisualBounds(selectedItems)
        ) ?? getCanvasItemsFocusBounds(selectedItems)
      )
    }
  }

  return getCanvasItemsFocusBounds(items)
}

export function getExactSelectedGroupBounds(options: {
  groups: CanvasGroup[]
  items: CanvasItem[]
  selectedIds: Set<string>
  getCanvasItemsVisualBounds: (targetItems: CanvasItem[]) => CanvasExportBounds | null
}): CanvasExportBounds | null {
  const { groups, items, selectedIds, getCanvasItemsVisualBounds } = options

  if (selectedIds.size === 0) return null

  for (const group of groups) {
    const targetItems = items.filter((item) => group.itemIds.includes(item.id))
    if (targetItems.length === 0 || targetItems.length !== selectedIds.size) continue
    if (!targetItems.every((item) => selectedIds.has(item.id))) continue

    return getCanvasItemsVisualBounds(targetItems)
  }

  return null
}
