import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import type {
  AnnotationShape,
  CanvasAnnotationItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import { buildFallbackResult, clampAnnotationFillOpacity } from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

export function updateCanvasTextItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const hasPatch =
    action.text != null ||
    action.color != null ||
    action.fill != null ||
    action.fontSize != null ||
    action.fontWeight != null
  if (!hasPatch) {
    return buildFallbackResult(action, state, 'No text content or style fields were provided.')
  }

  const sourceIdSet = new Set(sourceIds)
  const affectedIds: string[] = []
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id) || item.type !== 'text') return item
    affectedIds.push(item.id)
    return {
      ...item,
      ...(action.text != null ? { text: action.text } : {}),
      ...(action.color || action.fill ? { fill: action.fill || action.color || item.fill } : {}),
      ...(action.fontSize != null && action.fontSize > 0 ? { fontSize: action.fontSize } : {}),
      ...(action.fontWeight ? { fontWeight: action.fontWeight } : {})
    } satisfies CanvasTextItem
  })

  if (affectedIds.length === 0) {
    return buildFallbackResult(action, state, 'No text items were available to update.')
  }

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(affectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds,
    createdIds: [],
    resultIds: affectedIds,
    content: `Updated ${affectedIds.length} text item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}

export function updateCanvasAnnotationItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const hasPatch =
    action.text != null ||
    action.itemLabel != null ||
    action.annotationShape != null ||
    action.color != null ||
    action.stroke != null ||
    action.strokeWidth != null ||
    action.fillOpacity != null ||
    action.fontSize != null ||
    action.fontWeight != null
  if (!hasPatch) {
    return buildFallbackResult(action, state, 'No annotation fields were provided.')
  }

  const sourceIdSet = new Set(sourceIds)
  const affectedIds: string[] = []
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id) || item.type !== 'annotation') return item
    affectedIds.push(item.id)
    return {
      ...item,
      ...(action.annotationShape ? { shape: action.annotationShape as AnnotationShape } : {}),
      ...(action.stroke || action.color
        ? { stroke: action.stroke || action.color || item.stroke }
        : {}),
      ...(action.fillOpacity != null
        ? { fillOpacity: clampAnnotationFillOpacity(action.fillOpacity) }
        : {}),
      ...(action.strokeWidth != null && action.strokeWidth > 0
        ? { strokeWidth: action.strokeWidth }
        : {}),
      ...(action.itemLabel != null ? { label: action.itemLabel } : {}),
      ...(action.text != null ? { text: action.text } : {}),
      ...(action.fontSize != null && action.fontSize > 0 ? { fontSize: action.fontSize } : {}),
      ...(action.fontWeight ? { fontWeight: action.fontWeight } : {})
    } satisfies CanvasAnnotationItem
  })

  if (affectedIds.length === 0) {
    return buildFallbackResult(action, state, 'No annotation items were available to update.')
  }

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(affectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds,
    createdIds: [],
    resultIds: affectedIds,
    content: `Updated ${affectedIds.length} annotation item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}

export function setCanvasMediaPlayback(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const hasPatch = action.playing != null || action.muted != null || action.volume != null
  if (!hasPatch) {
    return buildFallbackResult(action, state, 'No media playback fields were provided.')
  }

  const sourceIdSet = new Set(sourceIds)
  const affectedIds: string[] = []
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id) || item.type !== 'video') return item
    affectedIds.push(item.id)
    return {
      ...item,
      ...(action.playing != null ? { playing: action.playing } : {}),
      ...(action.muted != null ? { muted: action.muted } : {}),
      ...(action.volume != null ? { volume: action.volume } : {})
    } satisfies CanvasVideoItem
  })

  if (affectedIds.length === 0) {
    return buildFallbackResult(action, state, 'No video items were available to update.')
  }

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(affectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds,
    createdIds: [],
    resultIds: affectedIds,
    content: `Updated playback state for ${affectedIds.length} video item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}
