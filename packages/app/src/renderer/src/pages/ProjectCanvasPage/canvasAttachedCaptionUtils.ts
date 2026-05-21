import type { CanvasAnnotationItem, CanvasItem } from './types'

type CanvasItemVisualBounds = {
  x: number
  y: number
  width: number
  height: number
}

type AttachedCaptionLayoutOptions = {
  parentScale?: number
  baseScale?: number
  baseFontSize?: number
  baseHeight?: number
}

type AttachedCaptionScaleSource = {
  fontSize?: number
  height?: number
  attachmentBaseScale?: number
  attachmentBaseFontSize?: number
  attachmentBaseHeight?: number
}

export type AttachedCaptionAnnotation = CanvasAnnotationItem & {
  attachedToId?: string
  attachmentPlacement?: 'bottom-center'
}

const ATTACHED_CAPTION_OFFSET_Y = 12
const ATTACHED_CAPTION_MIN_WIDTH = 160
const ATTACHED_CAPTION_MIN_HEIGHT = 48
const ATTACHED_CAPTION_MIN_FONT_SIZE = 28
const ATTACHED_CAPTION_FONT_AREA_RATIO = 0.055
const ATTACHED_CAPTION_SINGLE_LINE_HEIGHT = 1.7

function normalizePositiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function resolveCanvasItemAttachmentScale(
  item: Pick<CanvasItem, 'scaleX' | 'scaleY'>
): number {
  const scaleX = normalizePositiveFinite(Math.abs(item.scaleX || 1)) ?? 1
  const scaleY = normalizePositiveFinite(Math.abs(item.scaleY || 1)) ?? 1
  return Math.sqrt(scaleX * scaleY)
}

export function resolveAttachedCaptionScaleBasis(
  parentScale: number,
  caption: AttachedCaptionScaleSource
): {
  baseScale: number
  baseFontSize: number
  baseHeight: number
} {
  const safeParentScale = normalizePositiveFinite(parentScale) ?? 1
  const storedBaseScale = normalizePositiveFinite(caption.attachmentBaseScale)
  const baseScale = storedBaseScale ?? Math.min(safeParentScale, 1)

  return {
    baseScale,
    baseFontSize:
      normalizePositiveFinite(caption.attachmentBaseFontSize) ??
      normalizePositiveFinite(caption.fontSize) ??
      ATTACHED_CAPTION_MIN_FONT_SIZE,
    baseHeight:
      normalizePositiveFinite(caption.attachmentBaseHeight) ??
      normalizePositiveFinite(caption.height) ??
      ATTACHED_CAPTION_MIN_HEIGHT
  }
}

export function resolveAttachedCaptionDraftLayout(
  parentBounds: CanvasItemVisualBounds,
  options: AttachedCaptionLayoutOptions = {}
): {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
} {
  const parentWidth = Math.max(1, parentBounds.width)
  const parentHeight = Math.max(1, parentBounds.height)
  const width = Math.max(ATTACHED_CAPTION_MIN_WIDTH, parentWidth)
  const parentScale = normalizePositiveFinite(options.parentScale) ?? 1
  const baseScale = normalizePositiveFinite(options.baseScale) ?? parentScale
  const scaleRatio = parentScale / baseScale
  const baseFontSize = Math.max(
    ATTACHED_CAPTION_MIN_FONT_SIZE,
    normalizePositiveFinite(options.baseFontSize) ??
      Math.round(Math.sqrt(parentWidth * parentHeight) * ATTACHED_CAPTION_FONT_AREA_RATIO)
  )
  const baseHeight = Math.max(
    ATTACHED_CAPTION_MIN_HEIGHT,
    normalizePositiveFinite(options.baseHeight) ??
      Math.ceil(baseFontSize * ATTACHED_CAPTION_SINGLE_LINE_HEIGHT)
  )
  const fontSize = Math.max(1, Math.round(baseFontSize * scaleRatio))
  const height = Math.max(1, Math.round(baseHeight * scaleRatio))

  return {
    x: parentBounds.x + (parentWidth - width) / 2,
    y: parentBounds.y + parentHeight + ATTACHED_CAPTION_OFFSET_Y,
    width,
    height,
    fontSize
  }
}

export function isAttachedCaptionAnnotation(item: CanvasItem): item is AttachedCaptionAnnotation {
  return (
    item.type === 'annotation' &&
    item.shape === 'text-anno' &&
    typeof (item as AttachedCaptionAnnotation).attachedToId === 'string' &&
    Boolean((item as AttachedCaptionAnnotation).attachedToId)
  )
}

export function isConstraintAttachedCaptionAnnotation(
  item: CanvasItem
): item is AttachedCaptionAnnotation {
  return isAttachedCaptionAnnotation(item) && item.attachmentRole !== 'tagging-result'
}

export function collectCascadeDeletedCanvasItemIds(
  items: CanvasItem[],
  rootDeletedIds: Iterable<string>
): Set<string> {
  const deletedIds = new Set(rootDeletedIds)
  let changed = true

  while (changed) {
    changed = false
    for (const item of items) {
      if (
        isAttachedCaptionAnnotation(item) &&
        item.attachedToId &&
        deletedIds.has(item.attachedToId) &&
        !deletedIds.has(item.id)
      ) {
        deletedIds.add(item.id)
        changed = true
      }
    }
  }

  return deletedIds
}

export function removeCanvasItemsWithAttachedCaptions(
  items: CanvasItem[],
  rootDeletedIds: Iterable<string>
): {
  deletedIds: Set<string>
  nextItems: CanvasItem[]
} {
  const deletedIds = collectCascadeDeletedCanvasItemIds(items, rootDeletedIds)
  return {
    deletedIds,
    nextItems: items.filter((item) => !deletedIds.has(item.id))
  }
}

export function pruneOrphanAttachedCaptions(items: CanvasItem[]): CanvasItem[] {
  const itemIdSet = new Set(items.map((item) => item.id))
  const nextItems = items.filter(
    (item) =>
      !(isAttachedCaptionAnnotation(item) && item.attachedToId && !itemIdSet.has(item.attachedToId))
  )

  return nextItems.length === items.length ? items : nextItems
}
