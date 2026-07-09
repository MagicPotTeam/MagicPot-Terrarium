import type { CanvasItem } from './types'

export type CanvasTargetMediaDispatchSafetyResult =
  | { safe: true; url: string }
  | { safe: false; reason: string }

export function validateCanvasTargetMediaSourceUrl(
  url: string | null | undefined
): CanvasTargetMediaDispatchSafetyResult {
  const trimmedUrl = url?.trim()
  if (!trimmedUrl) {
    return { safe: false, reason: 'Missing media source URL.' }
  }

  const normalizedUrl = trimmedUrl.toLowerCase()
  if (normalizedUrl.startsWith('blob:')) {
    return { safe: true, url: trimmedUrl }
  }

  return {
    safe: false,
    reason: 'Canvas target media actions only accept app-materialized blob URLs.'
  }
}

export function buildCanvasTargetMediaPlacementFailure(
  actionName: string,
  placedCanvasItems: CanvasItem[]
): null | {
  content: string
  canvasDispatchCount: 0
  placedCanvasItemIds: string[]
  placedCanvasItems: CanvasItem[]
  fallbackReason: string
} {
  if (placedCanvasItems.length > 0) return null

  const mediaKind = actionName.replace('add_', '')
  return {
    content: `Canvas ${actionName} action did not report a placed ${mediaKind} item.`,
    canvasDispatchCount: 0,
    placedCanvasItemIds: [],
    placedCanvasItems: [],
    fallbackReason: `Canvas placement was not acknowledged for ${actionName}.`
  }
}
