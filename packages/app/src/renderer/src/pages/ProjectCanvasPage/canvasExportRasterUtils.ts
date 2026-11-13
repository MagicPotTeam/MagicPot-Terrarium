export const EXPORT_IMAGE_PIXEL_RATIO = 1
export const EXPORT_IMAGE_PADDING = 0
export const EXPORT_IMAGE_MAX_SIDE = 16384
export const EXPORT_IMAGE_MAX_AREA = 33_554_432

export type CanvasRasterLimits = Readonly<{ maxSide: number; maxArea: number }>
export const AGENT_SELECTION_RASTER_LIMITS: CanvasRasterLimits = Object.freeze({ maxSide: 2000, maxArea: 4_000_000 })

export type CanvasExportRasterConfig = {
  pixelRatio: number
  canvasWidth: number
  canvasHeight: number
  wasClamped: boolean
}

export function resolveCanvasExportRasterConfig(
  width: number,
  height: number,
  desiredPixelRatio = EXPORT_IMAGE_PIXEL_RATIO,
  limits?: CanvasRasterLimits
): CanvasExportRasterConfig {
  if (limits && (!Number.isFinite(limits.maxSide) || !Number.isInteger(limits.maxSide) || limits.maxSide < 1 || !Number.isFinite(limits.maxArea) || !Number.isInteger(limits.maxArea) || limits.maxArea < 1)) throw new RangeError('Invalid raster limits')
  const maxSide = Math.min(EXPORT_IMAGE_MAX_SIDE, limits?.maxSide ?? EXPORT_IMAGE_MAX_SIDE)
  const maxArea = Math.min(EXPORT_IMAGE_MAX_AREA, limits?.maxArea ?? EXPORT_IMAGE_MAX_AREA)
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1
  let pixelRatio =
    Number.isFinite(desiredPixelRatio) && desiredPixelRatio > 0 ? desiredPixelRatio : 1

  const longestSide = Math.max(safeWidth * pixelRatio, safeHeight * pixelRatio)
  if (longestSide > maxSide) {
    pixelRatio *= maxSide / longestSide
  }

  const pixelArea = safeWidth * safeHeight * pixelRatio * pixelRatio
  if (pixelArea > maxArea) {
    pixelRatio *= Math.sqrt(maxArea / pixelArea)
  }

  if (limits) {
    // Reduce the shared scale, never crop a single dimension to satisfy a limit.
    // A one-pixel minimum can make an extreme aspect ratio impossible to represent.
    for (let attempt = 0; attempt < 4; attempt++) {
      const width = Math.max(1, Math.ceil(safeWidth * pixelRatio))
      const height = Math.max(1, Math.ceil(safeHeight * pixelRatio))
      if (Number.isFinite(width) && Number.isFinite(height) && width <= maxSide && height <= maxSide && width * height <= maxArea) break
      const factor = Math.min(maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height)))
      pixelRatio *= Math.min(factor, 1 - Number.EPSILON) * (1 - Number.EPSILON)
    }
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || safeWidth * pixelRatio < 1 || safeHeight * pixelRatio < 1) {
      throw new RangeError('Canvas overview cannot be represented within raster limits')
    }
  }
  const canvasWidth = Math.max(1, limits ? Math.ceil(safeWidth * pixelRatio) : Math.floor(safeWidth * pixelRatio))
  const canvasHeight = Math.max(1, limits ? Math.ceil(safeHeight * pixelRatio) : Math.floor(safeHeight * pixelRatio))
  if (limits && (canvasWidth > maxSide || canvasHeight > maxSide || canvasWidth * canvasHeight > maxArea)) {
    throw new RangeError('Canvas overview exceeds raster limits')
  }

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
