import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanvasSpatialTileDescriptor,
  getCanvasSpatialTileGeometry
} from './canvasSpatialTileTypes'
import { generateCanvasSpatialTileBrowserCrop } from './canvasSpatialTileBrowserCrop.worker'

const sessionIdentity = {
  version: 1 as const,
  kind: 'session-blob' as const,
  sourceKey: 'session:test',
  sizeBytes: 123,
  mimeType: 'image/png',
  cacheKey: 'session-test'
}

describe('canvas spatial tile browser crop', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', undefined)
  })

  it('maps level 2 geometry to a clamped source crop and returns bitmap-local content rect', async () => {
    const bitmap = { width: 3, height: 2, close: vi.fn() }
    const createImageBitmap = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmap)
    const drawImage = vi.fn()
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas as any, 'getContext').mockReturnValue({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      clearRect: vi.fn(),
      drawImage
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(document as any, 'createElement').mockReturnValue(canvas)
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['tile'], { type: 'image/png' }))
    )

    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity: sessionIdentity,
      sourceWidth: 1001,
      sourceHeight: 701,
      tileSize: 256,
      gutter: 8,
      levels: [2]
    })
    const geometry = getCanvasSpatialTileGeometry(descriptor, { level: 2, x: 0, y: 0 })
    const result = await generateCanvasSpatialTileBrowserCrop({
      source: new Blob(['source'], { type: 'image/png' }),
      descriptor: { sourceWidth: descriptor.sourceWidth, sourceHeight: descriptor.sourceHeight },
      geometry,
      scaleDenominator: 4,
      preferWebp: false
    })

    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.any(Blob),
      0,
      0,
      1001,
      701,
      expect.objectContaining({
        resizeWidth: geometry.decodeRect.width,
        resizeHeight: geometry.decodeRect.height
      })
    )
    expect(result.width).toBe(geometry.decodeRect.width)
    expect(result.height).toBe(geometry.decodeRect.height)
    expect(result.contentRectInBitmap).toEqual({
      x: geometry.contentOffset.x,
      y: geometry.contentOffset.y,
      width: geometry.levelRect.width,
      height: geometry.levelRect.height
    })
    expect(result.geometry).toEqual(geometry)
    expect(bitmap.close).toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalledWith(
      bitmap,
      0,
      0,
      geometry.decodeRect.width,
      geometry.decodeRect.height
    )
  })
})
