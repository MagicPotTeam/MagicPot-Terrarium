import { describe, expect, it } from 'vitest'

import {
  EXPORT_IMAGE_MAX_AREA,
  EXPORT_IMAGE_MAX_SIDE,
  resolveCanvasExportRasterConfig
} from './canvasExportRasterUtils'
import { getCanvasItemBounds } from './projectCanvasPageShared'

describe('resolveCanvasExportRasterConfig', () => {
  it('keeps regular exports at the requested raster size', () => {
    expect(resolveCanvasExportRasterConfig(1200, 800)).toEqual({
      pixelRatio: 1,
      canvasWidth: 1200,
      canvasHeight: 800,
      wasClamped: false
    })
  })

  it('downscales oversized selections before they exceed the canvas side limit', () => {
    const config = resolveCanvasExportRasterConfig(26929, 11355)

    expect(config.wasClamped).toBe(true)
    expect(config.canvasWidth).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_SIDE)
    expect(config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_SIDE)
    expect(config.canvasWidth / config.canvasHeight).toBeCloseTo(26929 / 11355, 2)
  })

  it('downscales large square exports to stay within the total pixel budget', () => {
    const config = resolveCanvasExportRasterConfig(16384, 16384)

    expect(config.wasClamped).toBe(true)
    expect(config.canvasWidth * config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_AREA)
  })
})

describe('getCanvasItemBounds', () => {
  it('expands rotated rect items into a rotation-aware AABB', () => {
    expect(
      getCanvasItemBounds({
        id: 'image-rotated',
        type: 'image',
        src: 'file:///image.png',
        fileName: 'image.png',
        x: 100,
        y: 200,
        width: 80,
        height: 40,
        rotation: 90,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false
      })
    ).toEqual({
      minX: 60,
      minY: 200,
      maxX: 100,
      maxY: 280
    })
  })

  it('applies scale and rotation to annotation line bounds', () => {
    const bounds = getCanvasItemBounds({
      id: 'annotation-line',
      type: 'annotation',
      shape: 'line',
      stroke: '#ffffff',
      fillOpacity: 0,
      strokeWidth: 2,
      label: 'Line',
      x: 120,
      y: 160,
      endX: 200,
      endY: 160,
      width: 80,
      height: 1,
      rotation: 90,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false
    })

    expect(bounds.minX).toBeCloseTo(120, 5)
    expect(bounds.maxX).toBeCloseTo(120, 5)
    expect(bounds.minY).toBeCloseTo(160, 5)
    expect(bounds.maxY).toBeCloseTo(240, 5)
  })
})
