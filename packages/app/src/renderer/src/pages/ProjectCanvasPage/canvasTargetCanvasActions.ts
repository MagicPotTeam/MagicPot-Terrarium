import type {
  CanvasTargetCanvasAction,
  CanvasTargetCanvasArrangement,
  CanvasTargetCanvasZOrder
} from './canvasTargetCapabilities'
import { createCanvasItemId, createCanvasTextItemDraft } from './canvasAssetDraftFactories'
import { measureCanvasTextBoxHeight, measureCanvasTextBoxSize } from './canvasTextLayout'
import { removeCanvasItemsWithAttachedCaptions } from './canvasAttachedCaptionUtils'
import {
  getCanvasItemBounds,
  getCanvasItemsBounds,
  translateCanvasItem
} from './projectCanvasPageShared'
import type { CanvasTool } from './projectCanvasPageShared'
import type {
  AnnotationShape,
  CanvasAnnotationItem,
  CanvasGroup,
  CanvasImageItem,
  CanvasItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

const DEFAULT_DUPLICATE_OFFSET = 36
const DEFAULT_ARRANGE_GAP = 24
const MAX_DUPLICATE_COUNT = 50
const DEFAULT_TEXT_COLOR = '#e0e0e0'
const DEFAULT_TEXT_FONT_FAMILY = 'system-ui, sans-serif'
const DEFAULT_TEXT_FONT_SIZE = 24
const DEFAULT_ANNOTATION_STROKE = '#ef4444'
const DEFAULT_ANNOTATION_STROKE_WIDTH = 2
const DEFAULT_ANNOTATION_FILL_OPACITY = 0
const DEFAULT_SOURCE_ITEM_GAP = 12

type CanvasTargetBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CanvasTargetSemanticCanvasActionState = {
  items: CanvasItem[]
  groups?: CanvasGroup[]
  selectedIds: Set<string>
  nextZIndex: number
  bgColor?: string
  showGrid?: boolean
  artifactCanvasItemIds?: Map<string, string[]>
  stageCanvasItemIds?: Map<string, string[]>
}

export type CanvasTargetSemanticCanvasActionResult = {
  items: CanvasItem[]
  selectedIds: Set<string>
  nextZIndex: number
  affectedIds: string[]
  createdIds: string[]
  resultIds: string[]
  content: string
  canvasDispatchCount: number
  fallbackReason?: string
  groups?: CanvasGroup[]
  bgColor?: string
  showGrid?: boolean
  tool?: CanvasTool
  annotationShape?: AnnotationShape
  annotationColor?: string
  annotationStrokeWidth?: number
  annotationFillOpacity?: number
}

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

const clampDuplicateCount = (value: number | undefined): number => {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_DUPLICATE_COUNT, Math.floor(value))
}

const resolveNextZIndex = (items: CanvasItem[], fallback: number): number => {
  const maxZIndex = items.reduce(
    (maxValue, item) => Math.max(maxValue, Number.isFinite(item.zIndex) ? item.zIndex : 0),
    0
  )
  return Math.max(fallback, maxZIndex + 1)
}

const uniqueExistingIds = (ids: string[], itemById: Map<string, CanvasItem>): string[] =>
  Array.from(new Set(ids.filter((id) => itemById.has(id))))

const normalizePositiveNumber = (value: number | undefined): number | undefined =>
  value != null && Number.isFinite(value) && value > 0 ? value : undefined

function getItemsByIds(items: CanvasItem[], ids: string[]): CanvasItem[] {
  const itemById = new Map(items.map((item) => [item.id, item] as const))
  return Array.from(new Set(ids)).flatMap((id) => {
    const item = itemById.get(id)
    return item ? [item] : []
  })
}

