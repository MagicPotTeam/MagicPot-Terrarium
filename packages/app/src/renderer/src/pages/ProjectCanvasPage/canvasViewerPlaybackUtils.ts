import {
  buildCanvasItemSpatialIndex,
  queryCanvasSpatialIndex,
  type CanvasSpatialIndex
} from './canvasSpatialIndex'
import { getCanvasItemBounds } from './projectCanvasPageShared'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from './projectCanvasViewportScale'
import type { CanvasHtmlItem, CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'

export const CANVAS_TEXTURE_IMPORT_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.tga',
  '.dds',
  '.hdr',
  '.exr',
  '.webp',
  '.gif',
  '.tiff',
  '.mtl',
  '.mat'
] as const

export type CanvasViewportState = {
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number } | null
}

export type PlaybackVisibilityInput = CanvasViewportState & {
  forceRenderAllItemsForExport?: boolean
  groupPlaybackItemIds?: readonly string[] | null
  selectedIds: ReadonlySet<string>
  sortedItems: CanvasItem[]
  itemById?: ReadonlyMap<string, CanvasItem> | null
  itemOrderById?: ReadonlyMap<string, number> | null
  spatialIndex?: CanvasSpatialIndex<CanvasItem> | null
}

export function buildCanvasPlaybackVisibilitySpatialIndex({
  groupPlaybackItemIds,
  sortedItems
}: {
  groupPlaybackItemIds?: readonly string[] | null
  sortedItems: CanvasItem[]
}) {
  const playbackItemIdSet = new Set(groupPlaybackItemIds ?? [])

  return buildCanvasItemSpatialIndex(
    sortedItems.filter((item) => !playbackItemIdSet.has(item.id)),
    (item) => {
      const bounds = getCanvasItemBounds(item)
      return {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY
      }
    }
  )
}

