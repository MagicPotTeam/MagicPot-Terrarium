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
    return normalizeCanvasImageDisplayCrop(item.crop, imageWidth, imageHeight)
  }

  const sourceWidth = item.sourceWidth || imageWidth
  const sourceHeight = item.sourceHeight || imageHeight

  if (!sourceWidth || !sourceHeight) {
    return normalizeCanvasImageDisplayCrop(item.crop, imageWidth, imageHeight)
  }

  if (sourceWidth === imageWidth && sourceHeight === imageHeight) {
    return normalizeCanvasImageDisplayCrop(item.crop, imageWidth, imageHeight)
  }

  const scaleX = imageWidth / sourceWidth
  const scaleY = imageHeight / sourceHeight

  return normalizeCanvasImageDisplayCrop(
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
  const sourceWidth =
    typeof item.sourceWidth === 'number' &&
    Number.isFinite(item.sourceWidth) &&
    item.sourceWidth > 0
      ? item.sourceWidth
      : assetWidth
  const sourceHeight =
    typeof item.sourceHeight === 'number' &&
    Number.isFinite(item.sourceHeight) &&
    item.sourceHeight > 0
      ? item.sourceHeight
      : assetHeight

  const displayCrop = normalizeCanvasImageDisplayCrop(item.crop, sourceWidth, sourceHeight)
  if (!displayCrop) {
    return null
  }

  const widthScale = item.width / displayCrop.width
  const heightScale = item.height / displayCrop.height

  return {
    left: -displayCrop.x * widthScale,
    top: -displayCrop.y * heightScale,
    width: sourceWidth * widthScale,
    height: sourceHeight * heightScale
  }
}
