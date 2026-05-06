import type { CanvasImageAsset, CanvasImageItem } from './types'

const CANVAS_IMAGE_PLACEHOLDER_ASSET_MARKER = '__projectCanvasPlaceholderAsset'

export function getCanvasImageAssetSize(image: CanvasImageAsset | null | undefined): {
  width: number
  height: number
} {
  if (!image) {
    return { width: 0, height: 0 }
  }

  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height
    }
  }

  return {
    width: image.width,
    height: image.height
  }
}

export function markCanvasImagePlaceholderAsset<T extends CanvasImageAsset>(image: T): T {
  try {
    Object.defineProperty(image, CANVAS_IMAGE_PLACEHOLDER_ASSET_MARKER, {
      configurable: false,
      enumerable: false,
      value: true
    })
  } catch {
    ;(image as CanvasImageAsset & Record<string, unknown>)[CANVAS_IMAGE_PLACEHOLDER_ASSET_MARKER] =
      true
  }

  return image
}

export function isCanvasImagePlaceholderAsset(image: CanvasImageAsset | null | undefined): boolean {
  return Boolean(
    image &&
    (image as CanvasImageAsset & Record<string, unknown>)[CANVAS_IMAGE_PLACEHOLDER_ASSET_MARKER]
  )
}

export function isCanvasImageDeferredPlaceholderPreview(
  item: Pick<CanvasImageItem, 'image' | 'sourceWidth' | 'sourceHeight' | 'width' | 'height'>
): boolean {
  const image = item.image
  if (!image) {
    return false
  }

  if (isCanvasImagePlaceholderAsset(image)) {
    return true
  }

  if (typeof HTMLCanvasElement === 'undefined' || !(image instanceof HTMLCanvasElement)) {
    return false
  }

  const { width: previewWidth, height: previewHeight } = getCanvasImageAssetSize(image)
  const sourceWidth = item.sourceWidth ?? item.width
  const sourceHeight = item.sourceHeight ?? item.height
  const previewMaxSide = Math.max(previewWidth, previewHeight)
  const sourceMaxSide = Math.max(sourceWidth, sourceHeight)

  if (
    previewWidth <= 0 ||
    previewHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    previewMaxSide > 512 ||
    sourceMaxSide <= previewMaxSide * 2
  ) {
    return false
  }

  const previewAspect = previewWidth / previewHeight
  const sourceAspect = sourceWidth / sourceHeight
  if (!Number.isFinite(previewAspect) || !Number.isFinite(sourceAspect) || sourceAspect <= 0) {
    return false
  }

  return Math.abs(previewAspect - sourceAspect) / sourceAspect <= 0.05
}