export function resolveVisibleCanvasItems({
  forceRenderAllItemsForExport = false,
  groupPlaybackItemIds,
  itemById,
  itemOrderById,
  selectedIds,
  sortedItems,
  spatialIndex,
  stagePos,
  stageScale,
  stageSize
}: PlaybackVisibilityInput): CanvasItem[] {
  if (forceRenderAllItemsForExport) return sortedItems

  const playbackItemIdSet = new Set(groupPlaybackItemIds ?? [])
  const resolvedItemById =
    itemById ?? new Map<string, CanvasItem>(sortedItems.map((item) => [item.id, item] as const))
  const resolvedItemOrderById =
    itemOrderById ??
    new Map<string, number>(sortedItems.map((item, index) => [item.id, index] as const))
  const scale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const margin = 400 / scale
  const viewportWidth = stageSize?.width ?? 1920
  const viewportHeight = stageSize?.height ?? 1080
  const vpLeft = -stagePos.x / scale - margin
  const vpTop = -stagePos.y / scale - margin
  const vpRight = (-stagePos.x + viewportWidth) / scale + margin
  const vpBottom = (-stagePos.y + viewportHeight) / scale + margin
  const queriedItems = queryCanvasSpatialIndex(
    spatialIndex ??
      buildCanvasPlaybackVisibilitySpatialIndex({ groupPlaybackItemIds, sortedItems }),
    {
      minX: vpLeft,
      minY: vpTop,
      maxX: vpRight,
      maxY: vpBottom
    }
  )
  const visibleItems = queriedItems.filter((item) => !playbackItemIdSet.has(item.id))
  const visibleIdSet = new Set(visibleItems.map((item) => item.id))
  const selectedExtraItems: CanvasItem[] = []

  selectedIds.forEach((itemId) => {
    if (playbackItemIdSet.has(itemId) || visibleIdSet.has(itemId)) {
      return
    }
    const item = resolvedItemById.get(itemId)
    if (item) {
      selectedExtraItems.push(item)
    }
  })

  if (selectedExtraItems.length === 0) {
    return visibleItems
  }

  selectedExtraItems.sort(
    (left, right) =>
      (resolvedItemOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (resolvedItemOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  )

  const mergedItems: CanvasItem[] = []
  let visibleIndex = 0
  let selectedIndex = 0

  while (visibleIndex < visibleItems.length || selectedIndex < selectedExtraItems.length) {
    const nextVisibleItem = visibleItems[visibleIndex]
    const nextSelectedItem = selectedExtraItems[selectedIndex]

    if (!nextVisibleItem) {
      mergedItems.push(nextSelectedItem)
      selectedIndex += 1
      continue
    }

    if (!nextSelectedItem) {
      mergedItems.push(nextVisibleItem)
      visibleIndex += 1
      continue
    }

    const nextVisibleOrder =
      resolvedItemOrderById.get(nextVisibleItem.id) ?? Number.MAX_SAFE_INTEGER
    const nextSelectedOrder =
      resolvedItemOrderById.get(nextSelectedItem.id) ?? Number.MAX_SAFE_INTEGER

    if (nextVisibleOrder <= nextSelectedOrder) {
      mergedItems.push(nextVisibleItem)
      visibleIndex += 1
      continue
    }

    mergedItems.push(nextSelectedItem)
    selectedIndex += 1
  }

  return mergedItems
}

export function resolveRenderedModel3DItems({
  forceRenderAllItemsForExport = false,
  groupPlaybackItemIds,
  sortedItems,
  visibleItems
}: {
  forceRenderAllItemsForExport?: boolean
  groupPlaybackItemIds?: readonly string[] | null
  sortedItems: CanvasItem[]
  visibleItems: CanvasItem[]
}): CanvasModel3DItem[] {
  const playbackItemIdSet = new Set(groupPlaybackItemIds ?? [])
  const sourceItems = forceRenderAllItemsForExport ? sortedItems : visibleItems

  return sourceItems.filter(
    (item): item is CanvasModel3DItem =>
      item.type === 'model3d' &&
      !(item as CanvasModel3DItem & { deferRender?: boolean }).deferRender &&
      !playbackItemIdSet.has(item.id)
  )
}

export function resolvePlayableVideoItems({
  groupPlaybackItemIds,
  sortedItems
}: {
  groupPlaybackItemIds?: readonly string[] | null
  sortedItems: CanvasItem[]
}): CanvasVideoItem[] {
  const playbackItemIdSet = new Set(groupPlaybackItemIds ?? [])
  return sortedItems.filter(
    (item): item is CanvasVideoItem => item.type === 'video' && !playbackItemIdSet.has(item.id)
  )
}

export function resolveRenderableHtmlItems({
  forceRenderAllItemsForExport = false,
  groupPlaybackItemIds,
  sortedItems,
  visibleItems
}: {
  forceRenderAllItemsForExport?: boolean
  groupPlaybackItemIds?: readonly string[] | null
  sortedItems: CanvasItem[]
  visibleItems: CanvasItem[]
}): CanvasHtmlItem[] {
  const playbackItemIdSet = new Set(groupPlaybackItemIds ?? [])
  const sourceItems = forceRenderAllItemsForExport ? sortedItems : visibleItems
  return sourceItems.filter(
    (item): item is CanvasHtmlItem => item.type === 'html' && !playbackItemIdSet.has(item.id)
  )
}

export function resolveActiveModel3DItem(
  items: CanvasItem[],
  model3DViewerItemId: string | null
): CanvasModel3DItem | null {
  if (!model3DViewerItemId) return null

  return (
    items.find(
      (item): item is CanvasModel3DItem =>
        item.id === model3DViewerItemId && item.type === 'model3d'
    ) ?? null
  )
}

export function isCanvasTextureImportFile(file: File): boolean {
  const ext = '.' + (file.name.toLowerCase().split('.').pop() || '')
  return (
    CANVAS_TEXTURE_IMPORT_EXTENSIONS.some((textureExt) => textureExt === ext) ||
    file.type.startsWith('image/')
  )
}

export function buildTextureObjectUrlMap(
  files: Iterable<File>,
  createObjectUrl: (file: File) => string = (file) => URL.createObjectURL(file)
): Record<string, string> {
  const textures: Record<string, string> = {}

  for (const file of files) {
    if (!isCanvasTextureImportFile(file)) continue
    textures[file.name] = createObjectUrl(file)
  }

  return textures
}
