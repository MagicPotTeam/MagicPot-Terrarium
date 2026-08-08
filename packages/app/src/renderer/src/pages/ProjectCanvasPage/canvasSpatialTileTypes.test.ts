import { describe, expect, it } from 'vitest'
import {
  buildCanvasSpatialTileKey,
  createCanvasSpatialTileDescriptor,
  getCanvasSpatialTileGeometry,
  listCanvasSpatialVisibleTiles
} from './canvasSpatialTileTypes'

const localIdentity = {
  version: 1 as const,
  kind: 'local-file' as const,
  canonicalPath: 'c:/images/a.png',
  sizeBytes: 100,
  lastModifiedMs: 200,
  cacheKey: 'local-a'
}
const sessionIdentity = {
  version: 1 as const,
  kind: 'session-blob' as const,
  sourceKey: 'session:a',
  sizeBytes: 100,
  mimeType: 'image/png',
  cacheKey: 'session-a'
}

describe('canvas spatial tile pure model', () => {
  it('describes levels and clamps non-divisible edge geometry', () => {
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity: localIdentity,
      sourceWidth: 1000,
      sourceHeight: 700,
      tileSize: 256,
      gutter: 8,
      levels: [0, 1, 3]
    })
    expect(descriptor.levels[1]).toMatchObject({
      level: 1,
      scaleDenominator: 2,
      levelWidth: 500,
      levelHeight: 350,
      cols: 2,
      rows: 2
    })
    const geometry = getCanvasSpatialTileGeometry(descriptor, { level: 1, x: 1, y: 1 })
    expect(geometry.levelRect).toEqual({ x: 256, y: 256, width: 244, height: 94 })
    expect(geometry.decodeRect).toEqual({ x: 248, y: 248, width: 252, height: 102 })
    expect(geometry.originalSourceRect).toEqual({ x: 512, y: 512, width: 488, height: 188 })
    expect(geometry.contentOffset).toEqual({ x: 8, y: 8 })
  })

  it('clamps visible tiles for negative and oversized source-space viewports', () => {
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity: localIdentity,
      sourceWidth: 1000,
      sourceHeight: 700,
      tileSize: 256,
      levels: [0]
    })
    const tiles = listCanvasSpatialVisibleTiles({
      descriptor,
      level: 0,
      viewport: { x: -100, y: -100, width: 2000, height: 2000 }
    })
    expect(tiles).toHaveLength(12)
    expect(tiles[0].address).toEqual({ level: 0, x: 0, y: 0 })
    expect(tiles.at(-1)?.address).toEqual({ level: 0, x: 3, y: 2 })
  })

  it('supports overscan and keys gutter configuration', () => {
    const descriptor = createCanvasSpatialTileDescriptor({
      sourceIdentity: localIdentity,
      sourceWidth: 1024,
      sourceHeight: 1024,
      tileSize: 256,
      gutter: 4,
      levels: [0]
    })
    const tiles = listCanvasSpatialVisibleTiles({
      descriptor,
      level: 0,
      viewport: { x: 256, y: 256, width: 256, height: 256 },
      overscanTiles: 1
    })
    expect(tiles).toHaveLength(9)
    expect(tiles[0].key).toContain(':256:4')
    expect(tiles[0].geometry.decodeRect.x).toBe(0)
  })

  it('does not collide across source identity kind or cache key', () => {
    const localKey = buildCanvasSpatialTileKey(
      createCanvasSpatialTileDescriptor({
        sourceIdentity: localIdentity,
        sourceWidth: 512,
        sourceHeight: 512,
        levels: [0]
      }),
      { level: 0, x: 0, y: 0 }
    )
    const sessionKey = buildCanvasSpatialTileKey(
      createCanvasSpatialTileDescriptor({
        sourceIdentity: sessionIdentity,
        sourceWidth: 512,
        sourceHeight: 512,
        levels: [0]
      }),
      { level: 0, x: 0, y: 0 }
    )
    const otherKey = buildCanvasSpatialTileKey(
      createCanvasSpatialTileDescriptor({
        sourceIdentity: { ...localIdentity, cacheKey: 'local-b' },
        sourceWidth: 512,
        sourceHeight: 512,
        levels: [0]
      }),
      { level: 0, x: 0, y: 0 }
    )
    expect(new Set([localKey, sessionKey, otherKey]).size).toBe(3)
  })
})
