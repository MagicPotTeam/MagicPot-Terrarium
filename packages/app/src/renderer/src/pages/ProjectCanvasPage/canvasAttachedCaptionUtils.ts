import type { CanvasAnnotationItem, CanvasItem } from './types'

export type AttachedCaptionAnnotation = CanvasAnnotationItem & {
  attachedToId?: string
  attachmentPlacement?: 'bottom-center'
}

export function isAttachedCaptionAnnotation(item: CanvasItem): item is AttachedCaptionAnnotation {
  return (
    item.type === 'annotation' &&
    item.shape === 'text-anno' &&
    typeof (item as AttachedCaptionAnnotation).attachedToId === 'string' &&
    Boolean((item as AttachedCaptionAnnotation).attachedToId)
  )
}

export function isConstraintAttachedCaptionAnnotation(
  item: CanvasItem
): item is AttachedCaptionAnnotation {
  return isAttachedCaptionAnnotation(item) && item.attachmentRole !== 'tagging-result'
}

export function collectCascadeDeletedCanvasItemIds(
  items: CanvasItem[],
  rootDeletedIds: Iterable<string>
): Set<string> {
  const deletedIds = new Set(rootDeletedIds)
  let changed = true

  while (changed) {
    changed = false
    for (const item of items) {
      if (
        isAttachedCaptionAnnotation(item) &&
        item.attachedToId &&
        deletedIds.has(item.attachedToId) &&
        !deletedIds.has(item.id)
      ) {
        deletedIds.add(item.id)
        changed = true
      }
    }
  }

  return deletedIds
}

export function removeCanvasItemsWithAttachedCaptions(
  items: CanvasItem[],
  rootDeletedIds: Iterable<string>
): {
  deletedIds: Set<string>
  nextItems: CanvasItem[]
} {
  const deletedIds = collectCascadeDeletedCanvasItemIds(items, rootDeletedIds)
  return {
    deletedIds,
    nextItems: items.filter((item) => !deletedIds.has(item.id))
  }
}

export function pruneOrphanAttachedCaptions(items: CanvasItem[]): CanvasItem[] {
  const itemIdSet = new Set(items.map((item) => item.id))
  const nextItems = items.filter(
    (item) =>
      !(isAttachedCaptionAnnotation(item) && item.attachedToId && !itemIdSet.has(item.attachedToId))
  )

  return nextItems.length === items.length ? items : nextItems
}
