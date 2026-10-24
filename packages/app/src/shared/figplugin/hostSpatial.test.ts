import { describe, expect, it } from 'vitest'
import {
  canvasMetrics,
  hostCanvasSchema,
  hostSpatialSchema,
  spatialBounds,
  spatialEdges
} from './hostSpatial'
import { hostContextSchema, parseHostPlan, HOST_CONTEXT_MAX_BYTES } from './hostPlan'
const rect = { x: -24.5, y: 16.25, width: 64, height: 32 }
const makeContext = (host: 'figma' | 'photoshop' = 'figma') => ({
  version: 1,
  host,
  documentId: 'doc',
  scopeId: 'page',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: '1',
      type: 'node',
      name: 'Owned',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      commands: ['node.rename'],
      spatial: spatialBounds(
        host === 'figma' ? 'page' : 'document',
        rect.x,
        rect.y,
        rect.width,
        rect.height
      )
    }
  ]
})
describe('bounded host spatial observations', () => {
  it('preserves fractional and negative absolute coordinates without unit conversion', () => {
    expect(spatialBounds('page', rect.x, rect.y, rect.width, rect.height)).toEqual({
      status: 'available',
      coordinateSpace: 'page',
      unit: 'px',
      boundsKind: 'axis-aligned-no-effects',
      bounds: rect
    })
    expect(spatialEdges(-24.5, 16.25, 39.5, 48.25)).toEqual({
      status: 'available',
      coordinateSpace: 'document',
      unit: 'px',
      boundsKind: 'axis-aligned-no-effects',
      bounds: rect
    })
  })
  it('allows genuine zero-size bounds but never invents zero for absent geometry', () => {
    expect(spatialBounds('page', 0, 0, 0, 0).status).toBe('available')
    expect(spatialBounds('page', undefined, 0, 0, 0)).toEqual({ status: 'unavailable' })
  })
  it.each([NaN, Infinity, -Infinity, '64', null, undefined, true, {}, 10_000_001])(
    'does not coerce or clamp invalid bounds %s',
    (value) => {
      expect(spatialBounds('page', value, 0, 64, 32)).toEqual({ status: 'unavailable' })
      expect(spatialEdges(0, 0, value, 32)).toEqual({ status: 'unavailable' })
    }
  )
  it.each([-1, -Infinity, NaN, '32', undefined, 10_000_001])(
    'refuses invalid extents %s',
    (value) => {
      expect(spatialBounds('page', 0, 0, value, 32).status).toBe('unavailable')
    }
  )
  it('refuses reversed or unbounded edges', () => {
    expect(spatialEdges(3, 0, 2, 5).status).toBe('unavailable')
    expect(spatialEdges(0, 3, 5, 2).status).toBe('unavailable')
    expect(spatialEdges(-10_000_000, 0, 10_000_000, 5).status).toBe('unavailable')
  })
  it('keeps pixel dimensions separate from resolution and pixel aspect ratio', () => {
    expect(canvasMetrics(320, 180, 300, 1.5)).toEqual({
      status: 'available',
      unit: 'px',
      width: 320,
      height: 180,
      resolutionPpi: 300,
      pixelAspectRatio: 1.5
    })
    expect(canvasMetrics(320, 180, 72, 1).status).toBe('available')
  })
  it.each([0, -1, NaN, Infinity, '300', undefined])(
    'refuses unknown canvas metrics %s',
    (value) => {
      expect(canvasMetrics(320, 180, value, 1)).toEqual({ status: 'unavailable' })
      expect(canvasMetrics(value, 180, 300, 1)).toEqual({ status: 'unavailable' })
    }
  )
  it('rejects unit, coordinate and authority ambiguity at the shared boundary', () => {
    const good = spatialBounds('page', 0, 0, 10, 10)
    for (const extra of [
      { unit: 'pt' },
      { coordinateSpace: 'parent' },
      { approved: true },
      { image: 'base64' },
      { boundsKind: 'local-transform' }
    ]) {
      expect(hostSpatialSchema.safeParse({ ...good, ...extra }).success).toBe(false)
    }
    expect(hostSpatialSchema.safeParse({ status: 'unavailable', bounds: rect }).success).toBe(false)
    expect(
      hostCanvasSchema.safeParse({ ...canvasMetrics(320, 180, 300, 1), documentPath: 'PRIVATE' })
        .success
    ).toBe(false)
  })
  it('preserves old contexts, enforces host coordinate spaces and never invents canvas dimensions', () => {
    const old = makeContext()
    Reflect.deleteProperty(old.nodes[0], 'spatial')
    expect(hostContextSchema.parse(old).nodes[0]).not.toHaveProperty('spatial')
    expect(hostContextSchema.safeParse(makeContext()).success).toBe(true)
    const ps = makeContext('photoshop')
    expect(
      hostContextSchema.safeParse({ ...ps, canvas: canvasMetrics(320, 180, 300, 1) }).success
    ).toBe(true)
    expect(
      hostContextSchema.safeParse({ ...makeContext(), canvas: canvasMetrics(320, 180, 300, 1) })
        .success
    ).toBe(false)
    expect(hostContextSchema.safeParse({ ...makeContext(), host: 'photoshop' }).success).toBe(false)
  })
  it('does not add move/resize commands or bypass the original context budget', () => {
    const context = hostContextSchema.parse(makeContext())
    expect(() =>
      parseHostPlan(
        JSON.stringify({
          schemaVersion: 2,
          kind: 'host-plan',
          captureId: context.captureId,
          steps: [{ command: 'node.move', targetId: '1', x: 5, y: 6 }]
        }),
        context
      )
    ).toThrow()
    const large = {
      ...makeContext(),
      nodes: Array.from({ length: 100 }, (_, i) => ({
        ...makeContext().nodes[0],
        id: String(i),
        name: 'x'.repeat(1000)
      }))
    }
    expect(JSON.stringify(large).length).toBeGreaterThan(HOST_CONTEXT_MAX_BYTES)
    expect(hostContextSchema.safeParse(large).success).toBe(false)
  })
})
