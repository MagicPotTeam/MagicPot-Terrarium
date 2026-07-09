import type { CanvasImageItem, CanvasItem } from './types'

export type ProjectCanvasBenchmarkViewportRequest = {
  scale?: unknown
  x?: unknown
  y?: unknown
  focusLargestImage?: unknown
  selectFocused?: unknown
}

export type ProjectCanvasBenchmarkViewportState = {
  items: CanvasItem[]
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  clampStageScale: (scale: number) => number
}

export type ProjectCanvasBenchmarkViewportResult = {
  scale: number
  x: number
  y: number
  focusedImageId?: string
  shouldSelectFocusedImage: boolean
}

function toFiniteNumber(value: unknown): number | undefined {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : undefined
}

function getCanvasBenchmarkImageArea(item: CanvasImageItem): number {
  const width =
    typeof item.sourceWidth === 'number' && Number.isFinite(item.sourceWidth)
      ? item.sourceWidth
      : item.width
  const height =
    typeof item.sourceHeight === 'number' && Number.isFinite(item.sourceHeight)
      ? item.sourceHeight
      : item.height
  return width * height
}

export function findLargestBenchmarkImage(items: CanvasItem[]): CanvasImageItem | null {
  return items.reduce<CanvasImageItem | null>((best, item) => {
    if (item.type !== 'image') return best
    const itemArea = getCanvasBenchmarkImageArea(item)
    const bestArea = best ? getCanvasBenchmarkImageArea(best) : -1
    return itemArea > bestArea ? item : best
  }, null)
}

export function resolveProjectCanvasBenchmarkViewport(
  viewport: ProjectCanvasBenchmarkViewportRequest | null | undefined,
  state: ProjectCanvasBenchmarkViewportState
): ProjectCanvasBenchmarkViewportResult {
  const nextScale = state.clampStageScale(toFiniteNumber(viewport?.scale) ?? state.stageScale)
  const focusedImage = viewport?.focusLargestImage ? findLargestBenchmarkImage(state.items) : null
  const nextPos = focusedImage
    ? {
        x: state.stageSize.width / 2 - (focusedImage.x + focusedImage.width / 2) * nextScale,
        y: state.stageSize.height / 2 - (focusedImage.y + focusedImage.height / 2) * nextScale
      }
    : {
        x: toFiniteNumber(viewport?.x) ?? state.stagePos.x,
        y: toFiniteNumber(viewport?.y) ?? state.stagePos.y
      }

  const shouldSelectFocusedImage = Boolean(focusedImage && viewport?.selectFocused !== false)

  return {
    scale: nextScale,
    ...nextPos,
    ...(focusedImage ? { focusedImageId: focusedImage.id } : {}),
    shouldSelectFocusedImage
  }
}
