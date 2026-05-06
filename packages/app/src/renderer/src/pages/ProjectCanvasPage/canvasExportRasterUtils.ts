export const EXPORT_IMAGE_PIXEL_RATIO = 1
export const EXPORT_IMAGE_PADDING = 0
export const EXPORT_IMAGE_MAX_SIDE = 16384
export const EXPORT_IMAGE_MAX_AREA = 134_217_728

export type CanvasExportRasterConfig = {
  pixelRatio: number
  canvasWidth: number
  canvasHeight: number
  wasClamped: boolean
}

export function resolveCanvasExportRasterConfig(
  width: number,
  height: number,
  desiredPixelRatio = EXPORT_IMAGE_PIXEL_RATIO
): CanvasExportRasterConfig {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1
  let pixelRatio =
    Number.isFinite(desiredPixelRatio) && desiredPixelRatio > 0 ? desiredPixelRatio : 1

  const longestSide = Math.max(safeWidth * pixelRatio, safeHeight * pixelRatio)
  if (longestSide > EXPORT_IMAGE_MAX_SIDE) {
    pixelRatio *= EXPORT_IMAGE_MAX_SIDE / longestSide
  }

  const pixelArea = safeWidth * safeHeight * pixelRatio * pixelRatio
  if (pixelArea > EXPORT_IMAGE_MAX_AREA) {
    pixelRatio *= Math.sqrt(EXPORT_IMAGE_MAX_AREA / pixelArea)
  }

  const canvasWidth = Math.max(1, Math.floor(safeWidth * pixelRatio))
  const canvasHeight = Math.max(1, Math.floor(safeHeight * pixelRatio))

  return {
    pixelRatio,
    canvasWidth,
    canvasHeight,
    wasClamped:
      Math.abs(pixelRatio - desiredPixelRatio) > 1e-6 ||
      canvasWidth !== Math.round(safeWidth * desiredPixelRatio) ||
      canvasHeight !== Math.round(safeHeight * desiredPixelRatio)
  }
}
