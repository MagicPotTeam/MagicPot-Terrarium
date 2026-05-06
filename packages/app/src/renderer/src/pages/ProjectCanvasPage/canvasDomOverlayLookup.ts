import type { CanvasItem } from './types'

const CANVAS_OVERLAY_SELECTORS_BY_TYPE: Record<CanvasItem['type'], string[]> = {
  annotation: [
    '[data-canvas-overlay-role="annotation-interaction"]',
    '[data-canvas-overlay="annotation"]'
  ],
  file: ['[data-canvas-overlay-role="file-interaction"]', '[data-canvas-overlay="file"]'],
  html: ['[data-canvas-overlay="html"]'],
  image: ['[data-canvas-overlay="image-interaction"]'],
  model3d: ['[data-canvas-overlay="model3d"]'],
  text: ['[data-canvas-overlay-role="text-interaction"]', '[data-canvas-overlay="text"]'],
  video: ['[data-canvas-overlay="video"]']
}

function findCanvasItemElementBySelectors(
  container: ParentNode,
  itemId: string,
  selectors: readonly string[]
): HTMLElement | null {
  for (const selector of selectors) {
    const match = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.dataset.canvasItemId === itemId
    )
    if (match) {
      return match
    }
  }

  return null
}

export function findCanvasItemOverlayElement(
  container: ParentNode,
  item: Pick<CanvasItem, 'id' | 'type'>
): HTMLElement | null {
  const preferredSelectors = CANVAS_OVERLAY_SELECTORS_BY_TYPE[item.type]
  const preferredMatch = findCanvasItemElementBySelectors(container, item.id, preferredSelectors)
  if (preferredMatch) {
    return preferredMatch
  }

  return (
    Array.from(container.querySelectorAll<HTMLElement>('[data-canvas-item-id]')).find(
      (element) => element.dataset.canvasItemId === item.id
    ) ?? null
  )
}

export function findCanvasSelectionToolbar(
  container: ParentNode | null | undefined,
  selector: string,
  ownerId?: string
): HTMLElement | null {
  if (!container) {
    return null
  }

  const candidates = Array.from(container.querySelectorAll<HTMLElement>(selector))
  if (ownerId) {
    const ownedToolbar = candidates.find(
      (element) => element.dataset.selectionToolbarOwnerId === ownerId
    )
    if (ownedToolbar) {
      return ownedToolbar
    }
  }

  return candidates[0] ?? null
}
