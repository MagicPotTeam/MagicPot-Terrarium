import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import { uniqueExistingIds } from './canvasTargetCanvasActionCore'
import type { CanvasTargetSemanticCanvasActionState } from './canvasTargetCanvasActionTypes'

const CANVAS_TARGET_SEMANTIC_ACTION_NAMES: ReadonlySet<CanvasTargetCanvasAction['action']> =
  new Set([
    'add_text',
    'add_annotation',
    'select_items',
    'duplicate_items',
    'arrange_items',
    'transform_items',
    'set_z_order',
    'delete_items',
    'clear_canvas',
    'flip_items',
    'crop_image',
    'update_text',
    'update_annotation',
    'set_media_playback',
    'create_group',
    'delete_group',
    'rename_group',
    'focus_items',
    'set_canvas_background',
    'set_grid_visibility',
    'set_canvas_tool'
  ])

const CANVAS_TARGET_SOURCE_REQUIRED_ACTION_NAMES: ReadonlySet<CanvasTargetCanvasAction['action']> =
  new Set([
    'select_items',
    'duplicate_items',
    'arrange_items',
    'transform_items',
    'set_z_order',
    'delete_items',
    'flip_items',
    'crop_image',
    'extract_image_region',
    'update_text',
    'update_annotation',
    'set_media_playback',
    'create_group',
    'delete_group',
    'rename_group',
    'focus_items'
  ])

export const isCanvasTargetSemanticCanvasActionName = (
  action: CanvasTargetCanvasAction['action']
): boolean => CANVAS_TARGET_SEMANTIC_ACTION_NAMES.has(action)

export function canvasTargetCanvasActionRequiresResolvedSource(
  action: CanvasTargetCanvasAction
): boolean {
  return CANVAS_TARGET_SOURCE_REQUIRED_ACTION_NAMES.has(action.action)
}

export function canvasTargetSemanticCanvasActionRequiresResolvedSource(
  action: CanvasTargetCanvasAction
): boolean {
  return canvasTargetCanvasActionRequiresResolvedSource(action)
}

// Every item id an action names, before anything is dropped: ids that do not
// exist on the canvas stay in `ids`, and a stage or artifact reference that
// maps to no canvas item is reported in `unresolved`. Authorization checks
// use this so a reference that cannot be resolved is refused, not silently
// narrowed. Same precedence as resolveCanvasTargetSemanticCanvasActionSourceIds.
export function collectCanvasTargetCanvasActionReferencedIds(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): { ids: string[]; unresolved: string[] } {
  const sourceStageIds = [
    ...(action.sourceStageId ? [action.sourceStageId] : []),
    ...(action.sourceStageIds || [])
  ]
  if (sourceStageIds.length > 0) {
    const mapped = sourceStageIds.map((stageId) => state.stageCanvasItemIds?.get(stageId))
    return {
      ids: Array.from(new Set(mapped.flatMap((ids) => ids || []))),
      unresolved: sourceStageIds.filter((_, index) => !mapped[index]?.length)
    }
  }

  const artifactIds = [
    ...(action.artifactId ? [action.artifactId] : []),
    ...(action.artifactIds || [])
  ]
  if (artifactIds.length > 0) {
    const mapped = artifactIds.map((artifactId) => state.artifactCanvasItemIds?.get(artifactId))
    return {
      ids: Array.from(new Set(mapped.flatMap((ids) => ids || []))),
      unresolved: artifactIds.filter((_, index) => !mapped[index]?.length)
    }
  }

  if (action.itemIds?.length) {
    return { ids: Array.from(new Set(action.itemIds)), unresolved: [] }
  }

  switch (action.source) {
    case 'item_ids':
      return { ids: Array.from(new Set(action.itemIds || [])), unresolved: [] }
    case 'all_canvas':
      return { ids: state.items.map((item) => item.id), unresolved: [] }
    case 'current_selection':
      return { ids: Array.from(state.selectedIds), unresolved: [] }
    default:
      return { ids: [], unresolved: [] }
  }
}

export function resolveCanvasTargetSemanticCanvasActionSourceIds(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): string[] {
  const itemById = new Map(state.items.map((item) => [item.id, item]))

  const sourceStageIds = [
    ...(action.sourceStageId ? [action.sourceStageId] : []),
    ...(action.sourceStageIds || [])
  ]
  if (sourceStageIds.length > 0) {
    return uniqueExistingIds(
      sourceStageIds.flatMap((stageId) => state.stageCanvasItemIds?.get(stageId) || []),
      itemById
    )
  }

  const artifactIds = [
    ...(action.artifactId ? [action.artifactId] : []),
    ...(action.artifactIds || [])
  ]
  if (artifactIds.length > 0) {
    return uniqueExistingIds(
      artifactIds.flatMap((artifactId) => state.artifactCanvasItemIds?.get(artifactId) || []),
      itemById
    )
  }

  if (action.itemIds?.length) {
    return uniqueExistingIds(action.itemIds, itemById)
  }

  const source = action.source

  switch (source) {
    case 'item_ids':
      return uniqueExistingIds(action.itemIds || [], itemById)
    case 'all_canvas':
      return state.items.map((item) => item.id)
    case 'current_selection':
      return uniqueExistingIds(Array.from(state.selectedIds), itemById)
    default:
      return []
  }
}
