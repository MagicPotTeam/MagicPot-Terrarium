import type { CanvasGroup } from './types'

type GroupLike = Pick<CanvasGroup, 'id' | 'itemIds'>

export function getConflictingGroupIdsForSelection(
  groups: GroupLike[],
  selectedItemIds: string[]
): string[] {
  if (selectedItemIds.length === 0) return []

  const selectedIdSet = new Set(selectedItemIds)
  return groups
    .filter((group) => group.itemIds.some((itemId) => selectedIdSet.has(itemId)))
    .map((group) => group.id)
}

export function canCreateNewGroupFromSelection(
  groups: GroupLike[],
  selectedItemIds: string[]
): boolean {
  return (
    selectedItemIds.length > 1 &&
    getConflictingGroupIdsForSelection(groups, selectedItemIds).length === 0
  )
}
