import { describe, expect, it } from 'vitest'
import { buildCanvasSpatialTileRenderModel } from './canvasSpatialTileRenderModel'
import type { CanvasSpatialTileGeometry } from './canvasSpatialTileTypes'

const transform = {
  x: 10,
  y: 20,
  width: 400,
  height: 300,
  scaleX: 1,
  scaleY: 1,
  rotation: 0
}

function geometry(overrides: Partial<CanvasSpatialTileGeometry> = {}): CanvasSpatialTileGeometry {
  return {
    levelRect: { x: 512, y: 0, width: 489, height: 512 },
    decodeRect: { x: 510, y: 0, width: 491, height: 512 },
    originalSourceRect: { x: 512, y: 0, width: 489, height: 512 },
    contentOffset: { x: 2, y: 0 },
    ...overrides
  }
}

function build(overrides: Partial<Parameters<typeof buildCanvasSpatialTileRenderModel>[0]> = {}) {
  return buildCanvasSpatialTileRenderModel({
    mode: 'tiles',
    itemId: 'image-1',
    zIndex: 7,
    interactionProxy: 'canvas-image-node',
    transform,
    sourceWidth: 1001,
    sourceHeight: 513,
    tileKey: 'spatial-tile:source:v1:0:1:0:512:2',
    geometry: geometry(),
    ...overrides
  })
}

describe('buildCanvasSpatialTileRenderModel', () => {
  it('does not create a model for ordinary single-sprite rendering', () => {
    expect(build({ mode: 'single-sprite' })).toBeNull()
  })

  it('rejects a crop completely outside source bounds', () => {
    expect(build({ crop: { x: 1100, y: 0, width: 20, height: 20 } })).toBeNull()
  })

  it('clips a partial crop and keeps edge-gutter frame based on decoded bitmap size', () => {
    const model = build({ crop: { x: 700, y: 50, width: 400, height: 200 } })

    expect(model?.child.position).toEqual({ x: 0, y: 0 })
    expect(model?.child.size).toEqual({ width: 301, height: 200 })
    expect(model?.texture.contentFrame).toEqual({
      x: 190,
      y: 50,
      width: 301,
      height: 200
    })
    expect(model?.texture.uv).toEqual({
      u0: 190 / 491,
      v0: 50 / 512,
      u1: 491 / 491,
      v1: 250 / 512
    })
  })

  it('uses variable-size odd-source level geometry without assuming a 516px bitmap', () => {
    const model = build({
      geometry: geometry({
        levelRect: { x: 500, y: 256, width: 13, height: 9 },
        decodeRect: { x: 498, y: 254, width: 17, height: 13 },
        originalSourceRect: { x: 1000, y: 512, width: 1, height: 1 },
        contentOffset: { x: 2, y: 2 }
      }),
      crop: { x: 1000, y: 512, width: 1, height: 1 }
    })

    expect(model?.texture.contentFrame).toEqual({
      x: 2,
      y: 2,
      width: 13,
      height: 9
    })
    expect(model?.texture.uv).toEqual({
      u0: 2 / 17,
      v0: 2 / 13,
      u1: 15 / 17,
      v1: 11 / 13
    })
  })

  it('preserves rotation and negative scale on the item container', () => {
    const model = build({
      transform: { ...transform, rotation: Math.PI / 3, scaleX: -2, scaleY: -0.5 }
    })

    expect(model?.containerTransform).toMatchObject({
      rotation: Math.PI / 3,
      scaleX: -2 * (400 / 1001),
      scaleY: -0.5 * (300 / 513)
    })
  })

  it('keeps resource tileKey stable across crop and transform changes', () => {
    const base = build()
    const cropChanged = build({ crop: { x: 600, y: 0, width: 200, height: 300 } })
    const transformChanged = build({ transform: { ...transform, x: 99, rotation: 0.25 } })

    expect(cropChanged?.tileKey).toBe(base?.tileKey)
    expect(cropChanged?.geometryKey).not.toBe(base?.geometryKey)
    expect(cropChanged?.transformKey).not.toBe(base?.transformKey)
    expect(transformChanged?.tileKey).toBe(base?.tileKey)
    expect(transformChanged?.geometryKey).toBe(base?.geometryKey)
    expect(transformChanged?.transformKey).not.toBe(base?.transformKey)
  })
})
