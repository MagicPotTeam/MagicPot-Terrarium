import type {
  CanvasTargetCanvasAction,
  CanvasTargetCanvasArrangement,
  CanvasTargetCanvasZOrder
} from './canvasTargetCapabilityTypes'
import { createCanvasItemId } from './canvasAssetDraftFactories'
import { removeCanvasItemsWithAttachedCaptions } from './canvasAttachedCaptionUtils'
import {
  getCanvasItemBounds,
  getCanvasItemsBounds,
  translateCanvasItem
} from './projectCanvasPageShared'
import type { CanvasGroup, CanvasItem } from './types'
import {
  buildFallbackResult,
  clampDuplicateCount,
  DEFAULT_ARRANGE_GAP,
  DEFAULT_DUPLICATE_OFFSET,
  getBoundsWidth,
  resolveNextZIndex
} from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetBounds,
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

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

export function duplicateCanvasItems(
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

export function arrangeCanvasItems(
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

export function transformCanvasItems(
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

export function setCanvasItemsZOrder(
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

export function deleteCanvasItems(
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

export function clearCanvas(
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

export function flipCanvasItems(
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
