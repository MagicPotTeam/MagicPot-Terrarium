import type { ChatAttachment } from '@shared/api/svcLLMProxy'

import type { CanvasItem } from './types'

function waitForCanvasTargetPlacementCallbacks(
  expectedCount: number,
  placedItems: CanvasItem[],
  timeoutMs = 5000
): Promise<void> {
  if (expectedCount <= 0 || placedItems.length >= expectedCount) return Promise.resolve()

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const check = () => {
      if (placedItems.length >= expectedCount || Date.now() - startedAt >= timeoutMs) {
        resolve()
        return
      }
      window.setTimeout(check, 25)
    }
    check()
  })
}

export function isCanvasTargetPlacedItem(value: unknown): value is CanvasItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.type === 'string'
}

export async function dispatchCanvasTargetMediaAttachmentToCanvas(
  attachment: ChatAttachment,
  projectId: string,
  generationSessionId?: string
): Promise<{ dispatched: boolean; placedCanvasItems: CanvasItem[] }> {
  if (!attachment.url?.trim()) {
    return {
      dispatched: false,
      placedCanvasItems: []
    }
  }

  const placedCanvasItems: CanvasItem[] = []
  const onAdded = (item: unknown) => {
    if (isCanvasTargetPlacedItem(item)) {
      placedCanvasItems.push(item)
    }
  }

  if (attachment.type === 'image') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-image', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          sourceWidth: attachment.sourceWidth,
          sourceHeight: attachment.sourceHeight,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: placedCanvasItems.length > 0,
      placedCanvasItems
    }
  }

  if (attachment.type === 'video') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-video', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: placedCanvasItems.length > 0,
      placedCanvasItems
    }
  }

  if (attachment.type === 'model3d') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-model3d', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: placedCanvasItems.length > 0,
      placedCanvasItems
    }
  }

  return {
    dispatched: false,
    placedCanvasItems: []
  }
}
