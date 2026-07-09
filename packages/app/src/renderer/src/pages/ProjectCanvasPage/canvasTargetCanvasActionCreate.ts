import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import { createCanvasItemId, createCanvasTextItemDraft } from './canvasAssetDraftFactories'
import { measureCanvasTextBoxHeight, measureCanvasTextBoxSize } from './canvasTextLayout'
import type { AnnotationShape, CanvasAnnotationItem } from './types'
import {
  buildFallbackResult,
  clampAnnotationFillOpacity,
  DEFAULT_ANNOTATION_FILL_OPACITY,
  DEFAULT_ANNOTATION_STROKE,
  DEFAULT_ANNOTATION_STROKE_WIDTH,
  DEFAULT_SOURCE_ITEM_GAP,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_SIZE,
  getBoundsHeight,
  getBoundsWidth,
  getSourceBounds,
  normalizePositiveNumber,
  resolveNextZIndex,
  resolveRectFromAction
} from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

export function createCanvasText(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const text = action.text?.trim()
  if (!text) {
    return buildFallbackResult(action, state, 'Missing text for add_text.')
  }

  const sourceBounds = getSourceBounds(state, sourceIds)
  const fontSize = normalizePositiveNumber(action.fontSize) ?? DEFAULT_TEXT_FONT_SIZE
  const fontFamily = DEFAULT_TEXT_FONT_FAMILY
  const textMeasureOptions = {
    text,
    fontSize,
    fontFamily,
    ...(action.fontWeight ? { fontWeight: action.fontWeight } : {})
  }
  const measuredNaturalSize = measureCanvasTextBoxSize(textMeasureOptions)
  const sourceWidth = getBoundsWidth(sourceBounds)
  const requestedWidth = normalizePositiveNumber(action.width)
  const width =
    requestedWidth ?? (sourceWidth > 0 ? Math.max(120, sourceWidth) : measuredNaturalSize.width)
  const height =
    normalizePositiveNumber(action.height) ??
    measureCanvasTextBoxHeight({
      text,
      width,
      fontSize,
      fontFamily,
      ...(action.fontWeight ? { fontWeight: action.fontWeight } : {})
    })
  const fallbackRect = sourceBounds
    ? {
        x: sourceBounds.minX,
        y: sourceBounds.maxY + DEFAULT_SOURCE_ITEM_GAP,
        width,
        height
      }
    : {
        x: 0,
        y: 0,
        width,
        height
      }
  const rect = resolveRectFromAction(action, sourceBounds, fallbackRect)
  const zIndex = resolveNextZIndex(state.items, state.nextZIndex)
  const createdItem = createCanvasTextItemDraft({
    id: createCanvasItemId('text'),
    text,
    fontSize,
    fontFamily,
    fill: action.fill || action.color || DEFAULT_TEXT_COLOR,
    ...(action.fontWeight ? { fontWeight: action.fontWeight } : {}),
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    rotation: action.rotation ?? 0,
    scaleX: action.scaleX ?? 1,
    scaleY: action.scaleY ?? 1,
    zIndex,
    locked: false
  })
  const nextItems = [...state.items, createdItem]

  return {
    items: nextItems,
    selectedIds:
      action.selectResult === false ? new Set(state.selectedIds) : new Set([createdItem.id]),
    nextZIndex: resolveNextZIndex(nextItems, zIndex + 1),
    affectedIds: sourceIds,
    createdIds: [createdItem.id],
    resultIds: [createdItem.id],
    content: `Created text item "${text}".`,
    canvasDispatchCount: 1
  }
}

export function createCanvasAnnotation(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceBounds = getSourceBounds(state, sourceIds)
  const sourceWidth = getBoundsWidth(sourceBounds)
  const sourceHeight = getBoundsHeight(sourceBounds)
  const fallbackRect = sourceBounds
    ? {
        x: sourceBounds.minX,
        y: sourceBounds.minY,
        width: sourceWidth,
        height: sourceHeight
      }
    : {
        x: action.x ?? 0,
        y: action.y ?? 0,
        width: normalizePositiveNumber(action.width) ?? 120,
        height: normalizePositiveNumber(action.height) ?? 80
      }
  const rect = resolveRectFromAction(action, sourceBounds, fallbackRect)
  if (rect.width <= 0 || rect.height <= 0) {
    return buildFallbackResult(
      action,
      state,
      'Missing a valid annotation rectangle for add_annotation.'
    )
  }

  const shape = (action.annotationShape || 'rect') as AnnotationShape
  const zIndex = resolveNextZIndex(state.items, state.nextZIndex)
  const createdItem: CanvasAnnotationItem = {
    id: createCanvasItemId('anno'),
    type: 'annotation',
    shape,
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    rotation: action.rotation ?? 0,
    scaleX: action.scaleX ?? 1,
    scaleY: action.scaleY ?? 1,
    zIndex,
    locked: false,
    stroke: action.stroke || action.color || DEFAULT_ANNOTATION_STROKE,
    fillOpacity:
      action.fillOpacity != null
        ? clampAnnotationFillOpacity(action.fillOpacity)
        : DEFAULT_ANNOTATION_FILL_OPACITY,
    strokeWidth: normalizePositiveNumber(action.strokeWidth) ?? DEFAULT_ANNOTATION_STROKE_WIDTH,
    label: action.itemLabel || '',
    ...(action.text != null ? { text: action.text } : {}),
    ...(action.fontSize != null && action.fontSize > 0 ? { fontSize: action.fontSize } : {}),
    ...(action.fontWeight ? { fontWeight: action.fontWeight } : {})
  }
  const nextItems = [...state.items, createdItem]

  return {
    items: nextItems,
    selectedIds:
      action.selectResult === false ? new Set(state.selectedIds) : new Set([createdItem.id]),
    nextZIndex: resolveNextZIndex(nextItems, zIndex + 1),
    affectedIds: sourceIds,
    createdIds: [createdItem.id],
    resultIds: [createdItem.id],
    content: `Created ${shape} annotation.`,
    canvasDispatchCount: 1
  }
}
