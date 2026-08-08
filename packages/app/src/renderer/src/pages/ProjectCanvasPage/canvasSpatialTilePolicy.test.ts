import { describe, expect, it } from 'vitest'
import {
  buildCanvasSpatialTilePolicy,
  chooseCanvasSpatialTileLevel,
  mapCanvasSpatialTileScreenPointToSource
} from './canvasSpatialTilePolicy'

const identity = {
  version: 1 as const,
  kind: 'session-blob' as const,
  sourceKey: 'session:large',
  sizeBytes: 10,
  mimeType: 'image/png',
  cacheKey: 'large'
}
const base = {
  sourceWidth: 10000,
  sourceHeight: 8000,
  crop: { x: 0, y: 0, width: 10000, height: 8000 },
  item: { x: 100, y: 50, width: 10000, height: 8000, scaleX: 1, scaleY: 1, rotation: 0 },
  stageScale: 1,
  stagePos: { x: 0, y: 0 },
  deviceScale: 1,
  visible: true,
  sourceIdentity: identity,
  source: new Blob(['source']),
  viewport: { x: 100, y: 50, width: 1000, height: 800 },
  levels: [0, 1, 2, 3],
  tileSize: 256,
  gutter: 4
}

describe('canvas spatial tile policy', () => {
  it('enables only for large visible assets and computes projected size internally', () => {
    expect(buildCanvasSpatialTilePolicy(base).enabled).toBe(true)
    expect(buildCanvasSpatialTilePolicy({ ...base, sourceWidth: 8191 }).reason).toBe('source-size')
    expect(
      buildCanvasSpatialTilePolicy({ ...base, item: { ...base.item, width: 4095, height: 4095 } })
        .reason
    ).toBe('projected-size')
    expect(buildCanvasSpatialTilePolicy({ ...base, stageScale: 0.15 }).reason).toBe(
      'overview-scale'
    )
    expect(buildCanvasSpatialTilePolicy({ ...base, visible: false }).reason).toBe('not-visible')
    expect(buildCanvasSpatialTilePolicy({ ...base, source: null }).reason).toBe('missing-source')
  })

  it('chooses a high-resolution level without exceeding source pixels per device pixel', () => {
    expect(
      chooseCanvasSpatialTileLevel({
        levels: [0, 1, 2, 3],
        cropWidth: 10000,
        cropHeight: 8000,
        itemWidth: 10000,
        itemHeight: 8000,
        scaleX: 1,
        scaleY: 1,
        stageScale: 0.5,
        deviceScale: 2
      })
    ).toBe(0)
    expect(
      chooseCanvasSpatialTileLevel({
        levels: [0, 1, 2, 3],
        cropWidth: 10000,
        cropHeight: 8000,
        itemWidth: 1000,
        itemHeight: 800,
        scaleX: 1,
        scaleY: 1,
        stageScale: 1,
        deviceScale: 1
      })
    ).toBe(3)
  })

  it('inverse transforms rotation, negative scale, crop, translation and DPR', () => {
    const decision = buildCanvasSpatialTilePolicy({
      ...base,
      crop: { x: 1000, y: 500, width: 4000, height: 3000 },
      item: { x: 200, y: 100, width: 3000, height: 2500, scaleX: -1, scaleY: 1, rotation: 90 },
      stagePos: { x: 30, y: 40 },
      stageScale: 2,
      deviceScale: 2,
      viewport: { x: 400, y: 200, width: 6500, height: 6500 }
    })
    expect(decision.sourceSpaceVisibleRect).not.toBeNull()
    expect(decision.sourceSpaceVisibleRect!.x).toBeGreaterThanOrEqual(1000)
    expect(decision.sourceSpaceVisibleRect!.y).toBeGreaterThanOrEqual(500)
    expect(
      decision.sourceSpaceVisibleRect!.x + decision.sourceSpaceVisibleRect!.width
    ).toBeLessThanOrEqual(5000)
    expect(
      decision.tasks.every((task) => task.scaleDenominator === decision.scaleDenominator)
    ).toBe(true)
  })

  it('round-trips exact source points through the left-origin sprite transform', () => {
    const input = {
      ...base,
      crop: { x: 100, y: 200, width: 4000, height: 3000 },
      item: { x: 40, y: 60, width: 800, height: 600, scaleX: -1.5, scaleY: 0.75, rotation: 37 },
      stagePos: { x: 13, y: 29 },
      stageScale: 1.75,
      viewport: { x: 0, y: 0, width: 100, height: 100 }
    }
    const forward = (source: { x: number; y: number }) => {
      const rx =
        (source.x - input.crop.x) * (input.item.width / input.crop.width) * input.item.scaleX
      const ry =
        (source.y - input.crop.y) * (input.item.height / input.crop.height) * input.item.scaleY
      const radians = (input.item.rotation * Math.PI) / 180
      return {
        x:
          input.stagePos.x +
          input.stageScale * (input.item.x + Math.cos(radians) * rx - Math.sin(radians) * ry),
        y:
          input.stagePos.y +
          input.stageScale * (input.item.y + Math.sin(radians) * rx + Math.cos(radians) * ry)
      }
    }
    for (const source of [
      { x: 100, y: 200 },
      { x: 2100, y: 1700 },
      { x: 4100, y: 3200 }
    ]) {
      const mapped = mapCanvasSpatialTileScreenPointToSource(forward(source), input)
      expect(mapped.x).toBeCloseTo(source.x, 8)
      expect(mapped.y).toBeCloseTo(source.y, 8)
    }
    expect(mapCanvasSpatialTileScreenPointToSource(forward({ x: 2100, y: 1700 }), input)).toEqual(
      expect.objectContaining({ x: expect.closeTo(2100, 8), y: expect.closeTo(1700, 8) })
    )
  })

  it('rejects invalid transforms and viewport intersections outside the crop', () => {
    expect(
      buildCanvasSpatialTilePolicy({ ...base, item: { ...base.item, scaleX: 0 } }).reason
    ).toBe('invalid-transform')
    expect(
      buildCanvasSpatialTilePolicy({ ...base, item: { ...base.item, rotation: Number.NaN } }).reason
    ).toBe('invalid-transform')
    expect(
      buildCanvasSpatialTilePolicy({
        ...base,
        viewport: { x: 50000, y: 50000, width: 10, height: 10 }
      }).reason
    ).toBe('not-visible')
  })

  it('builds visible and overscan tasks without limiting task count', () => {
    const decision = buildCanvasSpatialTilePolicy({
      ...base,
      viewport: { x: 100, y: 50, width: 3000, height: 3000 },
      overscanTiles: 2
    })
    expect(decision.tasks.length).toBeGreaterThan(20)
    expect(decision.tasks.some((task) => task.priority === 'visible')).toBe(true)
    expect(decision.tasks.some((task) => task.priority === 'overscan')).toBe(true)
  })
})
