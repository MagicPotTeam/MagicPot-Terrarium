import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import type { CanvasImageItem } from './types'
import { buildFallbackResult, normalizePositiveNumber } from './canvasTargetCanvasActionCore'
import type {
  CanvasTargetSemanticCanvasActionResult,
  CanvasTargetSemanticCanvasActionState
} from './canvasTargetCanvasActionTypes'

function resolveImageAssetDimension(
  image: CanvasImageItem['image'] | undefined,
  dimension: 'width' | 'height'
): number | undefined {
  if (!image) return undefined
  const asset = image as {
    width?: number
    height?: number
    naturalWidth?: number
    naturalHeight?: number
  }
  const direct = dimension === 'width' ? asset.width : asset.height
  const natural = dimension === 'width' ? asset.naturalWidth : asset.naturalHeight
  const value = direct ?? natural
  return value != null && Number.isFinite(value) && value > 0 ? value : undefined
}

function resolveImageSourceSize(item: CanvasImageItem): { width: number; height: number } {
  return {
    width:
      normalizePositiveNumber(item.sourceWidth) ??
      resolveImageAssetDimension(item.image, 'width') ??
      normalizePositiveNumber(item.crop?.width) ??
      Math.max(1, item.width),
    height:
      normalizePositiveNumber(item.sourceHeight) ??
      resolveImageAssetDimension(item.image, 'height') ??
      normalizePositiveNumber(item.crop?.height) ??
      Math.max(1, item.height)
  }
}

export function resolveCropRectangleForImage(
  action: CanvasTargetCanvasAction,
  item: CanvasImageItem
): { x: number; y: number; width: number; height: number } | null {
  const sourceSize = resolveImageSourceSize(item)
  const currentCrop = item.crop || {
    x: 0,
    y: 0,
    width: sourceSize.width,
    height: sourceSize.height
  }
  const rawX = action.cropX ?? action.x
  const rawY = action.cropY ?? action.y
  const rawWidth = action.cropWidth ?? action.width
  const rawHeight = action.cropHeight ?? action.height
  if (
    rawX == null ||
    rawY == null ||
    rawWidth == null ||
    rawHeight == null ||
    rawWidth <= 0 ||
    rawHeight <= 0
  ) {
    return null
  }

  let cropX = rawX
  let cropY = rawY
  let cropWidth = rawWidth
  let cropHeight = rawHeight
  const coordinateSpace = action.coordinateSpace
  if (!coordinateSpace) {
    return null
  }

  if (coordinateSpace === 'source_item_normalized') {
    cropX = currentCrop.x + rawX * currentCrop.width
    cropY = currentCrop.y + rawY * currentCrop.height
    cropWidth = rawWidth * currentCrop.width
    cropHeight = rawHeight * currentCrop.height
  } else if (coordinateSpace === 'source_image_pixels') {
    cropX = rawX
    cropY = rawY
    cropWidth = rawWidth
    cropHeight = rawHeight
  } else if (coordinateSpace === 'source_item' || coordinateSpace === 'canvas') {
    const displayToSourceScaleX = currentCrop.width / Math.max(1, item.width)
    const displayToSourceScaleY = currentCrop.height / Math.max(1, item.height)
    const localX = coordinateSpace === 'canvas' ? rawX - item.x : rawX
    const localY = coordinateSpace === 'canvas' ? rawY - item.y : rawY
    cropX = currentCrop.x + localX * displayToSourceScaleX
    cropY = currentCrop.y + localY * displayToSourceScaleY
    cropWidth = rawWidth * displayToSourceScaleX
    cropHeight = rawHeight * displayToSourceScaleY
  }

  const clampedX = Math.max(0, Math.min(sourceSize.width - 1, cropX))
  const clampedY = Math.max(0, Math.min(sourceSize.height - 1, cropY))
  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(1, Math.min(sourceSize.width - clampedX, cropWidth)),
    height: Math.max(1, Math.min(sourceSize.height - clampedY, cropHeight))
  }
}

function rotateVector(
  vector: { x: number; y: number },
  rotation: number
): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos
  }
}

function applyCropToCanvasImageItem(
  item: CanvasImageItem,
  crop: { x: number; y: number; width: number; height: number }
): CanvasImageItem {
  const sourceSize = resolveImageSourceSize(item)
  const currentCrop = item.crop || {
    x: 0,
    y: 0,
    width: sourceSize.width,
    height: sourceSize.height
  }
  const sourceCropScaleX = item.width / Math.max(1, currentCrop.width)
  const sourceCropScaleY = item.height / Math.max(1, currentCrop.height)
  const localX = crop.x - currentCrop.x
  const localY = crop.y - currentCrop.y
  const rotatedOffset = rotateVector(
    {
      x: localX * item.scaleX * sourceCropScaleX,
      y: localY * item.scaleY * sourceCropScaleY
    },
    item.rotation
  )

  return {
    ...item,
    x: item.x + rotatedOffset.x,
    y: item.y + rotatedOffset.y,
    width: crop.width,
    height: crop.height,
    scaleX: item.scaleX * sourceCropScaleX,
    scaleY: item.scaleY * sourceCropScaleY,
    crop
  }
}

export function cropCanvasImages(
  action: CanvasTargetCanvasAction,
  state: CanvasTargetSemanticCanvasActionState,
  sourceIds: string[]
): CanvasTargetSemanticCanvasActionResult {
  const sourceIdSet = new Set(sourceIds)
  const affectedIds: string[] = []
  let missingCropRectangle = false
  let missingCoordinateSpace = false
  const nextItems = state.items.map((item) => {
    if (!sourceIdSet.has(item.id) || item.type !== 'image') return item
    if (!action.coordinateSpace) {
      missingCoordinateSpace = true
      return item
    }
    const crop = resolveCropRectangleForImage(action, item)
    if (!crop) {
      missingCropRectangle = true
      return item
    }
    affectedIds.push(item.id)
    return applyCropToCanvasImageItem(item, crop)
  })

  if (affectedIds.length === 0) {
    const fallbackReason = missingCoordinateSpace
      ? 'Missing coordinateSpace for crop_image. The control model must explicitly choose canvas, source_item, source_item_normalized, or source_image_pixels.'
      : missingCropRectangle
        ? 'Missing a valid crop rectangle for crop_image.'
        : 'No image items were available to crop.'
    return buildFallbackResult(action, state, fallbackReason)
  }

  return {
    items: nextItems,
    selectedIds: action.selectResult === false ? new Set(state.selectedIds) : new Set(affectedIds),
    nextZIndex: state.nextZIndex,
    affectedIds,
    createdIds: [],
    resultIds: affectedIds,
    content: `Cropped ${affectedIds.length} image item(s).`,
    canvasDispatchCount: affectedIds.length
  }
}
