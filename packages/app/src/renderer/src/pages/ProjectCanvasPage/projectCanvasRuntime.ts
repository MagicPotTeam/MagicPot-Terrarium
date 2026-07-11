import {
  attachCanvasSpatialIndexAccelerator,
  buildCanvasItemSpatialIndex,
  disposeCanvasSpatialIndex,
  doCanvasSpatialBoundsIntersect,
  queryCanvasSpatialIndex,
  queryCanvasSpatialIndexUnordered,
  type CanvasSpatialBounds,
  type CanvasSpatialIndex
} from './canvasSpatialIndex'
import { getCanvasItemBounds } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

export type CanvasPoint = {
  x: number
  y: number
}

export type CanvasViewport = {
  x: number
  y: number
  scale: number
}

export type CanvasStageSize = {
  width: number
  height: number
}

export type ProjectCanvasRuntimeHitTestOptions = {
  coordinateSpace?: 'canvas' | 'screen'
  includeHidden?: boolean
  canvasRadius?: number
  screenRadiusPx?: number
}

export type ProjectCanvasRuntimeMarqueeOptions = {
  coordinateSpace?: 'canvas' | 'screen'
  includeHidden?: boolean
}

export type ProjectCanvasRuntimePreviewUpdate = {
  id: string
  changes: Partial<CanvasItem>
}

export type ProjectCanvasRuntimeMetrics = {
  itemCount: number
  visibleItemCount: number
  previewItemCount: number
  indexedItemCount: number
}

export type ProjectCanvasRuntimeOptions = {
  getItemBounds?: (item: CanvasItem) => CanvasSpatialBounds
}

export type ProjectCanvasRuntimeCallback<T> = (runtime: ProjectCanvasRuntime) => T

export type ProjectCanvasRuntimeSnapshotOptions = {
  selectedIds?: Iterable<string>
  stageSize?: CanvasStageSize | null
  overscanPx?: number
}

export type ProjectCanvasRuntimeSnapshotItem = {
  id: string
  item: CanvasItem
  bounds: CanvasSpatialBounds
  order: number
  zIndex: number
  selected: boolean
  visibleInViewport: boolean
}

export type ProjectCanvasRuntimeSnapshot = {
  items: ProjectCanvasRuntimeSnapshotItem[]
  boundsById: Record<string, CanvasSpatialBounds>
  selectedIds: string[]
  viewport: CanvasViewport
  stageSize: CanvasStageSize | null
  metrics: ProjectCanvasRuntimeMetrics
}

export type ProjectCanvasRuntimeExportBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type ProjectCanvasRuntimeExportBoundsOptions = {
  itemIds?: Iterable<string>
  padding?: number
}

type CanvasItemWithVisibility = CanvasItem & {
  hidden?: boolean
  isHidden?: boolean
}

const DEFAULT_VIEWPORT: CanvasViewport = {
  x: 0,
  y: 0,
  scale: 1
}

function normalizeViewport(viewport: Partial<CanvasViewport>): CanvasViewport {
  const nextScale = viewport.scale ?? DEFAULT_VIEWPORT.scale

  return {
    x: viewport.x ?? DEFAULT_VIEWPORT.x,
    y: viewport.y ?? DEFAULT_VIEWPORT.y,
    scale: Number.isFinite(nextScale) && nextScale > 0 ? nextScale : DEFAULT_VIEWPORT.scale
  }
}

function cloneViewport(viewport: CanvasViewport): CanvasViewport {
  return { ...viewport }
}

function isCanvasItemHidden(item: CanvasItem): boolean {
  const candidate = item as CanvasItemWithVisibility
  return candidate.hidden === true || candidate.isHidden === true
}

function normalizeBounds(bounds: CanvasSpatialBounds): CanvasSpatialBounds {
  return {
    minX: Math.min(bounds.minX, bounds.maxX),
    minY: Math.min(bounds.minY, bounds.maxY),
    maxX: Math.max(bounds.minX, bounds.maxX),
    maxY: Math.max(bounds.minY, bounds.maxY)
  }
}

