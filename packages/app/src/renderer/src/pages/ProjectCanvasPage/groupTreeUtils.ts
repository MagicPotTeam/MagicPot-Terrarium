import { getCanvasItemsBounds, translateCanvasItem } from './projectCanvasPageShared'
import type { CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'
import type { CanvasGroupSummary } from './groupMenuUtils'

export const UNGROUPED_BRANCH_KEY = '__ungrouped__'

export type CanvasGroupBranchSection = {
  id: string
  branchId: string | null
  name: string
  isUngrouped: boolean
  groups: CanvasGroupSummary[]
}

function buildGroupBranchSortIndex(
  branchId: string | null,
  groupBranches: CanvasGroupBranch[]
): number {
  if (!branchId) return groupBranches.length
  const index = groupBranches.findIndex((branch) => branch.id === branchId)
  return index >= 0 ? index : groupBranches.length
}

export function normalizeCanvasGroupBranchId(
  branchId: string | null | undefined,
  groupBranches: CanvasGroupBranch[]
): string | null {
  if (!branchId) return null
  return groupBranches.some((branch) => branch.id === branchId) ? branchId : null
}

export function buildCanvasGroupBranchSections(
  groupBranches: CanvasGroupBranch[],
  groupSummaries: CanvasGroupSummary[],
  ungroupedLabel: string
): CanvasGroupBranchSection[] {
  const groupsByBranchId = new Map<string | null, CanvasGroupSummary[]>()

  for (const group of groupSummaries) {
    const branchId = normalizeCanvasGroupBranchId(group.branchId, groupBranches)
    const currentGroups = groupsByBranchId.get(branchId) ?? []
    currentGroups.push(group)
    groupsByBranchId.set(branchId, currentGroups)
  }

  const sections: CanvasGroupBranchSection[] = groupBranches.map((branch) => ({
    id: branch.id,
    branchId: branch.id,
    name: branch.name,
    isUngrouped: false,
    groups: groupsByBranchId.get(branch.id) ?? []
  }))

  const ungroupedGroups = groupsByBranchId.get(null) ?? []
  if (ungroupedGroups.length > 0 || sections.length === 0) {
    sections.push({
      id: UNGROUPED_BRANCH_KEY,
      branchId: null,
      name: ungroupedLabel,
      isUngrouped: true,
      groups: ungroupedGroups
    })
  }

  return sections
}

export function applyCanvasGroupBranchDeletion(options: {
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  branchId: string | null
}): {
  nextGroups: CanvasGroup[]
  nextGroupBranches: CanvasGroupBranch[]
} {
  const { groups, groupBranches, branchId } = options

  if (!branchId) {
    return {
      nextGroups: groups.filter(
        (group) => normalizeCanvasGroupBranchId(group.branchId, groupBranches) !== null
      ),
      nextGroupBranches: groupBranches
    }
  }

  return {
    nextGroups: groups.map((group) =>
      group.branchId === branchId ? { ...group, branchId: null } : group
    ),
    nextGroupBranches: groupBranches.filter((branch) => branch.id !== branchId)
  }
}

export function findFirstCanvasGroupInBranch(
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  branchId: string | null
): CanvasGroup | null {
  const normalizedBranchId = normalizeCanvasGroupBranchId(branchId, groupBranches)
  return (
    groups.find(
      (group) => normalizeCanvasGroupBranchId(group.branchId, groupBranches) === normalizedBranchId
    ) ?? null
  )
}

export function moveCanvasGroupToBranch(options: {
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  groupId: string
  targetBranchId: string | null
}): {
  nextGroups: CanvasGroup[]
  normalizedTargetBranchId: string | null
  targetBranchGroupIds: string[]
} {
  const { groups, groupBranches, groupId, targetBranchId } = options
  const normalizedTargetBranchId = normalizeCanvasGroupBranchId(targetBranchId, groupBranches)
  const movingGroup = groups.find((group) => group.id === groupId)
  if (!movingGroup) {
    return {
      nextGroups: groups,
      normalizedTargetBranchId,
      targetBranchGroupIds: []
    }
  }

  const normalizedCurrentBranchId = normalizeCanvasGroupBranchId(
    movingGroup.branchId,
    groupBranches
  )
  if (normalizedCurrentBranchId === normalizedTargetBranchId) {
    return {
      nextGroups: groups,
      normalizedTargetBranchId,
      targetBranchGroupIds: groups
        .filter(
          (group) =>
            normalizeCanvasGroupBranchId(group.branchId, groupBranches) === normalizedTargetBranchId
        )
        .map((group) => group.id)
    }
  }

  const groupsWithoutMoving = groups.filter((group) => group.id !== groupId)
  const nextGroup = {
    ...movingGroup,
    branchId: normalizedTargetBranchId
  }

  const firstGroupInTargetBranchIndex = groupsWithoutMoving.findIndex(
    (group) =>
      normalizeCanvasGroupBranchId(group.branchId, groupBranches) === normalizedTargetBranchId
  )

  let insertIndex = firstGroupInTargetBranchIndex + 1
  if (firstGroupInTargetBranchIndex === -1) {
    const targetBranchOrder = buildGroupBranchSortIndex(normalizedTargetBranchId, groupBranches)
    insertIndex = groupsWithoutMoving.findIndex((group) => {
      const branchOrder = buildGroupBranchSortIndex(
        normalizeCanvasGroupBranchId(group.branchId, groupBranches),
        groupBranches
      )
      return branchOrder > targetBranchOrder
    })
    if (insertIndex === -1) {
      insertIndex = groupsWithoutMoving.length
    }
  }

  const nextGroups = [
    ...groupsWithoutMoving.slice(0, insertIndex),
    nextGroup,
    ...groupsWithoutMoving.slice(insertIndex)
  ]

  return {
    nextGroups,
    normalizedTargetBranchId,
    targetBranchGroupIds: nextGroups
      .filter(
        (group) =>
          normalizeCanvasGroupBranchId(group.branchId, groupBranches) === normalizedTargetBranchId
      )
      .map((group) => group.id)
  }
}

export function realignCanvasGroupsIntoBranchRow(options: {
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupIds: string[]
  gap?: number
}): CanvasItem[] {
  const { items, groups, groupIds, gap = 64 } = options
  if (groupIds.length < 2) {
    return items
  }

  const groupById = new Map(groups.map((group) => [group.id, group] as const))
  const itemById = new Map(items.map((item) => [item.id, item] as const))
  const boundsByGroupId = new Map<string, ReturnType<typeof getCanvasItemsBounds>>()

  for (const groupId of groupIds) {
    const group = groupById.get(groupId)
    if (!group) continue
    const groupItems = group.itemIds
      .map((itemId) => itemById.get(itemId) ?? null)
      .filter((item): item is CanvasItem => item !== null)
    boundsByGroupId.set(groupId, getCanvasItemsBounds(groupItems))
  }

  const anchorBounds = boundsByGroupId.get(groupIds[0])
  if (!anchorBounds) {
    return items
  }

  let currentMinX = anchorBounds.maxX + gap
  const rowMinY = anchorBounds.minY
  const adjustmentByItemId = new Map<string, { dx: number; dy: number }>()

  for (const groupId of groupIds.slice(1)) {
    const group = groupById.get(groupId)
    const bounds = boundsByGroupId.get(groupId)
    if (!group || !bounds) continue

    const dx = currentMinX - bounds.minX
    const dy = rowMinY - bounds.minY
    group.itemIds.forEach((itemId) => {
      adjustmentByItemId.set(itemId, { dx, dy })
    })

    currentMinX += bounds.maxX - bounds.minX + gap
  }

  if (adjustmentByItemId.size === 0) {
    return items
  }

  return items.map((item) => {
    const adjustment = adjustmentByItemId.get(item.id)
    return adjustment ? translateCanvasItem(item, adjustment.dx, adjustment.dy) : item
  })
}
