import type { CanvasImageItem } from './types'
import { getCanvasImageAssetSize } from './canvasImageAssetUtils'

type CanvasImageDisplayCrop = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasImageDomPreviewLayout = {
  left: number
  top: number
  width: number
  height: number
}

const CANVAS_IMAGE_DOM_PREVIEW_LAYOUT_MAX_MULTIPLIER = 32
const CANVAS_IMAGE_DOM_PREVIEW_SOURCE_ASPECT_TOLERANCE = 0.08
const CANVAS_IMAGE_CROP_ASPECT_MAX_MULTIPLIER = 32

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function getAspectRatio(width: number, height: number): number | null {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return null
  }

  const aspect = width / height
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null
}

function areAspectRatiosClose(left: number, right: number): boolean {
  return Math.abs(left - right) / right <= CANVAS_IMAGE_DOM_PREVIEW_SOURCE_ASPECT_TOLERANCE
}

function isCanvasImageCropAspectCompatible(
  item: Pick<CanvasImageItem, 'width' | 'height'>,
  crop: CanvasImageDisplayCrop
): boolean {
  const itemAspect = getAspectRatio(item.width, item.height)
  const cropAspect = getAspectRatio(crop.width, crop.height)

  if (!itemAspect || !cropAspect) {
    return true
  }

  const aspectRatio = Math.max(cropAspect / itemAspect, itemAspect / cropAspect)
  return Number.isFinite(aspectRatio) && aspectRatio <= CANVAS_IMAGE_CROP_ASPECT_MAX_MULTIPLIER
}

function normalizeCanvasImageDisplayCropForItem(
  item: Pick<CanvasImageItem, 'width' | 'height'>,
  crop: CanvasImageDisplayCrop | undefined,
  imageWidth: number,
  imageHeight: number
): CanvasImageDisplayCrop | undefined {
  const normalizedCrop = normalizeCanvasImageDisplayCrop(crop, imageWidth, imageHeight)
  if (!normalizedCrop || !isCanvasImageCropAspectCompatible(item, normalizedCrop)) {
    return undefined
  }

  return normalizedCrop
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeCanvasImageDisplayCrop(
  crop: CanvasImageDisplayCrop | undefined,
  imageWidth: number,
  imageHeight: number
): CanvasImageDisplayCrop | undefined {
  if (
    !crop ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return undefined
  }

  const x1 = clamp(crop.x, 0, imageWidth)
  const y1 = clamp(crop.y, 0, imageHeight)
  const x2 = clamp(crop.x + crop.width, 0, imageWidth)
  const y2 = clamp(crop.y + crop.height, 0, imageHeight)

  if (x2 <= x1 || y2 <= y1) {
    return undefined
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  }
}

export function resolveCanvasImageDisplayCrop(
  item: CanvasImageItem,
  image: CanvasImageItem['image'] | null | undefined
): CanvasImageDisplayCrop | undefined {
  const { width: imageWidth, height: imageHeight } = getCanvasImageAssetSize(image)

  if (!item.crop || !image) {
    return normalizeCanvasImageDisplayCropForItem(item, item.crop, imageWidth, imageHeight)
  }

  const sourceWidth = item.sourceWidth || imageWidth
  const sourceHeight = item.sourceHeight || imageHeight

  if (!sourceWidth || !sourceHeight) {
    return normalizeCanvasImageDisplayCropForItem(item, item.crop, imageWidth, imageHeight)
  }

  if (sourceWidth === imageWidth && sourceHeight === imageHeight) {
    return normalizeCanvasImageDisplayCropForItem(item, item.crop, imageWidth, imageHeight)
  }

  const scaleX = imageWidth / sourceWidth
  const scaleY = imageHeight / sourceHeight

  return normalizeCanvasImageDisplayCropForItem(
    item,
    {
      x: item.crop.x * scaleX,
      y: item.crop.y * scaleY,
      width: item.crop.width * scaleX,
      height: item.crop.height * scaleY
    },
    imageWidth,
    imageHeight
  )
}

export function resolveCanvasImageDomPreviewLayout(
  item: Pick<
    CanvasImageItem,
    'width' | 'height' | 'crop' | 'image' | 'sourceWidth' | 'sourceHeight'
  >
): CanvasImageDomPreviewLayout | null {
  const { width: assetWidth, height: assetHeight } = getCanvasImageAssetSize(item.image)
  const hasSourceSizeHint =
    isPositiveFinite(item.sourceWidth) && isPositiveFinite(item.sourceHeight)
  const sourceWidth = hasSourceSizeHint ? item.sourceWidth! : assetWidth
  const sourceHeight = hasSourceSizeHint ? item.sourceHeight! : assetHeight
  const assetAspect = getAspectRatio(assetWidth, assetHeight)
  const sourceAspect = getAspectRatio(sourceWidth, sourceHeight)

  if (
    hasSourceSizeHint &&
    assetAspect &&
    sourceAspect &&
    !areAspectRatiosClose(assetAspect, sourceAspect)
  ) {
    return null
  }

  const displayCrop = normalizeCanvasImageDisplayCropForItem(
    item,
    item.crop,
    sourceWidth,
    sourceHeight
  )
  if (!displayCrop) {
    return null
  }

  const widthScale = item.width / displayCrop.width
  const heightScale = item.height / displayCrop.height

  const layout = {
    left: -displayCrop.x * widthScale,
    top: -displayCrop.y * heightScale,
    width: sourceWidth * widthScale,
    height: sourceHeight * heightScale
  }

  const maxLayoutWidth = Math.max(item.width, 1) * CANVAS_IMAGE_DOM_PREVIEW_LAYOUT_MAX_MULTIPLIER
  const maxLayoutHeight = Math.max(item.height, 1) * CANVAS_IMAGE_DOM_PREVIEW_LAYOUT_MAX_MULTIPLIER
  if (
    !Number.isFinite(layout.left) ||
    !Number.isFinite(layout.top) ||
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0 ||
    Math.abs(layout.left) > maxLayoutWidth ||
    Math.abs(layout.top) > maxLayoutHeight ||
    layout.width > maxLayoutWidth ||
    layout.height > maxLayoutHeight
  ) {
    return null
  }

  return layout
}
