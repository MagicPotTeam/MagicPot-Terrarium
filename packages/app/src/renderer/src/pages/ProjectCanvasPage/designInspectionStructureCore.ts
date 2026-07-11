import type { DesignInspectionItemSummary } from '@shared/designInspection'
import { roundDesignInspectionMetric } from './designInspectionCommon'
import type {
  InspectableRectangularAnnotationSummary,
  WidthNormalizableItemSummary
} from './designInspectionStructureTypes'

export const ALIGNMENT_TOLERANCE_PX = 4
export const SPACING_TOLERANCE_PX = 6
export const HEIGHT_TOLERANCE_PX = 6
export const WIDTH_TOLERANCE_PX = 6

export function roundMetric(value: number): number {
  return roundDesignInspectionMetric(value)
}

export function getRectangularAnnotationItems(
  items: DesignInspectionItemSummary[]
): InspectableRectangularAnnotationSummary[] {
  return items.filter((item): item is InspectableRectangularAnnotationSummary => {
    return item.type === 'annotation' && (item.shape === 'rect' || item.shape === 'rounded-rect')
  })
}

export function getWidthNormalizableItems(
  items: DesignInspectionItemSummary[]
): WidthNormalizableItemSummary[] {
  return items.filter((item): item is WidthNormalizableItemSummary => {
    if (item.type === 'file') return true

    return (
      item.type === 'annotation' &&
      (item.shape === 'rect' ||
        item.shape === 'rounded-rect' ||
        item.shape === 'document' ||
        item.shape === 'double-line-rect')
    )
  })
}

export function getHeightNormalizableItems(
  items: DesignInspectionItemSummary[]
): WidthNormalizableItemSummary[] {
  return getWidthNormalizableItems(items)
}

export function getLayoutHeuristicItems(
  items: DesignInspectionItemSummary[]
): DesignInspectionItemSummary[] {
  const blockItems = getWidthNormalizableItems(items)

  if (blockItems.length > 0 && blockItems.length < items.length) {
    return blockItems
  }

  return items
}

export function getItemArea(item: DesignInspectionItemSummary): number {
  return roundMetric(item.bounds.width * item.bounds.height)
}

export function itemIsContainedWithin(
  item: DesignInspectionItemSummary,
  container: WidthNormalizableItemSummary
): boolean {
  return (
    item.bounds.x >= container.bounds.x - ALIGNMENT_TOLERANCE_PX &&
    item.bounds.y >= container.bounds.y - ALIGNMENT_TOLERANCE_PX &&
    item.bounds.x + item.bounds.width <=
      container.bounds.x + container.bounds.width + ALIGNMENT_TOLERANCE_PX &&
    item.bounds.y + item.bounds.height <=
      container.bounds.y + container.bounds.height + ALIGNMENT_TOLERANCE_PX
  )
}

export function resolveContainingLayoutContainer(
  item: DesignInspectionItemSummary,
  containers: WidthNormalizableItemSummary[]
): WidthNormalizableItemSummary | null {
  const candidates = containers
    .filter((container) => item.id !== container.id && itemIsContainedWithin(item, container))
    .sort((left, right) => {
      const areaDelta = getItemArea(left) - getItemArea(right)
      if (areaDelta !== 0) return areaDelta
      return left.zIndex - right.zIndex
    })

  return candidates[0] ?? null
}

export function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}
