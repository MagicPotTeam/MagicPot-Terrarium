import { describe, expect, it } from 'vitest'
import { AGENT_SELECTION_RASTER_LIMITS, EXPORT_IMAGE_MAX_AREA, resolveCanvasExportRasterConfig } from './canvasExportRasterUtils'

describe('resolveCanvasExportRasterConfig', () => {
  it('bounds agent overviews without changing ordinary export dimensions', () => {
    for (const [width, height] of [[10000, 10000], [30000, 1000], [1000, 30000], [100, 200], [2000.5, 1999.8]]) {
      const config = resolveCanvasExportRasterConfig(width, height, 1, AGENT_SELECTION_RASTER_LIMITS)
      expect(config.canvasWidth).toBeLessThanOrEqual(2000)
      expect(config.canvasHeight).toBeLessThanOrEqual(2000)
      expect(config.canvasHeight * config.canvasWidth).toBeLessThanOrEqual(4000000)
      expect(config.canvasWidth).toBeGreaterThanOrEqual(width * config.pixelRatio)
      expect(config.canvasHeight).toBeGreaterThanOrEqual(height * config.pixelRatio)
    }
    expect(() => resolveCanvasExportRasterConfig(10000000, 0.1, 1, AGENT_SELECTION_RASTER_LIMITS)).toThrow(/cannot be represented/)
    expect(resolveCanvasExportRasterConfig(6000, 4000)).toMatchObject({ canvasWidth: 6000, canvasHeight: 4000, pixelRatio: 1 })
    expect(resolveCanvasExportRasterConfig(100, 200, 1, AGENT_SELECTION_RASTER_LIMITS)).toMatchObject({ canvasWidth: 100, canvasHeight: 200, pixelRatio: 1 })
    expect(() => resolveCanvasExportRasterConfig(10, 10, 1, { maxSide: 0, maxArea: 1 })).toThrow(RangeError)
  })

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
