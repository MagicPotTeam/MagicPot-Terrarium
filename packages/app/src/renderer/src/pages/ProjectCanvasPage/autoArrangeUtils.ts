import type { CanvasItem } from './types'

export type AutoArrangeSortEntry = {
  item: CanvasItem
  minX: number
  minY: number
}

const AUTO_ARRANGE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

const getCanvasItemSortNameFromSrc = (src?: string): string => {
  if (!src) return ''
  const normalized = src.replace(/\\/g, '/').trim()
  const lastSegment = normalized.split('/').pop() ?? ''
  return decodeURIComponent(lastSegment).trim()
}

export const getCanvasItemAutoArrangeName = (item: CanvasItem): string => {
  switch (item.type) {
    case 'image':
      return item.fileName?.trim() || getCanvasItemSortNameFromSrc(item.src)
    case 'video':
    case 'model3d':
    case 'file':
      return item.fileName.trim()
    case 'text':
      return item.text.trim()
    case 'annotation':
      return item.label?.trim() || item.text?.trim() || item.shape
    case 'html':
      return 'html'
    default:
      return ''
  }
}

export const compareCanvasAutoArrangeEntries = (
  left: AutoArrangeSortEntry,
  right: AutoArrangeSortEntry
): number => {
  const leftName = getCanvasItemAutoArrangeName(left.item)
  const rightName = getCanvasItemAutoArrangeName(right.item)
  const leftHasName = leftName.length > 0
  const rightHasName = rightName.length > 0

  if (leftHasName && rightHasName) {
    const nameCompare = AUTO_ARRANGE_COLLATOR.compare(leftName, rightName)
    if (nameCompare !== 0) {
      return nameCompare
    }
  } else if (leftHasName !== rightHasName) {
    return leftHasName ? -1 : 1
  }

  if (left.minY !== right.minY) {
    return left.minY - right.minY
  }
  return left.minX - right.minX
}
