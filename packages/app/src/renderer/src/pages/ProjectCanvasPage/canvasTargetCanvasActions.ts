import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import { buildFallbackResult } from './canvasTargetCanvasActionCore'
import { createCanvasAnnotation, createCanvasText } from './canvasTargetCanvasActionCreate'
import {
  createCanvasGroup,
  deleteCanvasGroup,
  renameCanvasGroup
} from './canvasTargetCanvasActionGroups'
import { cropCanvasImages } from './canvasTargetCanvasActionImages'
import {
  arrangeCanvasItems,
  clearCanvas,
  deleteCanvasItems,
  duplicateCanvasItems,
  flipCanvasItems,
  setCanvasItemsZOrder,
  transformCanvasItems
} from './canvasTargetCanvasActionLayout'
import {
  isCanvasTargetSemanticCanvasActionName,
  resolveCanvasTargetSemanticCanvasActionSourceIds
} from './canvasTargetCanvasActionSources'
import {
  setCanvasBackground,
  setCanvasGridVisibility,
  setCanvasToolState
} from './canvasTargetCanvasActionState'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'
import {
  setCanvasMediaPlayback,
  updateCanvasAnnotationItems,
  updateCanvasTextItems
} from './canvasTargetCanvasActionUpdates'

export type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'
export { resolveCropRectangleForImage } from './canvasTargetCanvasActionImages'
export {
  canvasTargetCanvasActionRequiresResolvedSource,
  canvasTargetSemanticCanvasActionRequiresResolvedSource,
  isCanvasTargetSemanticCanvasActionName,
  resolveCanvasTargetSemanticCanvasActionSourceIds
} from './canvasTargetCanvasActionSources'

export function executeCanvasTargetSemanticCanvasAction(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): CanvasTargetSemanticCanvasActionResult {
  if (!isCanvasTargetSemanticCanvasActionName(action.action)) {
    return buildFallbackResult(
      action,
      state,
      `Unsupported semantic canvas action: ${action.action}`
    )
  }

  const sourceIds = resolveCanvasTargetSemanticCanvasActionSourceIds(action, state)

  switch (action.action) {
    case 'add_text':
      return createCanvasText(action, state, sourceIds)
    case 'add_annotation':
      return createCanvasAnnotation(action, state, sourceIds)
    case 'select_items':
      if (sourceIds.length === 0) {
        return buildFallbackResult(action, state, 'No source items were available to select.')
      }
      return {
        items: state.items,
        selectedIds: new Set(sourceIds),
        nextZIndex: state.nextZIndex,
        affectedIds: sourceIds,
        createdIds: [],
        resultIds: sourceIds,
        content: `Selected ${sourceIds.length} canvas item(s).`,
        canvasDispatchCount: sourceIds.length
      }
    case 'duplicate_items':
      return duplicateCanvasItems(action, state, sourceIds)
    case 'arrange_items':
      return arrangeCanvasItems(action, state, sourceIds)
    case 'transform_items':
      return transformCanvasItems(action, state, sourceIds)
    case 'set_z_order':
      return setCanvasItemsZOrder(action, state, sourceIds)
    case 'delete_items':
      return deleteCanvasItems(action, state, sourceIds)
    case 'clear_canvas':
      return clearCanvas(action, state)
    case 'flip_items':
      return flipCanvasItems(action, state, sourceIds)
    case 'crop_image':
      return cropCanvasImages(action, state, sourceIds)
    case 'update_text':
      return updateCanvasTextItems(action, state, sourceIds)
    case 'update_annotation':
      return updateCanvasAnnotationItems(action, state, sourceIds)
    case 'set_media_playback':
      return setCanvasMediaPlayback(action, state, sourceIds)
    case 'create_group':
      return createCanvasGroup(action, state, sourceIds)
    case 'delete_group':
      return deleteCanvasGroup(action, state, sourceIds)
    case 'rename_group':
      return renameCanvasGroup(action, state, sourceIds)
    case 'focus_items':
      if (sourceIds.length === 0) {
        return buildFallbackResult(action, state, 'No source items were available to focus.')
      }
      return {
        items: state.items,
        selectedIds: new Set(sourceIds),
        nextZIndex: state.nextZIndex,
        affectedIds: sourceIds,
        createdIds: [],
        resultIds: sourceIds,
        content: `Focused ${sourceIds.length} canvas item(s).`,
        canvasDispatchCount: sourceIds.length
      }
    case 'set_canvas_background':
      return setCanvasBackground(action, state)
    case 'set_grid_visibility':
      return setCanvasGridVisibility(action, state)
    case 'set_canvas_tool':
      return setCanvasToolState(action, state)
    default:
      return buildFallbackResult(
        action,
        state,
        `Unsupported semantic canvas action: ${action.action}`
      )
  }
}
