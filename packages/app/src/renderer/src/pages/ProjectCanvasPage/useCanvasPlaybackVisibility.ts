/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from 'react'
import {
  buildCanvasPlaybackVisibilitySpatialIndex,
  resolveVisibleCanvasItems
} from './canvasViewerPlaybackUtils'
import type { CanvasHtmlItem, CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'

type UseCanvasPlaybackVisibilityOptions = any

export function useCanvasPlaybackVisibility(options: UseCanvasPlaybackVisibilityOptions) {
  const {
    forceRenderAllItemsForExport,
    groupPlayback,
    selectedIds,
    sortedItems,
    stagePos,
    stageScale,
    stageSize
  } = options
  const playbackItemIds = useMemo(() => groupPlayback?.itemIds ?? [], [groupPlayback?.itemIds])
  const playbackItemIdSet = useMemo(() => new Set(playbackItemIds), [playbackItemIds])

  const playbackVisibilitySpatialIndex = useMemo(
    () =>
      buildCanvasPlaybackVisibilitySpatialIndex({
        groupPlaybackItemIds: playbackItemIds,
        sortedItems
      }),
    [playbackItemIds, sortedItems]
  )
  const sortedItemById = useMemo(
    () => new Map<string, CanvasItem>(sortedItems.map((item) => [item.id, item] as const)),
    [sortedItems]
  )
  const sortedItemOrderById = useMemo(
    () => new Map<string, number>(sortedItems.map((item, index) => [item.id, index] as const)),
    [sortedItems]
  )

  const visibleItems = useMemo(() => {
    return resolveVisibleCanvasItems({
      forceRenderAllItemsForExport,
      groupPlaybackItemIds: playbackItemIds,
      itemById: sortedItemById,
      itemOrderById: sortedItemOrderById,
      selectedIds,
      sortedItems,
      spatialIndex: playbackVisibilitySpatialIndex,
      stagePos,
      stageScale,
      stageSize
    })
  }, [
    forceRenderAllItemsForExport,
    playbackItemIds,
    playbackVisibilitySpatialIndex,
    selectedIds,
    sortedItemById,
    sortedItemOrderById,
    sortedItems,
    stagePos,
    stageScale,
    stageSize
  ])

  const { renderedModel3DItems, videoItems, htmlItems } = useMemo(() => {
    const nextVideoItems: CanvasVideoItem[] = []
    const nextHtmlItems: CanvasHtmlItem[] = []
    for (const item of sortedItems) {
      if (playbackItemIdSet.has(item.id)) {
        continue
      }

      if (item.type === 'video') {
        nextVideoItems.push(item)
        continue
      }

      if (item.type === 'html') {
        nextHtmlItems.push(item)
      }
    }

    const model3DSourceItems = forceRenderAllItemsForExport ? sortedItems : visibleItems
    const nextRenderedModel3DItems: CanvasModel3DItem[] = []
    for (const item of model3DSourceItems) {
      if (item.type !== 'model3d' || playbackItemIdSet.has(item.id)) {
        continue
      }
      if ((item as CanvasModel3DItem & { deferRender?: boolean }).deferRender) {
        continue
      }
      nextRenderedModel3DItems.push(item)
    }

    return {
      renderedModel3DItems: nextRenderedModel3DItems,
      videoItems: nextVideoItems,
      htmlItems: nextHtmlItems
    }
  }, [forceRenderAllItemsForExport, playbackItemIdSet, sortedItems, visibleItems])

  return {
    htmlItems,
    renderedModel3DItems,
    videoItems,
    visibleItems
  }
}
