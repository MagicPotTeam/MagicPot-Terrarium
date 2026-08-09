const transientHiddenCanvasItemIds = new Set<string>()

export function hideCanvasItemsTransiently(itemIds: Iterable<string>): void {
  for (const itemId of itemIds) {
    transientHiddenCanvasItemIds.add(itemId)
  }
}

export function showCanvasItemsTransiently(itemIds: Iterable<string>): void {
  for (const itemId of itemIds) {
    transientHiddenCanvasItemIds.delete(itemId)
  }
}

export function isCanvasItemTransientlyHidden(itemId: string): boolean {
  return transientHiddenCanvasItemIds.has(itemId)
}
