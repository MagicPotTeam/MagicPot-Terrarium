import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import { getCanvasItemsBounds } from './projectCanvasPageShared'
import type { CanvasItem } from './types'
import type {
  CanvasTargetBounds,
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

export const DEFAULT_DUPLICATE_OFFSET = 36
export const DEFAULT_ARRANGE_GAP = 24
export const MAX_DUPLICATE_COUNT = 50
export const DEFAULT_TEXT_COLOR = '#e0e0e0'
export const DEFAULT_TEXT_FONT_FAMILY = 'system-ui, sans-serif'
export const DEFAULT_TEXT_FONT_SIZE = 24
export const DEFAULT_ANNOTATION_STROKE = '#ef4444'
export const DEFAULT_ANNOTATION_STROKE_WIDTH = 2
export const DEFAULT_ANNOTATION_FILL_OPACITY = 0
export const DEFAULT_SOURCE_ITEM_GAP = 12

export const clampDuplicateCount = (value: number | undefined): number => {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_DUPLICATE_COUNT, Math.floor(value))
}

export const resolveNextZIndex = (items: CanvasItem[], fallback: number): number => {
  const maxZIndex = items.reduce(
    (maxValue, item) => Math.max(maxValue, Number.isFinite(item.zIndex) ? item.zIndex : 0),
    0
  )
  return Math.max(fallback, maxZIndex + 1)
}

export const uniqueExistingIds = (ids: string[], itemById: Map<string, CanvasItem>): string[] =>
  Array.from(new Set(ids.filter((id) => itemById.has(id))))

export const normalizePositiveNumber = (value: number | undefined): number | undefined =>
  value != null && Number.isFinite(value) && value > 0 ? value : undefined

export function getItemsByIds(items: CanvasItem[], ids: string[]): CanvasItem[] {
  const itemById = new Map(items.map((item) => [item.id, item] as const))
  return Array.from(new Set(ids)).flatMap((id) => {
    const item = itemById.get(id)
    return item ? [item] : []
  })
}

export function getSourceBounds(
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetBounds | null {
  const sourceItems = getItemsByIds(state.items, sourceIds)
  return sourceItems.length > 0 ? getCanvasItemsBounds(sourceItems) : null
}

export function getBoundsWidth(bounds: CanvasTargetBounds | null): number {
  return bounds ? Math.max(1, bounds.maxX - bounds.minX) : 0
}

export function getBoundsHeight(bounds: CanvasTargetBounds | null): number {
  return bounds ? Math.max(1, bounds.maxY - bounds.minY) : 0
}

export function resolveRectFromAction(
  action: CanvasTargetCanvasAction,
  sourceBounds: CanvasTargetBounds | null,
  fallback: {
    x: number
    y: number
    width: number
    height: number
  }
): { x: number; y: number; width: number; height: number } {
  const boundsWidth = getBoundsWidth(sourceBounds)
  const boundsHeight = getBoundsHeight(sourceBounds)
  const rawX = action.x
  const rawY = action.y
  const rawWidth = normalizePositiveNumber(action.width)
  const rawHeight = normalizePositiveNumber(action.height)
  const usesStageSource = Boolean(action.sourceStageId || action.sourceStageIds?.length)
  const looksNormalizedSourceRect =
    usesStageSource &&
    rawX != null &&
    rawY != null &&
    rawWidth != null &&
    rawHeight != null &&
    rawX >= 0 &&
    rawX <= 1 &&
    rawY >= 0 &&
    rawY <= 1 &&
    rawWidth > 0 &&
    rawWidth <= 1 &&
    rawHeight > 0 &&
    rawHeight <= 1
  const coordinateSpace =
    action.coordinateSpace ||
    (sourceBounds && usesStageSource
      ? looksNormalizedSourceRect
        ? 'source_item_normalized'
        : 'source_item'
      : 'canvas')

  if (sourceBounds && coordinateSpace === 'source_item_normalized') {
    return {
      x: sourceBounds.minX + (rawX ?? 0) * boundsWidth,
      y: sourceBounds.minY + (rawY ?? 0) * boundsHeight,
      width: rawWidth != null ? rawWidth * boundsWidth : fallback.width,
      height: rawHeight != null ? rawHeight * boundsHeight : fallback.height
    }
  }

  if (sourceBounds && coordinateSpace === 'source_item') {
    return {
      x: sourceBounds.minX + (rawX ?? 0),
      y: sourceBounds.minY + (rawY ?? 0),
      width: rawWidth ?? fallback.width,
      height: rawHeight ?? fallback.height
    }
  }

  return {
    x: rawX ?? fallback.x,
    y: rawY ?? fallback.y,
    width: rawWidth ?? fallback.width,
    height: rawHeight ?? fallback.height
  }
}

export function buildFallbackResult(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  reason: string
): CanvasTargetSemanticCanvasActionResult {
  return {
    items: state.items,
    selectedIds: new Set(state.selectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds: [],
    createdIds: [],
    resultIds: [],
    content: `Canvas ${action.action} action skipped. ${reason}`,
    canvasDispatchCount: 0,
    fallbackReason: reason
  }
}

export function clampAnnotationFillOpacity(value: number): number {
  return Math.min(1, Math.max(0, value))
}