function sortCanvasItemsTopFirst(
  left: CanvasItem,
  right: CanvasItem,
  orderById: Map<string, number>
) {
  const zDelta = (right.zIndex ?? 0) - (left.zIndex ?? 0)
  if (zDelta !== 0) {
    return zDelta
  }

  return (orderById.get(right.id) ?? 0) - (orderById.get(left.id) ?? 0)
}

function applyPreviewUpdate(
  item: CanvasItem,
  update: ProjectCanvasRuntimePreviewUpdate
): CanvasItem {
  return {
    ...item,
    ...update.changes,
    id: item.id,
    type: item.type
  } as CanvasItem
}

export function screenToCanvasPoint(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale
  }
}

export function canvasToScreenPoint(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y
  }
}

export function screenToCanvasBounds(
  bounds: CanvasSpatialBounds,
  viewport: CanvasViewport
): CanvasSpatialBounds {
  const topLeft = screenToCanvasPoint({ x: bounds.minX, y: bounds.minY }, viewport)
  const bottomRight = screenToCanvasPoint({ x: bounds.maxX, y: bounds.maxY }, viewport)

  return normalizeBounds({
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y
  })
}

export function canvasToScreenBounds(
  bounds: CanvasSpatialBounds,
  viewport: CanvasViewport
): CanvasSpatialBounds {
  const topLeft = canvasToScreenPoint({ x: bounds.minX, y: bounds.minY }, viewport)
  const bottomRight = canvasToScreenPoint({ x: bounds.maxX, y: bounds.maxY }, viewport)

  return normalizeBounds({
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y
  })
}

