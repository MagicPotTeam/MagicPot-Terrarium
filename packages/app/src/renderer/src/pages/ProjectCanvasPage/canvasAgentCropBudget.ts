import { EXPORT_IMAGE_MAX_AREA, EXPORT_IMAGE_MAX_SIDE } from './canvasExportRasterUtils'

export class CanvasAgentCropBudgetError extends RangeError {
  constructor() { super('Canvas image crop is too large to prepare safely') }
}

/** Guard the exact crop output; never scale or mutate tool inputs to meet the limit. */
export function assertCanvasAttachmentCropOutputSize(crop: { width: number; height: number }): void {
  const width = Math.max(1, Math.round(crop.width))
  const height = Math.max(1, Math.round(crop.height))
  if (
    !Number.isFinite(crop.width) || crop.width <= 0 ||
    !Number.isFinite(crop.height) || crop.height <= 0 ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width > EXPORT_IMAGE_MAX_SIDE || height > EXPORT_IMAGE_MAX_SIDE ||
    width * height > EXPORT_IMAGE_MAX_AREA
  ) throw new CanvasAgentCropBudgetError()
}
