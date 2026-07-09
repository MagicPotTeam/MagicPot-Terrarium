import { useEffect, useMemo } from 'react'

import {
  CANVAS_DUPLICATE_CHECK_FOCUS_EVENT,
  publishCanvasDuplicateCheckRuntimeSnapshot,
  type CanvasDuplicateCheckFocusDetail,
  type CanvasDuplicateCheckRuntimeSnapshot
} from './canvasDuplicateCheckRuntime'
import { getCanvasItemsBounds } from './projectCanvasPageShared'
import type { CanvasImageItem, CanvasItem } from './types'

export type UseCanvasDuplicateCheckRuntimeBridgeOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  selectedIds: Set<string>
  setSelectedIds: (selectedIds: Set<string>) => void
  focusCanvasStage: () => void
  focusCanvasBounds: (bounds: ReturnType<typeof getCanvasItemsBounds>, padding?: number) => void
  publishSnapshot?: (snapshot: CanvasDuplicateCheckRuntimeSnapshot) => void
}

export function useCanvasDuplicateCheckRuntimeBridge({
  canvasId,
  projectName,
  items,
  selectedIds,
  setSelectedIds,
  focusCanvasStage,
  focusCanvasBounds,
  publishSnapshot = publishCanvasDuplicateCheckRuntimeSnapshot
}: UseCanvasDuplicateCheckRuntimeBridgeOptions) {
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  )

  useEffect(() => {
    publishSnapshot({
      canvasId,
      projectName,
      imageItemIds: items.filter((item) => item.type === 'image').map((item) => item.id),
      selectedItemIds: Array.from(selectedIds),
      selectedImageItemIds: selectedItems
        .filter((item): item is CanvasImageItem => item.type === 'image')
        .map((item) => item.id),
      updatedAt: new Date().toISOString()
    })
  }, [canvasId, items, projectName, publishSnapshot, selectedIds, selectedItems])

  useEffect(() => {
    const handleFocusItems = (event: Event) => {
      const detail = (event as CustomEvent<CanvasDuplicateCheckFocusDetail>).detail
      if (!detail || detail.canvasId !== canvasId || !Array.isArray(detail.itemIds)) {
        return
      }

      const nextSelectedItems = items.filter((item) => detail.itemIds.includes(item.id))
      if (nextSelectedItems.length === 0) {
        return
      }

      setSelectedIds(new Set(nextSelectedItems.map((item) => item.id)))
      focusCanvasStage()
      window.requestAnimationFrame(() => {
        focusCanvasBounds(getCanvasItemsBounds(nextSelectedItems), 120)
      })
    }

    window.addEventListener(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, handleFocusItems)
    return () => {
      window.removeEventListener(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, handleFocusItems)
    }
  }, [canvasId, focusCanvasBounds, focusCanvasStage, items, setSelectedIds])

  return { selectedItems }
}