function resolveCanvasItemsBounds(
  items: readonly CanvasItem[],
  getItemBounds: (item: CanvasItem) => CanvasSpatialBounds
) {
  if (items.length === 0) {
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const item of items) {
    const bounds = getItemBounds(item)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

function canvasSpatialBoundsToExportBounds(
  bounds: CanvasSpatialBounds,
  padding = 0
): ProjectCanvasRuntimeExportBounds | null {
  const normalized = normalizeBounds(bounds)
  if (
    !Number.isFinite(normalized.minX) ||
    !Number.isFinite(normalized.minY) ||
    !Number.isFinite(normalized.maxX) ||
    !Number.isFinite(normalized.maxY)
  ) {
    return null
  }

  const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0
  return {
    x: normalized.minX - safePadding,
    y: normalized.minY - safePadding,
    width: normalized.maxX - normalized.minX + safePadding * 2,
    height: normalized.maxY - normalized.minY + safePadding * 2
  }
}

export function getProjectCanvasRuntimeExportBounds(
  snapshot: ProjectCanvasRuntimeSnapshot,
  options: ProjectCanvasRuntimeExportBoundsOptions = {}
): ProjectCanvasRuntimeExportBounds | null {
  const idSet = options.itemIds ? new Set(options.itemIds) : null
  const targetItems = idSet ? snapshot.items.filter((entry) => idSet.has(entry.id)) : snapshot.items

  if (targetItems.length === 0) {
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const entry of targetItems) {
    minX = Math.min(minX, entry.bounds.minX)
    minY = Math.min(minY, entry.bounds.minY)
    maxX = Math.max(maxX, entry.bounds.maxX)
    maxY = Math.max(maxY, entry.bounds.maxY)
  }

  return canvasSpatialBoundsToExportBounds(
    {
      minX,
      minY,
      maxX,
      maxY
    },
    options.padding
  )
}

export function createProjectCanvasRuntime(options: ProjectCanvasRuntimeOptions = {}) {
  const getItemBounds = options.getItemBounds ?? getCanvasItemBounds
  let items: CanvasItem[] = []
  let viewport = cloneViewport(DEFAULT_VIEWPORT)
  let spatialIndex: CanvasSpatialIndex<CanvasItem> = buildCanvasItemSpatialIndex([], getItemBounds)
  let orderById = new Map<string, number>()
  let previewItems = new Map<string, CanvasItem>()

  const getEffectiveItems = () =>
    items.map((item) => {
      return previewItems.get(item.id) ?? item
    })

  const rebuildIndex = () => {
    const effectiveItems = getEffectiveItems()
    const previousSpatialIndex = spatialIndex
    spatialIndex = buildCanvasItemSpatialIndex(effectiveItems, getItemBounds)
    attachCanvasSpatialIndexAccelerator(spatialIndex)
    disposeCanvasSpatialIndex(previousSpatialIndex)
    orderById = new Map(effectiveItems.map((item, index) => [item.id, index]))
  }

  const resolvePoint = (
    point: CanvasPoint,
    coordinateSpace: 'canvas' | 'screen' = 'canvas'
  ): CanvasPoint => {
    return coordinateSpace === 'screen' ? screenToCanvasPoint(point, viewport) : { ...point }
  }

  const resolveBounds = (
    bounds: CanvasSpatialBounds,
    coordinateSpace: 'canvas' | 'screen' = 'canvas'
  ): CanvasSpatialBounds => {
    const normalized = normalizeBounds(bounds)
    return coordinateSpace === 'screen' ? screenToCanvasBounds(normalized, viewport) : normalized
  }

  const applyPreviewUpdates = (updates: readonly ProjectCanvasRuntimePreviewUpdate[]) => {
    const sourceById = new Map(items.map((item) => [item.id, item]))

    for (const update of updates) {
      const baseItem = previewItems.get(update.id) ?? sourceById.get(update.id)
      if (!baseItem) {
        continue
      }

      previewItems.set(update.id, applyPreviewUpdate(baseItem, update))
    }

    rebuildIndex()
  }

  const queryCanvasItems = (canvasBounds: CanvasSpatialBounds, includeHidden = false) => {
    return queryCanvasSpatialIndex(spatialIndex, canvasBounds)
      .filter((item) => includeHidden || !isCanvasItemHidden(item))
      .sort((left, right) => sortCanvasItemsTopFirst(left, right, orderById))
  }

  const queryCanvasItemsUnordered = (canvasBounds: CanvasSpatialBounds, includeHidden = false) => {
    const matchedItems = queryCanvasSpatialIndexUnordered(spatialIndex, canvasBounds)
    return includeHidden ? matchedItems : matchedItems.filter((item) => !isCanvasItemHidden(item))
  }

  const queryItems = (
    bounds: CanvasSpatialBounds,
    options: ProjectCanvasRuntimeMarqueeOptions = {}
  ) => queryCanvasItems(resolveBounds(bounds, options.coordinateSpace), options.includeHidden)

  const resolveHitTestBounds = (
    point: CanvasPoint,
    options: ProjectCanvasRuntimeHitTestOptions = {}
  ) => {
    const canvasPoint = resolvePoint(point, options.coordinateSpace)
    const safeScale = Math.max(Math.abs(viewport.scale), 0.0001)
    const radius = Math.max(options.canvasRadius ?? (options.screenRadiusPx ?? 0) / safeScale, 0)

    return {
      minX: canvasPoint.x - radius,
      minY: canvasPoint.y - radius,
      maxX: canvasPoint.x + radius,
      maxY: canvasPoint.y + radius
    }
  }

  const resolveViewportCanvasBounds = (
    stageSize: CanvasStageSize,
    overscanPx = 0
  ): CanvasSpatialBounds => {
    const safeOverscan = Number.isFinite(overscanPx) ? Math.max(0, overscanPx) : 0
    return screenToCanvasBounds(
      {
        minX: -safeOverscan,
        minY: -safeOverscan,
        maxX: Math.max(0, stageSize.width) + safeOverscan,
        maxY: Math.max(0, stageSize.height) + safeOverscan
      },
      viewport
    )
  }

  const getMetrics = (): ProjectCanvasRuntimeMetrics => {
    const effectiveItems = getEffectiveItems()

    return {
      itemCount: items.length,
      visibleItemCount: effectiveItems.filter((item) => !isCanvasItemHidden(item)).length,
      previewItemCount: previewItems.size,
      indexedItemCount: spatialIndex.entries.length
    }
  }

  return {
    setItems(nextItems: readonly CanvasItem[]) {
      items = [...nextItems]
      previewItems = new Map()
      rebuildIndex()
    },

    getItems() {
      return [...items]
    },

    getPreviewItems() {
      return getEffectiveItems()
    },

    setViewport(nextViewport: Partial<CanvasViewport>) {
      const normalizedViewport = normalizeViewport({ ...viewport, ...nextViewport })
      if (
        viewport.x === normalizedViewport.x &&
        viewport.y === normalizedViewport.y &&
        viewport.scale === normalizedViewport.scale
      ) {
        return
      }

      viewport = normalizedViewport
    },

    getViewport() {
      return cloneViewport(viewport)
    },

    screenToCanvas(point: CanvasPoint) {
      return screenToCanvasPoint(point, viewport)
    },

    canvasToScreen(point: CanvasPoint) {
      return canvasToScreenPoint(point, viewport)
    },

    hitTest(point: CanvasPoint, options: ProjectCanvasRuntimeHitTestOptions = {}) {
      return (
        queryCanvasItems(resolveHitTestBounds(point, options), options.includeHidden)[0] ?? null
      )
    },

    marqueeSelect(bounds: CanvasSpatialBounds, options: ProjectCanvasRuntimeMarqueeOptions = {}) {
      return queryItems(bounds, options).map((item) => item.id)
    },

    queryItems(bounds: CanvasSpatialBounds, options: ProjectCanvasRuntimeMarqueeOptions = {}) {
      return queryItems(bounds, options)
    },

    getVisibleItems(options: {
      stageSize: CanvasStageSize
      overscanPx?: number
      includeHidden?: boolean
      preserveOrder?: boolean
    }) {
      const canvasBounds = resolveViewportCanvasBounds(options.stageSize, options.overscanPx)
      return options.preserveOrder === false
        ? queryCanvasItemsUnordered(canvasBounds, options.includeHidden)
        : queryCanvasItems(canvasBounds, options.includeHidden)
    },

    getSelectionBounds(ids: Iterable<string>) {
      const idSet = new Set(ids)
      const targetItems = getEffectiveItems().filter((item) => idSet.has(item.id))
      return resolveCanvasItemsBounds(targetItems, getItemBounds)
    },

    beginPreview(updates: readonly ProjectCanvasRuntimePreviewUpdate[] = []) {
      previewItems = new Map()
      applyPreviewUpdates(updates)
    },

    updatePreview(updates: readonly ProjectCanvasRuntimePreviewUpdate[]) {
      applyPreviewUpdates(updates)
    },

    endPreview() {
      previewItems = new Map()
      rebuildIndex()
    },

    getMetrics(): ProjectCanvasRuntimeMetrics {
      return getMetrics()
    },

    dispose() {
      disposeCanvasSpatialIndex(spatialIndex)
      items = []
      previewItems = new Map()
      spatialIndex = buildCanvasItemSpatialIndex([], getItemBounds)
      orderById = new Map()
    },

    createSnapshot(
      options: ProjectCanvasRuntimeSnapshotOptions = {}
    ): ProjectCanvasRuntimeSnapshot {
      const selectedIdSet = new Set(options.selectedIds ?? [])
      const stageSize = options.stageSize ?? null
      const viewportBounds = stageSize
        ? resolveViewportCanvasBounds(stageSize, options.overscanPx)
        : null
      const boundsById: Record<string, CanvasSpatialBounds> = {}
      const snapshotItems = getEffectiveItems().map<ProjectCanvasRuntimeSnapshotItem>(
        (item, order) => {
          const bounds = getItemBounds(item)
          boundsById[item.id] = bounds
          return {
            id: item.id,
            item,
            bounds,
            order,
            zIndex: item.zIndex ?? 0,
            selected: selectedIdSet.has(item.id),
            visibleInViewport: viewportBounds
              ? doCanvasSpatialBoundsIntersect(bounds, viewportBounds)
              : true
          }
        }
      )

      return {
        items: snapshotItems,
        boundsById,
        selectedIds: [...selectedIdSet],
        viewport: cloneViewport(viewport),
        stageSize,
        metrics: getMetrics()
      }
    }
  }
}

export type ProjectCanvasRuntime = ReturnType<typeof createProjectCanvasRuntime>

export function withProjectCanvasRuntime<T>(
  callback: ProjectCanvasRuntimeCallback<T>,
  options?: ProjectCanvasRuntimeOptions
): T {
  const runtime = createProjectCanvasRuntime(options)
  try {
    return callback(runtime)
  } finally {
    runtime.dispose()
  }
}
