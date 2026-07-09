import type { CanvasItem } from './types'

export type ProjectTraceCanvasItemMetric = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  zIndex: number
}

export type ProjectTraceCanvasSnapshot = {
  signature: string
  itemCount: number
  selectionCount: number
  items: Record<string, ProjectTraceCanvasItemMetric>
}

export function roundProjectTraceCanvasNumber(value: unknown): number {
  return Math.round((typeof value === 'number' ? value : 0) * 10) / 10
}

export function buildProjectTraceCanvasItemMetrics(
  items: CanvasItem[]
): Record<string, ProjectTraceCanvasItemMetric> {
  return Object.fromEntries(
    items.map((item) => {
      const measured = item as CanvasItem & {
        x?: number
        y?: number
        width?: number
        height?: number
        rotation?: number
        zIndex?: number
      }
      return [
        item.id,
        {
          id: item.id,
          type: item.type,
          x: roundProjectTraceCanvasNumber(measured.x),
          y: roundProjectTraceCanvasNumber(measured.y),
          width: roundProjectTraceCanvasNumber(measured.width),
          height: roundProjectTraceCanvasNumber(measured.height),
          rotation: roundProjectTraceCanvasNumber(measured.rotation),
          zIndex: measured.zIndex || 0
        }
      ]
    })
  )
}

export function buildProjectTraceCanvasItemSignature(
  metrics: Record<string, ProjectTraceCanvasItemMetric>
): string {
  return Object.values(metrics)
    .map((item) =>
      [
        item.id,
        item.type,
        item.x,
        item.y,
        item.width,
        item.height,
        item.rotation,
        item.zIndex
      ].join(':')
    )
    .sort()
    .join('|')
}

export function summarizeProjectTraceCanvasChange(
  previous: Record<string, ProjectTraceCanvasItemMetric>,
  next: Record<string, ProjectTraceCanvasItemMetric>,
  selectedCount: number,
  selectionChanged: boolean,
  isChineseUi: boolean
): { summary: string; affectedItemCount: number; movementDistancePx?: number } {
  const previousIds = new Set(Object.keys(previous))
  const nextIds = new Set(Object.keys(next))
  const created = Object.values(next).filter((item) => !previousIds.has(item.id))
  const removed = Object.values(previous).filter((item) => !nextIds.has(item.id))
  const changedPairs = Object.values(next)
    .map((item) => ({ before: previous[item.id], after: item }))
    .filter(
      (
        entry
      ): entry is { before: ProjectTraceCanvasItemMetric; after: ProjectTraceCanvasItemMetric } =>
        Boolean(entry.before)
    )

  const moved = changedPairs.filter(
    ({ before, after }) => before.x !== after.x || before.y !== after.y
  )
  const movementDistancePx = Math.max(
    0,
    ...moved.map(({ before, after }) => Math.hypot(after.x - before.x, after.y - before.y))
  )
  const resized = changedPairs.filter(
    ({ before, after }) => before.width !== after.width || before.height !== after.height
  )
  const rotated = changedPairs.filter(({ before, after }) => before.rotation !== after.rotation)
  const reordered = changedPairs.filter(({ before, after }) => before.zIndex !== after.zIndex)
  void isChineseUi
  const parts = [
    created.length ? `Added ${created.length} canvas item(s)` : '',
    removed.length ? `Removed ${removed.length} canvas item(s)` : '',
    moved.length
      ? `Moved ${moved.length} canvas item(s), max distance ${roundProjectTraceCanvasNumber(movementDistancePx)}px`
      : '',
    resized.length ? `Resized ${resized.length} canvas item(s)` : '',
    rotated.length ? `Rotated ${rotated.length} canvas item(s)` : '',
    reordered.length ? `Changed z-order for ${reordered.length} canvas item(s)` : '',
    selectionChanged ? `Selection changed to ${selectedCount} item(s)` : ''
  ].filter(Boolean)

  return {
    summary: parts.join('; ') || 'Updated canvas state',
    affectedItemCount:
      created.length +
      removed.length +
      moved.length +
      resized.length +
      rotated.length +
      reordered.length +
      (selectionChanged ? selectedCount : 0),
    ...(moved.length > 0
      ? { movementDistancePx: roundProjectTraceCanvasNumber(movementDistancePx) }
      : {})
  }
}

export function measureProjectTraceCanvasRuleMetrics(
  previous: Record<string, ProjectTraceCanvasItemMetric>,
  next: Record<string, ProjectTraceCanvasItemMetric>
): {
  removedItemCount?: number
  resizedItemCount?: number
  rotatedItemCount?: number
  reorderedItemCount?: number
  maxScaleChangeRatio?: number
  maxRotationDeltaDeg?: number
  maxLayerDelta?: number
} {
  const nextIds = new Set(Object.keys(next))
  const removedItemCount = Object.values(previous).filter((item) => !nextIds.has(item.id)).length
  const changedPairs = Object.values(next)
    .map((item) => ({ before: previous[item.id], after: item }))
    .filter(
      (
        entry
      ): entry is { before: ProjectTraceCanvasItemMetric; after: ProjectTraceCanvasItemMetric } =>
        Boolean(entry.before)
    )
  const resized = changedPairs.filter(
    ({ before, after }) => before.width !== after.width || before.height !== after.height
  )
  const rotated = changedPairs.filter(({ before, after }) => before.rotation !== after.rotation)
  const reordered = changedPairs.filter(({ before, after }) => before.zIndex !== after.zIndex)
  const maxScaleChangeRatio = Math.max(
    0,
    ...resized.map(({ before, after }) =>
      Math.max(
        Math.abs(after.width - before.width) / Math.max(1, Math.abs(before.width)),
        Math.abs(after.height - before.height) / Math.max(1, Math.abs(before.height))
      )
    )
  )
  const maxRotationDeltaDeg = Math.max(
    0,
    ...rotated.map(({ before, after }) => {
      const delta = Math.abs(after.rotation - before.rotation) % 360
      return Math.min(delta, 360 - delta)
    })
  )
  const maxLayerDelta = Math.max(
    0,
    ...reordered.map(({ before, after }) => Math.abs(after.zIndex - before.zIndex))
  )

  return {
    ...(removedItemCount > 0 ? { removedItemCount } : {}),
    ...(resized.length > 0 ? { resizedItemCount: resized.length } : {}),
    ...(rotated.length > 0 ? { rotatedItemCount: rotated.length } : {}),
    ...(reordered.length > 0 ? { reorderedItemCount: reordered.length } : {}),
    ...(resized.length > 0
      ? { maxScaleChangeRatio: roundProjectTraceCanvasNumber(maxScaleChangeRatio) }
      : {}),
    ...(rotated.length > 0
      ? { maxRotationDeltaDeg: roundProjectTraceCanvasNumber(maxRotationDeltaDeg) }
      : {}),
    ...(reordered.length > 0 ? { maxLayerDelta: roundProjectTraceCanvasNumber(maxLayerDelta) } : {})
  }
}

export function summarizeProjectTraceCanvasItemTypes(items: CanvasItem[]): string {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1
    return acc
  }, {})
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
    .join(', ')
}
