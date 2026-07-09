import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import type { CanvasTool } from './projectCanvasPageShared'
import type { AnnotationShape } from './types'
import { buildFallbackResult, clampAnnotationFillOpacity } from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

export function setCanvasBackground(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): CanvasTargetSemanticCanvasActionResult {
  if (!action.bgColor?.trim()) {
    return buildFallbackResult(action, state, 'Missing bgColor for set_canvas_background.')
  }

  return {
    items: state.items,
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: [],
    createdIds: [],
    resultIds: [],
    bgColor: action.bgColor,
    content: `Set canvas background to ${action.bgColor}.`,
    canvasDispatchCount: 1
  }
}

export function setCanvasGridVisibility(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): CanvasTargetSemanticCanvasActionResult {
  if (action.showGrid == null) {
    return buildFallbackResult(action, state, 'Missing showGrid for set_grid_visibility.')
  }

  return {
    items: state.items,
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: [],
    createdIds: [],
    resultIds: [],
    showGrid: action.showGrid,
    content: `${action.showGrid ? 'Showed' : 'Hid'} the canvas grid.`,
    canvasDispatchCount: 1
  }
}

export function setCanvasToolState(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): CanvasTargetSemanticCanvasActionResult {
  const tool = action.tool || (action.annotationShape ? 'annotate' : undefined)
  const annotationColor = action.stroke || action.color
  if (
    !tool &&
    !action.annotationShape &&
    !annotationColor &&
    action.strokeWidth == null &&
    action.fillOpacity == null
  ) {
    return buildFallbackResult(action, state, 'Missing tool or annotation defaults.')
  }

  return {
    items: state.items,
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: [],
    createdIds: [],
    resultIds: [],
    ...(tool ? { tool: tool as CanvasTool } : {}),
    ...(action.annotationShape
      ? { annotationShape: action.annotationShape as AnnotationShape }
      : {}),
    ...(annotationColor ? { annotationColor } : {}),
    ...(action.strokeWidth != null && action.strokeWidth > 0
      ? { annotationStrokeWidth: action.strokeWidth }
      : {}),
    ...(action.fillOpacity != null
      ? { annotationFillOpacity: clampAnnotationFillOpacity(action.fillOpacity) }
      : {}),
    content: 'Updated canvas tool state.',
    canvasDispatchCount: 1
  }
}
