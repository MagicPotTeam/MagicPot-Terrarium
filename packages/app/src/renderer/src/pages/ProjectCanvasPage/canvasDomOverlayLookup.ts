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

export type CanvasDomOverlayLookupCache = {
  container: ParentNode | null
  selectorItemMaps: Map<string, Map<string, HTMLElement>>
  allItemElementMap: Map<string, HTMLElement> | null
  toolbarCandidatesBySelector: Map<string, HTMLElement[]>
}

export function createCanvasDomOverlayLookupCache(): CanvasDomOverlayLookupCache {
  return {
    container: null,
    selectorItemMaps: new Map(),
    allItemElementMap: null,
    toolbarCandidatesBySelector: new Map()
  }
}

function resetCanvasDomOverlayLookupCacheForContainer(
  cache: CanvasDomOverlayLookupCache,
  container: ParentNode
) {
  if (cache.container === container) {
    return
  }

  cache.container = container
  cache.selectorItemMaps.clear()
  cache.allItemElementMap = null
  cache.toolbarCandidatesBySelector.clear()
}

function getCachedSelectorItemMap(
  container: ParentNode,
  selector: string,
  cache?: CanvasDomOverlayLookupCache
): Map<string, HTMLElement> | null {
  if (!cache) {
    return null
  }

  resetCanvasDomOverlayLookupCacheForContainer(cache, container)
  const cached = cache.selectorItemMaps.get(selector)
  if (cached) {
    return cached
  }

  const map = new Map<string, HTMLElement>()
  for (const element of container.querySelectorAll<HTMLElement>(selector)) {
    const itemId = element.dataset.canvasItemId
    if (itemId && !map.has(itemId)) {
      map.set(itemId, element)
    }
  }
  cache.selectorItemMaps.set(selector, map)
  return map
}

function getCachedAllItemElementMap(
  container: ParentNode,
  cache?: CanvasDomOverlayLookupCache
): Map<string, HTMLElement> | null {
  if (!cache) {
    return null
  }

  resetCanvasDomOverlayLookupCacheForContainer(cache, container)
  if (cache.allItemElementMap) {
    return cache.allItemElementMap
  }

  const map = new Map<string, HTMLElement>()
  for (const element of container.querySelectorAll<HTMLElement>('[data-canvas-item-id]')) {
    const itemId = element.dataset.canvasItemId
    if (itemId && !map.has(itemId)) {
      map.set(itemId, element)
    }
  }
  cache.allItemElementMap = map
  return map
}

function findCanvasItemElementBySelectors(
  container: ParentNode,
  itemId: string,
  selectors: readonly string[],
  cache?: CanvasDomOverlayLookupCache
): HTMLElement | null {
  for (const selector of selectors) {
    const cachedMap = getCachedSelectorItemMap(container, selector, cache)
    if (cachedMap) {
      const cachedMatch = cachedMap.get(itemId)
      if (cachedMatch) {
        return cachedMatch
      }
      continue
    }

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
  item: Pick<CanvasItem, 'id' | 'type'>,
  cache?: CanvasDomOverlayLookupCache
): HTMLElement | null {
  const preferredSelectors = CANVAS_OVERLAY_SELECTORS_BY_TYPE[item.type]
  const preferredMatch = findCanvasItemElementBySelectors(
    container,
    item.id,
    preferredSelectors,
    cache
  )
  if (preferredMatch) {
    return preferredMatch
  }

  const cachedMap = getCachedAllItemElementMap(container, cache)
  if (cachedMap) {
    return cachedMap.get(item.id) ?? null
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
  ownerId?: string,
  cache?: CanvasDomOverlayLookupCache
): HTMLElement | null {
  if (!container) {
    return null
  }

  let candidates: HTMLElement[]
  if (cache) {
    resetCanvasDomOverlayLookupCacheForContainer(cache, container)
    const cachedCandidates = cache.toolbarCandidatesBySelector.get(selector)
    if (cachedCandidates) {
      candidates = cachedCandidates
    } else {
      candidates = Array.from(container.querySelectorAll<HTMLElement>(selector))
      cache.toolbarCandidatesBySelector.set(selector, candidates)
    }
  } else {
    candidates = Array.from(container.querySelectorAll<HTMLElement>(selector))
  }

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
