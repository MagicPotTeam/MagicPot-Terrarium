import { useCallback, type RefObject } from 'react'
import { resolveActiveAgentScope } from './canvasPageLocalStateUtils'
import type { CanvasDragPayload } from './projectCanvasPageShared'
import type {
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'

type ExternalDropItem = CanvasImageItem | CanvasModel3DItem | CanvasVideoItem | CanvasFileItem

type BuildCanvasDragPayloadFn = (
  targetItems: CanvasItem[],
  options?: {
    objectUrl?: string
    previewImageUrl?: string
    promptId?: string
  }
) => CanvasDragPayload

type UseCanvasExternalDropOptions = {
  canvasId: string
  items: CanvasItem[]
  selectedIds: ReadonlySet<string>
  canvasContainerRef: RefObject<HTMLDivElement | null>
  buildCanvasDragPayload: BuildCanvasDragPayloadFn
  setCanvasDragPayload: (dataTransfer: DataTransfer, payload: CanvasDragPayload) => void
  getCanvasImageDragObjectUrl: (item: CanvasImageItem) => string
  resetDraggedItemNode: (item: ExternalDropItem) => void
  handleSendCanvasItemsToAgent: (
    targetItems: CanvasItem[],
    targetScope?: string
  ) => Promise<void> | void
}

function isExternalDropItem(item: CanvasItem | undefined): item is ExternalDropItem {
  return (
    !!item &&
    (item.type === 'image' ||
      item.type === 'model3d' ||
      item.type === 'video' ||
      item.type === 'file')
  )
}

function resolveCanvasDragPromptId(item: ExternalDropItem): string | undefined {
  if ('promptId' in item && typeof item.promptId === 'string' && item.promptId.trim()) {
    return item.promptId
  }

  return undefined
}

export function useCanvasExternalDrop({
  canvasId,
  items,
  selectedIds,
  canvasContainerRef,
  buildCanvasDragPayload,
  setCanvasDragPayload,
  getCanvasImageDragObjectUrl,
  resetDraggedItemNode,
  handleSendCanvasItemsToAgent
}: UseCanvasExternalDropOptions) {
  const isPointInsideCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasContainerRef.current?.getBoundingClientRect()
      if (!rect) return false
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      )
    },
    [canvasContainerRef]
  )

  const dispatchSyntheticCanvasDrop = useCallback(
    (clientX: number, clientY: number, payload: CanvasDragPayload) => {
      const target = document.elementFromPoint(clientX, clientY)
      if (!target || typeof DataTransfer === 'undefined' || typeof DragEvent === 'undefined')
        return false

      const dataTransfer = new DataTransfer()
      setCanvasDragPayload(dataTransfer, payload)

      const dragOverHandled = !target.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer
        })
      )
      if (!dragOverHandled) return false

      return !target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer
        })
      )
    },
    [setCanvasDragPayload]
  )

  const getAgentWorkspaceDropTargetScope = useCallback(
    (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY)
      if (!(target instanceof Element)) return null

      const workspaceRoot = target.closest('[data-agent-workspace-root]')
      if (!(workspaceRoot instanceof HTMLElement)) return null

      const projectId = workspaceRoot.dataset.agentWorkspaceRoot || canvasId
      if (!projectId) return null

      return resolveActiveAgentScope(projectId)
    },
    [canvasId]
  )

  const tryHandleCanvasExternalDrop = useCallback(
    (itemId: string, clientX: number, clientY: number) => {
      if (isPointInsideCanvas(clientX, clientY)) return false

      const targetItem = items.find((item) => item.id === itemId)
      if (!isExternalDropItem(targetItem)) return false

      const objectUrl =
        targetItem.type === 'image' ? getCanvasImageDragObjectUrl(targetItem) : targetItem.src
      if (!objectUrl?.trim()) return false

      const agentTargetScope = getAgentWorkspaceDropTargetScope(clientX, clientY)
      if (agentTargetScope) {
        // Unselected images are selected only after drag end, so use the dragged item directly.
        const targetItems = selectedIds.has(targetItem.id)
          ? items.filter((item) => selectedIds.has(item.id))
          : [targetItem]
        resetDraggedItemNode(targetItem)
        void handleSendCanvasItemsToAgent(targetItems, agentTargetScope)
        return true
      }

      const handled = dispatchSyntheticCanvasDrop(
        clientX,
        clientY,
        buildCanvasDragPayload([targetItem], {
          objectUrl,
          promptId: resolveCanvasDragPromptId(targetItem)
        })
      )
      if (handled) {
        resetDraggedItemNode(targetItem)
      }
      return handled
    },
    [
      buildCanvasDragPayload,
      dispatchSyntheticCanvasDrop,
      getAgentWorkspaceDropTargetScope,
      getCanvasImageDragObjectUrl,
      handleSendCanvasItemsToAgent,
      isPointInsideCanvas,
      items,
      resetDraggedItemNode,
      selectedIds
    ]
  )

  return {
    tryHandleCanvasExternalDrop
  }
}
