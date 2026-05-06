import type {
  CanvasGroup,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'

export interface CanvasGroupSummary extends CanvasGroup {
  validItems: CanvasItem[]
  validCount: number
  totalCount: number
}

type GroupPlayableItem = CanvasImageItem | CanvasVideoItem | CanvasModel3DItem

function isGroupPlayableItem(item: CanvasItem): item is GroupPlayableItem {
  return item.type === 'image' || item.type === 'video' || item.type === 'model3d'
}

export function buildVisibleGroupSummaries(
  groups: CanvasGroup[],
  items: CanvasItem[]
): CanvasGroupSummary[] {
  const itemById = new Map(items.map((item) => [item.id, item] as const))

  return groups
    .map((group) => {
      const validItems = group.itemIds
        .map((itemId) => itemById.get(itemId) ?? null)
        .filter((item): item is CanvasItem => item !== null)

      return {
        ...group,
        validItems,
        validCount: validItems.length,
        totalCount: group.itemIds.length
      }
    })
    .filter((group) => group.validCount > 0)
}

export function canPlayGroupSummary(group: Pick<CanvasGroupSummary, 'validItems'>): boolean {
  return group.validItems.some(isGroupPlayableItem)
}

export function normalizeGroupNameDraft(draft: string, fallbackName: string): string {
  const trimmedDraft = draft.trim()
  return trimmedDraft.length > 0 ? trimmedDraft : fallbackName
}
