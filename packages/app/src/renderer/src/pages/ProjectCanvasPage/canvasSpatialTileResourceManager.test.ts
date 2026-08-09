import { describe, expect, it, vi } from 'vitest'

import { CanvasSpatialTileResourceManager } from './canvasSpatialTileResourceManager'

describe('CanvasSpatialTileResourceManager', () => {
  it('disposes an owned image bitmap exactly once on replacement and invalidation', () => {
    const close = vi.fn()
    const manager = new CanvasSpatialTileResourceManager()
    const request = { tileKey: 'tile:0:0:0', sourceKey: 'source-a', level: 2, generation: 1 }

    manager.begin(request)
    expect(manager.commit(request, { imageBitmap: { close }, ownership: 'owned' })).toBe(true)
    expect(manager.invalidateTile(request.tileKey, request.generation)).toBe(true)
    expect(manager.invalidateTile(request.tileKey)).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeTileCount: 0,
      activeAssetCount: 0,
      disposedAssetCount: 1
    })
  })

  it('disposes a composed owned asset exactly once and returns its opaque value', () => {
    const disposeUrl = vi.fn()
    const closeBitmap = vi.fn()
    const destroyTexture = vi.fn()
    const value = { textureId: 'texture-1' }
    const manager = new CanvasSpatialTileResourceManager()
    const request = { tileKey: 'tile:composed', generation: 1 }

    manager.begin(request)
    expect(
      manager.commit(request, {
        value,
        disposables: [disposeUrl, closeBitmap, destroyTexture],
        ownership: 'owned'
      })
    ).toBe(true)
    expect(manager.getCurrentAsset(request)).toBe(value)
    manager.invalidateTile(request.tileKey, request.generation)

    expect(disposeUrl).toHaveBeenCalledTimes(1)
    expect(closeBitmap).toHaveBeenCalledTimes(1)
    expect(destroyTexture).toHaveBeenCalledTimes(1)
    expect(manager.getCurrentAsset(request)).toBeUndefined()
  })

  it('does not dispose borrowed composed assets', () => {
    const disposables = [vi.fn(), vi.fn(), vi.fn()]
    const manager = new CanvasSpatialTileResourceManager()
    const request = { tileKey: 'tile:borrowed-composed', generation: 1 }

    manager.begin(request)
    manager.commit(request, { value: 'borrowed', disposables, ownership: 'borrowed' })
    manager.invalidateTile(request.tileKey, request.generation)

    disposables.forEach((dispose) => expect(dispose).not.toHaveBeenCalled())
  })

  it('releases stale composed assets without affecting the current generation', () => {
    const staleDisposables = [vi.fn(), vi.fn(), vi.fn()]
    const currentDisposables = [vi.fn(), vi.fn(), vi.fn()]
    const manager = new CanvasSpatialTileResourceManager()
    const stale = { tileKey: 'tile:stale-composed', generation: 1 }
    const current = { ...stale, generation: 2 }

    manager.begin(stale)
    manager.begin(current)
    expect(manager.commit(stale, { disposables: staleDisposables, ownership: 'owned' })).toBe(false)
    expect(
      manager.commit(current, {
        value: 'current',
        disposables: currentDisposables,
        ownership: 'owned'
      })
    ).toBe(true)
    staleDisposables.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
    currentDisposables.forEach((dispose) => expect(dispose).not.toHaveBeenCalled())
    manager.invalidateTile(current.tileKey, current.generation)
    currentDisposables.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
  })
  it('accepts a generic owned releasable asset and leaves borrowed assets untouched', () => {
    const disposeOwned = vi.fn()
    const disposeBorrowed = vi.fn()
    const manager = new CanvasSpatialTileResourceManager()
    const owned = { tileKey: 'tile:owned', generation: 1 }
    const borrowed = { tileKey: 'tile:borrowed', generation: 1 }

    manager.begin(owned)
    manager.begin(borrowed)
    manager.commit(owned, { releasable: { dispose: disposeOwned }, ownership: 'owned' })
    manager.commit(borrowed, { releasable: { dispose: disposeBorrowed }, ownership: 'borrowed' })
    manager.clear()

    expect(disposeOwned).toHaveBeenCalledTimes(1)
    expect(disposeBorrowed).not.toHaveBeenCalled()
  })

  it('rejects stale generations and disposes late owned assets immediately', () => {
    const staleDispose = vi.fn()
    const currentDispose = vi.fn()
    const manager = new CanvasSpatialTileResourceManager()
    const stale = { tileKey: 'tile:stale', sourceKey: 'source-a', level: 1, generation: 1 }
    const current = { ...stale, generation: 2 }

    manager.begin(stale)
    manager.begin(current)
    expect(manager.isCurrent(stale)).toBe(false)
    expect(
      manager.commit(stale, { releasable: { dispose: staleDispose }, ownership: 'owned' })
    ).toBe(false)
    expect(staleDispose).toHaveBeenCalledTimes(1)
    expect(
      manager.commit(current, { releasable: { dispose: currentDispose }, ownership: 'owned' })
    ).toBe(true)
    manager.invalidateTile(current.tileKey, current.generation)
    expect(currentDispose).toHaveBeenCalledTimes(1)
  })

  it('preserves this for owned releasable asset disposal', () => {
    const dispose = vi.fn(function (this: { disposed: boolean }) {
      this.disposed = true
    })
    const asset = { disposed: false, dispose }
    const manager = new CanvasSpatialTileResourceManager()
    const request = { tileKey: 'tile:this', generation: 1 }

    manager.begin(request)
    manager.commit(request, { releasable: asset, ownership: 'owned' })
    manager.invalidateTile(request.tileKey, request.generation)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(asset.disposed).toBe(true)
  })

  it('keeps same-generation begin idempotent and replaces assets exactly once', () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const manager = new CanvasSpatialTileResourceManager()
    const request = {
      tileKey: 'tile:same-generation',
      sourceKey: 'source',
      level: 1,
      generation: 7
    }

    manager.begin(request)
    manager.commit(request, { releasable: { dispose: firstDispose }, ownership: 'owned' })
    manager.begin(request)
    expect(
      manager.commit(request, { releasable: { dispose: secondDispose }, ownership: 'owned' })
    ).toBe(true)

    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).not.toHaveBeenCalled()
    manager.invalidateTile(request.tileKey, request.generation)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
  })

  it('invalidates only matching source/level assets and has no viewport eviction', () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const manager = new CanvasSpatialTileResourceManager()
    const first = { tileKey: 'tile:first', sourceKey: 'source-a', level: 1, generation: 1 }
    const second = { tileKey: 'tile:second', sourceKey: 'source-a', level: 2, generation: 1 }

    manager.begin(first)
    manager.begin(second)
    manager.commit(first, { releasable: { dispose: firstDispose }, ownership: 'owned' })
    manager.commit(second, { releasable: { dispose: secondDispose }, ownership: 'owned' })
    expect(manager.invalidateSourceLevel('source-a', 1)).toEqual(['tile:first'])
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).not.toHaveBeenCalled()
    expect(manager.getMetricsSnapshot().activeTileCount).toBe(1)
  })
})
