import { describe, expect, it, vi } from 'vitest'

import { SpatialTileResourceManager } from './spatialTileResourceManager'

describe('SpatialTileResourceManager', () => {
  it('releases each owned runtime asset exactly once on replacement and explicit release', () => {
    const close = vi.fn()
    const revoke = vi.fn()
    const deleteTexture = vi.fn()
    const manager = new SpatialTileResourceManager({
      revokeBlobUrl: revoke,
      deleteWebGLTexture: deleteTexture
    })
    const descriptor = { tileKey: 'tile:0:0:0', generation: 1 }
    const token = manager.beginRequest(descriptor)

    expect(
      manager.commit(token, {
        imageBitmap: { close },
        blobUrl: 'blob:tile',
        webglTexture: 'texture',
        imageBitmapOwnership: 'owned',
        blobUrlOwnership: 'owned',
        webglTextureOwnership: 'owned'
      })
    ).toBe(true)
    expect(manager.releaseTile(descriptor.tileKey, descriptor.generation)).toBe(true)
    expect(manager.releaseTile(descriptor.tileKey)).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(deleteTexture).toHaveBeenCalledTimes(1)
  })

  it('does not release borrowed runtime assets', () => {
    const close = vi.fn()
    const revoke = vi.fn()
    const deleteTexture = vi.fn()
    const manager = new SpatialTileResourceManager({
      revokeBlobUrl: revoke,
      deleteWebGLTexture: deleteTexture
    })
    const token = manager.beginRequest({ tileKey: 'tile:borrowed', generation: 1 })

    expect(
      manager.commit(token, {
        imageBitmap: { close },
        blobUrl: 'blob:borrowed',
        webglTexture: 'borrowed-texture',
        imageBitmapOwnership: 'borrowed',
        blobUrlOwnership: 'borrowed',
        webglTextureOwnership: 'borrowed'
      })
    ).toBe(true)
    manager.releaseTile('tile:borrowed')

    expect(close).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(deleteTexture).not.toHaveBeenCalled()
  })

  it('rejects stale generations and releases late owned assets immediately', () => {
    const staleClose = vi.fn()
    const currentClose = vi.fn()
    const manager = new SpatialTileResourceManager()
    const stale = manager.beginRequest({ tileKey: 'tile:stale', generation: 1 })
    const current = manager.beginRequest({ tileKey: 'tile:stale', generation: 2 })

    expect(manager.isCurrent(stale)).toBe(false)
    expect(
      manager.commit(stale, {
        imageBitmap: { close: staleClose },
        imageBitmapOwnership: 'owned'
      })
    ).toBe(false)
    expect(staleClose).toHaveBeenCalledTimes(1)

    expect(
      manager.commit(current, {
        imageBitmap: { close: currentClose },
        imageBitmapOwnership: 'owned'
      })
    ).toBe(true)
    manager.releaseTile('tile:stale', current.generation)
    expect(currentClose).toHaveBeenCalledTimes(1)
  })

  it('releases only explicitly released tiles and does not apply viewport eviction', () => {
    const close = vi.fn()
    const manager = new SpatialTileResourceManager()
    const token = manager.beginRequest({ tileKey: 'tile:outside', generation: 1 })
    manager.commit(token, { imageBitmap: { close }, imageBitmapOwnership: 'owned' })

    expect(manager.getMetricsSnapshot().activeTileCount).toBe(1)
    expect(close).not.toHaveBeenCalled()
    manager.releaseTile('tile:outside', 1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