function getSourceBounds(
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetBounds | null {
  const sourceItems = getItemsByIds(state.items, sourceIds)
  return sourceItems.length > 0 ? getCanvasItemsBounds(sourceItems) : null
}

function getBoundsWidth(bounds: CanvasTargetBounds | null): number {
  return bounds ? Math.max(1, bounds.maxX - bounds.minX) : 0
}

function getBoundsHeight(bounds: CanvasTargetBounds | null): number {
  return bounds ? Math.max(1, bounds.maxY - bounds.minY) : 0
}

function resolveRectFromAction(
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

function buildFallbackResult(
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

function cloneCanvasItemForDuplicate(
  item: CanvasItem,
  copyIndex: number,
  nextZIndex: number,
  offsetX: number,
  offsetY: number
): CanvasItem {
  const cloneSeed = Date.now() + copyIndex
  const clone = {
    ...item,
    id: createCanvasItemId(item.type, cloneSeed),
    zIndex: nextZIndex
  } as CanvasItem

  return translateCanvasItem(clone, offsetX, offsetY)
}

function resolveDuplicateOffsets(
  action: CanvasTargetCanvasAction,
  sourceItems: CanvasItem[]
): { offsetX: number; offsetY: number } {
  if (action.offsetX != null || action.offsetY != null) {
    return {
      offsetX: action.offsetX ?? 0,
      offsetY: action.offsetY ?? 0
    }
  }

  const sourceBounds = getCanvasItemsBounds(sourceItems)
  const stepX = sourceBounds
    ? getBoundsWidth(sourceBounds) + DEFAULT_ARRANGE_GAP
    : DEFAULT_DUPLICATE_OFFSET
  return { offsetX: stepX, offsetY: 0 }
}

function duplicateCanvasItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  const sourceItems = state.items.filter((item) => sourceIdSet.has(item.id))
  if (sourceItems.length === 0) {
    return buildFallbackResult(action, state, 'No source items were available to duplicate.')
  }

  const count = clampDuplicateCount(action.count)
  const { offsetX, offsetY } = resolveDuplicateOffsets(action, sourceItems)
  let nextZIndex = resolveNextZIndex(state.items, state.nextZIndex)
  const createdItems: CanvasItem[] = []

  for (let copyIndex = 1; copyIndex <= count; copyIndex += 1) {
    for (const item of sourceItems) {
      createdItems.push(
        cloneCanvasItemForDuplicate(
          item,
          createdItems.length + 1,
          nextZIndex,
          offsetX * copyIndex,
          offsetY * copyIndex
        )
      )
      nextZIndex += 1
    }
  }

  const createdIds = createdItems.map((item) => item.id)
  const selectedIds =
    action.selectResult === false ? new Set(state.selectedIds) : new Set(createdIds)
  const nextItems = [...state.items, ...createdItems]

  return {
    items: nextItems,
    selectedIds,
    nextZIndex: resolveNextZIndex(nextItems, nextZIndex),
    affectedIds: sourceIds,
    createdIds,
    resultIds: createdIds,
    content: `Duplicated ${sourceItems.length} canvas item(s) into ${createdItems.length} new item(s).`,
    canvasDispatchCount: createdItems.length
  }
}

function resolveArrangeColumns(
  arrangement: CanvasTargetCanvasArrangement,
  itemCount: number,
  requestedColumns: number | undefined
): number {
  if (arrangement === 'column') return 1
  if (arrangement === 'row') return Math.max(1, itemCount)
  if (requestedColumns != null && Number.isFinite(requestedColumns) && requestedColumns > 0) {
    return Math.max(1, Math.min(itemCount, Math.floor(requestedColumns)))
  }
  return Math.max(1, Math.ceil(Math.sqrt(itemCount)))
}

function arrangeCanvasItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  const sourceItems = state.items.filter((item) => sourceIdSet.has(item.id))
  if (sourceItems.length === 0) {
    return buildFallbackResult(action, state, 'No source items were available to arrange.')
  }

  const groupBounds = getCanvasItemsBounds(sourceItems)
  if (!groupBounds) {
    return buildFallbackResult(action, state, 'Source item bounds could not be resolved.')
  }

  const arrangement = action.arrangement || 'grid'
  const columns = resolveArrangeColumns(arrangement, sourceItems.length, action.columns)
  const gapX = action.gapX ?? DEFAULT_ARRANGE_GAP
  const gapY = action.gapY ?? DEFAULT_ARRANGE_GAP
  const translations = new Map<string, { dx: number; dy: number }>()
  const startX = action.x ?? groupBounds.minX
  const startY = action.y ?? groupBounds.minY
  let cursorX = startX
  let cursorY = startY
  let rowHeight = 0

  sourceItems.forEach((item, index) => {
    if (index > 0 && index % columns === 0) {
      cursorX = startX
      cursorY += rowHeight + gapY
      rowHeight = 0
    }

    const itemBounds = getCanvasItemBounds(item)
    const width = Math.max(1, itemBounds.maxX - itemBounds.minX)
    const height = Math.max(1, itemBounds.maxY - itemBounds.minY)
    translations.set(item.id, {
      dx: cursorX - itemBounds.minX,
      dy: cursorY - itemBounds.minY
    })
    cursorX += width + gapX
    rowHeight = Math.max(rowHeight, height)
  })

  const nextItems = state.items.map((item) => {
    const translation = translations.get(item.id)
    return translation ? translateCanvasItem(item, translation.dx, translation.dy) : item
  })

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(sourceIds),
    nextZIndex: state.nextZIndex,
    affectedIds: sourceIds,
    createdIds: [],
    resultIds: sourceIds,
    content: `Arranged ${sourceItems.length} canvas item(s) as ${arrangement}.`,
    canvasDispatchCount: sourceItems.length
  }
}

