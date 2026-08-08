import { describe, expect, it, vi } from 'vitest'
import {
  CANVAS_SPATIAL_TILE_CANVAS_SIZE,
  CANVAS_SPATIAL_TILE_CONTENT_SIZE,
  CANVAS_SPATIAL_TILE_GUTTER,
  createCanvasSpatialTileCanvasPool,
  drawDecodedCanvasSpatialTile,
  type CanvasSpatialTileCanvasLike
} from './canvasSpatialTileCanvas'
import { createCanvasSpatialTileDescriptor } from './canvasSpatialTileTypes'

const sourceIdentity = {
  version: 1 as const,
  kind: 'local-file' as const,
  canonicalPath: 'c:/images/tile.png',
  sizeBytes: 100,
  lastModifiedMs: 200,
  cacheKey: 'tile'
}

function createMockCanvas() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn()
  }
  const canvas: CanvasSpatialTileCanvasLike = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context)
  }
  return { canvas, context }
}

describe('canvas spatial tile canvas helper', () => {
  it('uses the bounded 512 content plus 2 pixel gutter canvas geometry', () => {
    expect(CANVAS_SPATIAL_TILE_CONTENT_SIZE).toBe(512)
    expect(CANVAS_SPATIAL_TILE_GUTTER).toBe(2)
    expect(CANVAS_SPATIAL_TILE_CANVAS_SIZE).toBe(516)
  })

  it('draws only an already-cropped decode bitmap and reports edge content offset', () => {
    const { canvas, context } = createMockCanvas()
    const pool = createCanvasSpatialTileCanvasPool(() => canvas)
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity,
      sourceWidth: 1024,
      sourceHeight: 1024,
      tileSize: 512,
      gutter: 2,
      levels: [0]
    })

    const bitmap = { width: 514, height: 514 }
    const rendered = drawDecodedCanvasSpatialTile({
      bitmap,
      descriptor,
      address: { level: 0, x: 0, y: 0 },
      pool
    })

    expect(rendered.canvas).toBe(canvas)
    expect(rendered.contentRect).toEqual({ x: 0, y: 0, width: 512, height: 512 })
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 514, 514)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 514, 514)
    rendered.release()
    rendered.release()
    expect(pool.acquire(1, 1)).toBe(canvas)
  })

  it('reports the full gutter offset for an interior tile without cropping an image', () => {
    const { canvas } = createMockCanvas()
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Expected mock context.')
    const pool = createCanvasSpatialTileCanvasPool(() => canvas)
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity,
      sourceWidth: 2048,
      sourceHeight: 2048,
      tileSize: 512,
      gutter: 2,
      levels: [0]
    })

    const rendered = drawDecodedCanvasSpatialTile({
      bitmap: { width: 516, height: 516 },
      descriptor,
      address: { level: 0, x: 1, y: 1 },
      pool
    })

    expect(rendered.contentRect).toEqual({ x: 2, y: 2, width: 512, height: 512 })
    rendered.release()
    rendered.release()
    expect(pool.acquire(1, 1)).toBe(canvas)
    expect(context.drawImage).toHaveBeenCalledTimes(1)
  })

  it('accepts a variable-size clamped bitmap on the bottom-right edge', () => {
    const { canvas, context } = createMockCanvas()
    const pool = createCanvasSpatialTileCanvasPool(() => canvas)
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity,
      sourceWidth: 513,
      sourceHeight: 513,
      tileSize: 512,
      gutter: 2,
      levels: [0]
    })

    const bitmap = { width: 3, height: 3 }
    const rendered = drawDecodedCanvasSpatialTile({
      bitmap,
      descriptor,
      address: { level: 0, x: 1, y: 1 },
      pool
    })

    expect(canvas.width).toBe(3)
    expect(canvas.height).toBe(3)
    expect(rendered.contentRect).toEqual({ x: 2, y: 2, width: 1, height: 1 })
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 3, 3)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 3, 3)
    rendered.release()
    expect(pool.acquire(1, 1)).toBe(canvas)
  })

  it('allows concurrent active canvases while bounding idle retention', () => {
    const created: CanvasSpatialTileCanvasLike[] = []
    const pool = createCanvasSpatialTileCanvasPool(() => {
      const { canvas } = createMockCanvas()
      created.push(canvas)
      return canvas
    }, 1)

    const first = pool.acquire(516, 516)
    const second = pool.acquire(516, 516)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    const renderedFirst = drawDecodedCanvasSpatialTile({
      bitmap: { width: 514, height: 514 },
      descriptor: createCanvasSpatialTileDescriptor({
        sourceIdentity,
        sourceWidth: 1024,
        sourceHeight: 1024,
        tileSize: 512,
        gutter: 2,
        levels: [0]
      }),
      address: { level: 0, x: 0, y: 0 },
      pool
    })
    const renderedSecond = drawDecodedCanvasSpatialTile({
      bitmap: { width: 514, height: 514 },
      descriptor: createCanvasSpatialTileDescriptor({
        sourceIdentity,
        sourceWidth: 1024,
        sourceHeight: 1024,
        tileSize: 512,
        gutter: 2,
        levels: [0]
      }),
      address: { level: 0, x: 1, y: 1 },
      pool
    })
    expect(renderedFirst.canvas).not.toBe(renderedSecond.canvas)
    renderedFirst.release()
    renderedSecond.release()
  })

  it('returns a canvas after a drawing error without limiting active acquisition', () => {
    const first = createMockCanvas()
    first.canvas.getContext = vi.fn(() => {
      throw new Error('draw setup failed')
    })
    const second = createMockCanvas()
    const canvases = [first.canvas, second.canvas]
    const pool = createCanvasSpatialTileCanvasPool(() => canvases.shift() ?? null, 1)
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity,
      sourceWidth: 512,
      sourceHeight: 512,
      tileSize: 512,
      gutter: 2,
      levels: [0]
    })

    expect(() =>
      drawDecodedCanvasSpatialTile({
        bitmap: { width: 512, height: 512 },
        descriptor,
        address: { level: 0, x: 0, y: 0 },
        pool
      })
    ).toThrow('draw setup failed')
    expect(pool.acquire(1, 1)).toBe(first.canvas)
  })
})
