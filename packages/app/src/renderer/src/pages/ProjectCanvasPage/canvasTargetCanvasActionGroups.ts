import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import type { CanvasGroup } from './types'
import { buildFallbackResult } from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

function resolveGroupIds(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[],
  options: { allowNameMatch?: boolean } = { allowNameMatch: true }
): string[] {
  const groups = state.groups || []
  if (action.groupId) {
    return groups.some((group) => group.id === action.groupId) ? [action.groupId] : []
  }

  if (sourceIds.length > 0) {
    const sourceIdSet = new Set(sourceIds)
    return groups
      .filter((group) => group.itemIds.some((itemId) => sourceIdSet.has(itemId)))
      .map((group) => group.id)
  }

  if (options.allowNameMatch && action.groupName) {
    return groups.filter((group) => group.name === action.groupName).map((group) => group.id)
  }

  return []
}

export function createCanvasGroup(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  if (sourceIds.length === 0) {
    return buildFallbackResult(action, state, 'No source items were available to group.')
  }

  const groups = state.groups || []
  const sourceIdSet = new Set(sourceIds)
  const cleanedGroups = groups
    .map((group) => ({
      ...group,
      itemIds: group.itemIds.filter((itemId) => !sourceIdSet.has(itemId))
    }))
    .filter((group) => group.itemIds.length > 0)
  const nextIndex =
    groups.reduce((maxValue, group) => Math.max(maxValue, group.defaultIndex ?? 0), 0) + 1
  const requestedGroupId = action.groupId?.trim()
  const nextGroupId =
    requestedGroupId && !groups.some((group) => group.id === requestedGroupId)
      ? requestedGroupId
      : `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const nextGroup: CanvasGroup = {
    id: nextGroupId,
    name: action.groupName || `Target group ${nextIndex}`,
    itemIds: sourceIds,
    createdAt: new Date().toISOString(),
    branchId: null,
    defaultIndex: nextIndex
  }

  return {
    items: state.items,
    groups: [...cleanedGroups, nextGroup],
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(sourceIds),
    nextZIndex: state.nextZIndex,
    affectedIds: sourceIds,
    createdIds: [],
    resultIds: sourceIds,
    content: `Created group "${nextGroup.name}" from ${sourceIds.length} item(s).`,
    canvasDispatchCount: sourceIds.length
  }
}

export function deleteCanvasGroup(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const groupIds = resolveGroupIds(action, state, sourceIds)
  if (groupIds.length === 0) {
    return buildFallbackResult(action, state, 'No canvas group matched delete_group.')
  }

  const groupIdSet = new Set(groupIds)
  return {
    items: state.items,
    groups: (state.groups || []).filter((group) => !groupIdSet.has(group.id)),
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: groupIds,
    createdIds: [],
    resultIds: groupIds,
    content: `Deleted ${groupIds.length} canvas group(s).`,
    canvasDispatchCount: groupIds.length
  }
}

export function renameCanvasGroup(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const matchingByOldName = Boolean(!action.groupId && sourceIds.length === 0 && action.itemLabel)
  const groupIds = resolveGroupIds(action, state, sourceIds, {
    allowNameMatch: matchingByOldName
  })
  const nextName = matchingByOldName ? action.itemLabel : action.groupName || action.itemLabel
  if (groupIds.length === 0 || !nextName) {
    return buildFallbackResult(
      action,
      state,
      'No canvas group or target name matched rename_group.'
    )
  }

  const groupIdSet = new Set(groupIds)
  return {
    items: state.items,
    groups: (state.groups || []).map((group) =>
      groupIdSet.has(group.id) ? { ...group, name: nextName } : group
    ),
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: groupIds,
    createdIds: [],
    resultIds: groupIds,
    content: `Renamed ${groupIds.length} canvas group(s) to "${nextName}".`,
    canvasDispatchCount: groupIds.length
  }
}