const resolveTransformDelta = (
  action: CanvasTargetCanvasAction,
  bounds: CanvasTargetBounds
): { dx: number; dy: number } => {
  const absoluteDx = action.x != null ? action.x - bounds.minX : 0
  const absoluteDy = action.y != null ? action.y - bounds.minY : 0
  return {
    dx: absoluteDx + (action.deltaX ?? 0),
    dy: absoluteDy + (action.deltaY ?? 0)
  }
}

function transformCanvasItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  const sourceItems = state.items.filter((item) => sourceIdSet.has(item.id))
  if (sourceItems.length === 0) {
    return buildFallbackResult(action, state, 'No source items were available to transform.')
  }

  const groupBounds = getCanvasItemsBounds(sourceItems)
  if (!groupBounds) {
    return buildFallbackResult(action, state, 'Source item bounds could not be resolved.')
  }

  const { dx, dy } = resolveTransformDelta(action, groupBounds)
  const canApplySize = sourceItems.length === 1
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id)) return item

    const translated = dx || dy ? translateCanvasItem(item, dx, dy) : item
    return {
      ...translated,
      ...(canApplySize && action.width != null && action.width > 0 ? { width: action.width } : {}),
      ...(canApplySize && action.height != null && action.height > 0
        ? { height: action.height }
        : {}),
      ...(action.scaleX != null && action.scaleX > 0 ? { scaleX: action.scaleX } : {}),
      ...(action.scaleY != null && action.scaleY > 0 ? { scaleY: action.scaleY } : {}),
      ...(action.rotation != null ? { rotation: action.rotation } : {})
    } as CanvasItem
  })

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(sourceIds),
    nextZIndex: state.nextZIndex,
    affectedIds: sourceIds,
    createdIds: [],
    resultIds: sourceIds,
    content: `Transformed ${sourceItems.length} canvas item(s).`,
    canvasDispatchCount: sourceItems.length
  }
}

function normalizeZOrderItems(
  items: CanvasItem[],
  selectedIds: Set<string>,
  mode: 'front' | 'back'
) {
  const sorted = [...items].sort((a, b) => a.zIndex - b.zIndex)
  const selected = sorted.filter((item) => selectedIds.has(item.id))
  const unselected = sorted.filter((item) => !selectedIds.has(item.id))
  const ordered = mode === 'front' ? [...unselected, ...selected] : [...selected, ...unselected]
  const zIndexById = new Map<string, number>()
  ordered.forEach((item, index) => zIndexById.set(item.id, index + 1))
  return items.map((item) => ({ ...item, zIndex: zIndexById.get(item.id) ?? item.zIndex }))
}

