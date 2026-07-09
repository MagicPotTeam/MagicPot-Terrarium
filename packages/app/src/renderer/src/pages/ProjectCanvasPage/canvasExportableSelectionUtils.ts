import { isCanvasExportableItem, type CanvasExportableItem } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

export function getCanvasExportableItems(items: readonly CanvasItem[]): CanvasExportableItem[] {
  return items.filter((item): item is CanvasExportableItem => isCanvasExportableItem(item))
}

export function getSelectedCanvasExportableItems(
  items: readonly CanvasItem[],
  selectedIds: ReadonlySet<string>
): CanvasExportableItem[] {
  return items.filter(
    (item): item is CanvasExportableItem => selectedIds.has(item.id) && isCanvasExportableItem(item)
  )
}
