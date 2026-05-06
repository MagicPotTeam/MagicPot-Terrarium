import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'

import { removeCanvasItemsWithAttachedCaptions } from './canvasAttachedCaptionUtils'
import type { CanvasHtmlItem, CanvasItem, CanvasVideoItem } from './types'

export type CanvasViewportPoint = {
  x: number
  y: number
}

export type CanvasLayerStartPosition = {
  x: number
  y: number
  type?: string
}

export type CanvasLayerDragContext = {
  draggingId: string | null
  startPositions: Map<string, CanvasLayerStartPosition>
}

export type CanvasTransformAttrs = Partial<
  Pick<CanvasItem, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>
>

export type UseCanvasLayerRuntimeOptions = {
  canvasContainerRef: RefObject<HTMLDivElement | null>
  lastViewportPointRef: MutableRefObject<CanvasViewportPoint | null>
  selectedIds: ReadonlySet<string>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setItemsWithHistory: Dispatch<SetStateAction<CanvasItem[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  tryHandleCanvasExternalDropRef: MutableRefObject<
    (itemId: string, clientX: number, clientY: number) => boolean
  >
}

type DragEndPointerEvent = {
  clientX?: number
  clientY?: number
  changedTouches?: ArrayLike<{
    clientX: number
    clientY: number
  }>
}

export function applyMultiDragDeltaToItem(
  item: CanvasItem,
  delta: { dx: number; dy: number }
): CanvasItem {
  const { dx, dy } = delta
  const updatedItem: CanvasItem = {
    ...item,
    x: item.x + dx,
    y: item.y + dy
  }

  if (
    updatedItem.type === 'annotation' &&
    (updatedItem.shape === 'arrow' || updatedItem.shape === 'line') &&
    updatedItem.endX != null &&
    updatedItem.endY != null
  ) {
    return {
      ...updatedItem,
      endX: updatedItem.endX + dx,
      endY: updatedItem.endY + dy
    }
  }

  if (updatedItem.type === 'annotation' && updatedItem.shape === 'freedraw' && updatedItem.points) {
    return {
      ...updatedItem,
      points: updatedItem.points.map((value, index) => (index % 2 === 0 ? value + dx : value + dy))
    }
  }

  return updatedItem
}

export function resolveCanvasExternalDropPoint(options: {
  canvasRect: DOMRect | null | undefined
  event: DragEndPointerEvent | null | undefined
  lastViewportPoint: CanvasViewportPoint | null
}): CanvasViewportPoint | null {
  const eventClientX = options.event?.clientX ?? options.event?.changedTouches?.[0]?.clientX
  const eventClientY = options.event?.clientY ?? options.event?.changedTouches?.[0]?.clientY
  if (eventClientX !== undefined && eventClientY !== undefined) {
    return { x: eventClientX, y: eventClientY }
  }

  const fallbackPoint = options.lastViewportPoint
  if (!fallbackPoint || !options.canvasRect) return null

  const isOutsideCanvas =
    fallbackPoint.x < options.canvasRect.left ||
    fallbackPoint.x > options.canvasRect.right ||
    fallbackPoint.y < options.canvasRect.top ||
    fallbackPoint.y > options.canvasRect.bottom

  return isOutsideCanvas ? fallbackPoint : null
}

export function applyCanvasLayerDragCommit(options: {
  previousItems: CanvasItem[]
  draggedId: string
  nextX: number
  nextY: number
  selectedIds: ReadonlySet<string>
}): CanvasItem[] {
  const draggedItem = options.previousItems.find((item) => item.id === options.draggedId)
  if (!draggedItem) {
    return options.previousItems
  }

  const dx = options.nextX - draggedItem.x
  const dy = options.nextY - draggedItem.y
  const shouldMoveMultiSelection =
    options.selectedIds.size > 1 &&
    options.selectedIds.has(options.draggedId) &&
    (dx !== 0 || dy !== 0)

  if (!shouldMoveMultiSelection) {
    return options.previousItems.map((item) =>
      item.id === options.draggedId ? { ...item, x: options.nextX, y: options.nextY } : item
    )
  }

  return options.previousItems.map((item) =>
    options.selectedIds.has(item.id) ? applyMultiDragDeltaToItem(item, { dx, dy }) : item
  )
}

export function useCanvasLayerRuntime({
  canvasContainerRef,
  lastViewportPointRef,
  selectedIds,
  setItems,
  setItemsWithHistory,
  setSelectedIds,
  tryHandleCanvasExternalDropRef
}: UseCanvasLayerRuntimeOptions) {
  const handleDragEnd = useCallback(
    (id: string, x: number, y: number, event?: DragEndPointerEvent) => {
      const canvasRect = canvasContainerRef.current?.getBoundingClientRect()
      const externalDropPoint = resolveCanvasExternalDropPoint({
        canvasRect,
        event,
        lastViewportPoint: lastViewportPointRef.current
      })

      if (
        externalDropPoint &&
        tryHandleCanvasExternalDropRef.current(id, externalDropPoint.x, externalDropPoint.y)
      ) {
        window.dispatchEvent(new CustomEvent('canvas:drag-end'))
        return
      }

      setItemsWithHistory((previousItems) =>
        applyCanvasLayerDragCommit({
          previousItems,
          draggedId: id,
          nextX: x,
          nextY: y,
          selectedIds
        })
      )
      window.dispatchEvent(new CustomEvent('canvas:drag-end'))
    },
    [
      canvasContainerRef,
      lastViewportPointRef,
      selectedIds,
      setItemsWithHistory,
      tryHandleCanvasExternalDropRef
    ]
  )

  const handleTransformEnd = useCallback(
    (id: string, attrs: CanvasTransformAttrs) => {
      setItemsWithHistory((previousItems) =>
        previousItems.map((item) => (item.id === id ? { ...item, ...attrs } : item))
      )
      window.dispatchEvent(new CustomEvent('canvas:transform-end', { detail: { id, attrs } }))
    },
    [setItemsWithHistory]
  )

  const handleUpdateVideoItem = useCallback(
    (id: string, updates: Partial<CanvasVideoItem>) => {
      setItems((previousItems) =>
        previousItems.map((item) =>
          item.id === id && item.type === 'video' ? { ...item, ...updates } : item
        )
      )
    },
    [setItems]
  )

  const handleToggleVideoPlayback = useCallback(
    (item: CanvasVideoItem, nextPlaying?: boolean) => {
      handleUpdateVideoItem(item.id, { playing: nextPlaying ?? !item.playing })
    },
    [handleUpdateVideoItem]
  )

  const handleUpdateHtmlItem = useCallback(
    (id: string, updates: Partial<CanvasHtmlItem>) => {
      setItemsWithHistory((previousItems) =>
        previousItems.map((item) =>
          item.id === id && item.type === 'html' ? { ...item, ...updates } : item
        )
      )
    },
    [setItemsWithHistory]
  )

  const handleDeleteHtmlItem = useCallback(
    (id: string) => {
      setItemsWithHistory(
        (previousItems) => removeCanvasItemsWithAttachedCaptions(previousItems, [id]).nextItems
      )
      setSelectedIds((previousIds) => {
        const nextIds = new Set(previousIds)
        nextIds.delete(id)
        return nextIds
      })
    },
    [setItemsWithHistory, setSelectedIds]
  )

  return {
    handleDeleteHtmlItem,
    handleDragEnd,
    handleToggleVideoPlayback,
    handleTransformEnd,
    handleUpdateHtmlItem,
    handleUpdateVideoItem
  }
}