function stepZOrderItems(
  items: CanvasItem[],
  selectedIds: Set<string>,
  mode: Extract<CanvasTargetCanvasZOrder, 'forward' | 'backward'>
): CanvasItem[] {
  const sorted = [...items].sort((a, b) => a.zIndex - b.zIndex)

  if (mode === 'forward') {
    for (let index = sorted.length - 2; index >= 0; index -= 1) {
      if (selectedIds.has(sorted[index].id) && !selectedIds.has(sorted[index + 1].id)) {
        const next = sorted[index + 1]
        sorted[index + 1] = sorted[index]
        sorted[index] = next
      }
    }
  } else {
    for (let index = 1; index < sorted.length; index += 1) {
      if (selectedIds.has(sorted[index].id) && !selectedIds.has(sorted[index - 1].id)) {
        const prev = sorted[index - 1]
        sorted[index - 1] = sorted[index]
        sorted[index] = prev
      }
    }
  }

  const zIndexById = new Map<string, number>()
  sorted.forEach((item, index) => zIndexById.set(item.id, index + 1))
  return items.map((item) => ({ ...item, zIndex: zIndexById.get(item.id) ?? item.zIndex }))
}

function setCanvasItemsZOrder(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  if (sourceIdSet.size === 0) {
    return buildFallbackResult(action, state, 'No source items were available for z-order.')
  }

  const zOrder = action.zOrder || 'front'
  const nextItems =
    zOrder === 'front' || zOrder === 'back'
      ? normalizeZOrderItems(state.items, sourceIdSet, zOrder)
      : stepZOrderItems(state.items, sourceIdSet, zOrder)

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(sourceIds),
    nextZIndex: resolveNextZIndex(nextItems, state.nextZIndex),
    affectedIds: sourceIds,
    createdIds: [],
    resultIds: sourceIds,
    content: `Updated z-order for ${sourceIds.length} canvas item(s).`,
    canvasDispatchCount: sourceIds.length
  }
}

function pruneCanvasGroupsByDeletedIds(
  groups: CanvasGroup[] | undefined,
  deletedIds: Set<string>
): CanvasGroup[] {
  if (!groups) return []
  return groups
    .map((group) => ({
      ...group,
      itemIds: group.itemIds.filter((itemId) => !deletedIds.has(itemId))
    }))
    .filter((group) => group.itemIds.length > 0)
}

function deleteCanvasItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  if (sourceIds.length === 0) {
    return buildFallbackResult(action, state, 'No source items were available to delete.')
  }

  const { deletedIds, nextItems } = removeCanvasItemsWithAttachedCaptions(state.items, sourceIds)
  const nextGroups = pruneCanvasGroupsByDeletedIds(state.groups, deletedIds)
  const selectedIds = new Set(
    Array.from(state.selectedIds).filter((selectedId) => !deletedIds.has(selectedId))
  )
  const affectedIds = Array.from(deletedIds)

  return {
    items: nextItems,
    groups: nextGroups,
    selectedIds,
    nextZIndex: resolveNextZIndex(nextItems, state.nextZIndex),
    affectedIds,
    createdIds: [],
    resultIds: [],
    content: `Deleted ${affectedIds.length} canvas item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}

function clearCanvas(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState
): CanvasTargetSemanticCanvasActionResult {
  if (!action.explicitUserIntent) {
    return buildFallbackResult(
      action,
      state,
      'clear_canvas requires explicit user intent because it removes all canvas content.'
    )
  }

  return {
    items: [],
    groups: [],
    selectedIds: new Set(),
    nextZIndex: 1,
    affectedIds: state.items.map((item) => item.id),
    createdIds: [],
    resultIds: [],
    content: `Cleared ${state.items.length} canvas item(s).`,
    canvasDispatchCount: state.items.length
  }
}

function flipCanvasItem(item: CanvasItem, axis: 'horizontal' | 'vertical'): CanvasItem {
  const rotationRad = (item.rotation * Math.PI) / 180
  const cos = Math.cos(rotationRad)
  const sin = Math.sin(rotationRad)
  const rotatePoint = (x: number, y: number) => ({
    x: x * cos - y * sin,
    y: x * sin + y * cos
  })

  const currentCenterOffset = rotatePoint(
    (item.width * item.scaleX) / 2,
    (item.height * item.scaleY) / 2
  )
  const worldCenter = {
    x: item.x + currentCenterOffset.x,
    y: item.y + currentCenterOffset.y
  }
  const nextScaleX = axis === 'horizontal' ? item.scaleX * -1 : item.scaleX
  const nextScaleY = axis === 'vertical' ? item.scaleY * -1 : item.scaleY
  const nextCenterOffset = rotatePoint(
    (item.width * nextScaleX) / 2,
    (item.height * nextScaleY) / 2
  )

  return {
    ...item,
    scaleX: nextScaleX,
    scaleY: nextScaleY,
    x: worldCenter.x - nextCenterOffset.x,
    y: worldCenter.y - nextCenterOffset.y
  } as CanvasItem
}

function flipCanvasItems(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  if (sourceIdSet.size === 0) {
    return buildFallbackResult(action, state, 'No source items were available to flip.')
  }

  const axis = action.flipAxis || 'horizontal'
  const nextItems = state.items.map((item) =>
    sourceIdSet.has(item.id) ? flipCanvasItem(item, axis) : item
  )

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(sourceIds),
    nextZIndex: state.nextZIndex,
    affectedIds: sourceIds,
    createdIds: [],
    resultIds: sourceIds,
    content: `Flipped ${sourceIds.length} canvas item(s) ${axis}.`,
    canvasDispatchCount: sourceIds.length
  }
}

function createCanvasText(
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

function createCanvasAnnotation(
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

function resolveImageAssetDimension(
  image: CanvasImageItem['image'] | undefined,
  dimension: 'width' | 'height'
): number | undefined {
  if (!image) return undefined
  const asset = image as {
    width?: number
    height?: number
    naturalWidth?: number
    naturalHeight?: number
  }
  const direct = dimension === 'width' ? asset.width : asset.height
  const natural = dimension === 'width' ? asset.naturalWidth : asset.naturalHeight
  const value = direct ?? natural
  return value != null && Number.isFinite(value) && value > 0 ? value : undefined
}

function resolveImageSourceSize(item: CanvasImageItem): { width: number; height: number } {
  return {
    width:
      normalizePositiveNumber(item.sourceWidth) ??
      resolveImageAssetDimension(item.image, 'width') ??
      normalizePositiveNumber(item.crop?.width) ??
      Math.max(1, item.width),
    height:
      normalizePositiveNumber(item.sourceHeight) ??
      resolveImageAssetDimension(item.image, 'height') ??
      normalizePositiveNumber(item.crop?.height) ??
      Math.max(1, item.height)
  }
}

export function resolveCropRectangleForImage(
  action: CanvasTargetCanvasAction,
  item: CanvasImageItem
): { x: number; y: number; width: number; height: number } | null {
  const sourceSize = resolveImageSourceSize(item)
  const currentCrop = item.crop || {
    x: 0,
    y: 0,
    width: sourceSize.width,
    height: sourceSize.height
  }
  const rawX = action.cropX ?? action.x
  const rawY = action.cropY ?? action.y
  const rawWidth = action.cropWidth ?? action.width
  const rawHeight = action.cropHeight ?? action.height
  if (
    rawX == null ||
    rawY == null ||
    rawWidth == null ||
    rawHeight == null ||
    rawWidth <= 0 ||
    rawHeight <= 0
  ) {
    return null
  }

  let cropX = rawX
  let cropY = rawY
  let cropWidth = rawWidth
  let cropHeight = rawHeight
  const coordinateSpace = action.coordinateSpace
  if (!coordinateSpace) {
    return null
  }

  if (coordinateSpace === 'source_item_normalized') {
    cropX = currentCrop.x + rawX * currentCrop.width
    cropY = currentCrop.y + rawY * currentCrop.height
    cropWidth = rawWidth * currentCrop.width
    cropHeight = rawHeight * currentCrop.height
  } else if (coordinateSpace === 'source_image_pixels') {
    cropX = rawX
    cropY = rawY
    cropWidth = rawWidth
    cropHeight = rawHeight
  } else if (coordinateSpace === 'source_item' || coordinateSpace === 'canvas') {
    const displayToSourceScaleX = currentCrop.width / Math.max(1, item.width)
    const displayToSourceScaleY = currentCrop.height / Math.max(1, item.height)
    const localX = coordinateSpace === 'canvas' ? rawX - item.x : rawX
    const localY = coordinateSpace === 'canvas' ? rawY - item.y : rawY
    cropX = currentCrop.x + localX * displayToSourceScaleX
    cropY = currentCrop.y + localY * displayToSourceScaleY
    cropWidth = rawWidth * displayToSourceScaleX
    cropHeight = rawHeight * displayToSourceScaleY
  }

  const clampedX = Math.max(0, Math.min(sourceSize.width - 1, cropX))
  const clampedY = Math.max(0, Math.min(sourceSize.height - 1, cropY))
  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(1, Math.min(sourceSize.width - clampedX, cropWidth)),
    height: Math.max(1, Math.min(sourceSize.height - clampedY, cropHeight))
  }
}

function rotateVector(
  vector: { x: number; y: number },
  rotation: number
): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos
  }
}

function applyCropToCanvasImageItem(
  item: CanvasImageItem,
  crop: { x: number; y: number; width: number; height: number }
): CanvasImageItem {
  const sourceSize = resolveImageSourceSize(item)
  const currentCrop = item.crop || {
    x: 0,
    y: 0,
    width: sourceSize.width,
    height: sourceSize.height
  }
  const sourceCropScaleX = item.width / Math.max(1, currentCrop.width)
  const sourceCropScaleY = item.height / Math.max(1, currentCrop.height)
  const localX = crop.x - currentCrop.x
  const localY = crop.y - currentCrop.y
  const rotatedOffset = rotateVector(
    {
      x: localX * item.scaleX * sourceCropScaleX,
      y: localY * item.scaleY * sourceCropScaleY
    },
    item.rotation
  )

  return {
    ...item,
    x: item.x + rotatedOffset.x,
    y: item.y + rotatedOffset.y,
    width: crop.width,
    height: crop.height,
    scaleX: item.scaleX * sourceCropScaleX,
    scaleY: item.scaleY * sourceCropScaleY,
    crop
  }
}

function cropCanvasImages(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  const affectedIds: string[] = []
  let missingCropRectangle = false
  let missingCoordinateSpace = false
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id) || item.type !== 'image') return item
    if (!action.coordinateSpace) {
      missingCoordinateSpace = true
      return item
    }
    const crop = resolveCropRectangleForImage(action, item)
    if (!crop) {
      missingCropRectangle = true
      return item
    }
    affectedIds.push(item.id)
    return applyCropToCanvasImageItem(item, crop)
  })

  if (affectedIds.length === 0) {
    const fallbackReason = missingCoordinateSpace
      ? 'Missing coordinateSpace for crop_image. The control model must explicitly choose canvas, source_item, source_item_normalized, or source_image_pixels.'
      : missingCropRectangle
        ? 'Missing a valid crop rectangle for crop_image.'
        : 'No image items were available to crop.'
    return buildFallbackResult(action, state, fallbackReason)
  }

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(affectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds,
    createdIds: [],
    resultIds: affectedIds,
    content: `Cropped ${affectedIds.length} image item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}

function updateCanvasTextItems(
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

function clampAnnotationFillOpacity(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function updateCanvasAnnotationItems(
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

function setCanvasMediaPlayback(
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

function createCanvasGroup(
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

function deleteCanvasGroup(
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

function renameCanvasGroup(
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

function setCanvasBackground(
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

function setCanvasGridVisibility(
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

function setCanvasToolState(
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
