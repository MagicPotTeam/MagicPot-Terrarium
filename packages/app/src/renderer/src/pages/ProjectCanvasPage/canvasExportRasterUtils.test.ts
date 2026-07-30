import { describe, expect, it } from 'vitest'
import { EXPORT_IMAGE_MAX_AREA, resolveCanvasExportRasterConfig } from './canvasExportRasterUtils'

describe('resolveCanvasExportRasterConfig', () => {
  it('caps raster exports at 32 megapixels', () => {
    expect(EXPORT_IMAGE_MAX_AREA).toBe(33_554_432)

    const config = resolveCanvasExportRasterConfig(10_000, 10_000, 1)

    expect(config.canvasWidth * config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_AREA)
    expect(config.wasClamped).toBe(true)
  })

  it('downscales the observed 7581x5064 export within the area limit', () => {
    const config = resolveCanvasExportRasterConfig(7581, 5064, 1)

    expect(config.pixelRatio).toBeCloseTo(0.9348993309, 10)
    expect(config.canvasWidth).toBe(7087)
    expect(config.canvasHeight).toBe(4734)
    expect(config.canvasWidth * config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_AREA)
    expect(config.wasClamped).toBe(true)
  })
})
