import { describe, expect, it, vi } from 'vitest'
import {
  createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge,
  type CanvasSpatialTileNativeRegionRequest
} from './canvasSpatialTileWorkerProtocol'

function buildRequest(overrides: Partial<CanvasSpatialTileNativeRegionRequest> = {}) {
  return {
    sourcePath: 'C:/images/large.png',
    allowedRoots: ['C:/images'],
    sourceWidth: 10_000,
    sourceHeight: 8_000,
    x: 256,
    y: 512,
    width: 512,
    height: 512,
    outputWidth: 256,
    outputHeight: 256,
    maxOutputPixels: 4 * 1024 * 1024,
    maxOutputBytes: 32 * 1024 * 1024,
    timeoutMs: 15_000,
    cacheRoot: 'C:/cache',
    ...overrides
  }
}

function buildBridgeResult() {
  return {
    data: new Uint8Array([1, 2, 3]),
    sourceWidth: 10_000,
    sourceHeight: 8_000,
    x: 256,
    y: 512,
    width: 512,
    height: 512,
    outputWidth: 256,
    outputHeight: 256,
    mimeType: 'image/png' as const
  }
}

describe('createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge', () => {
  it('is unavailable without a bridge', () => {
    expect(
      createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
        {},
        { sourcePath: 'C:/images/large.png', maxOutputPixels: 4096, maxOutputBytes: 1024 }
      )
    ).toBeNull()
  })

  it('requires a request source and clamps output budgets', async () => {
    const createNativeRegion = vi.fn().mockResolvedValue(buildBridgeResult())
    const backend = createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
      { createNativeRegion },
      { sourcePath: 'C:/images/large.png', maxOutputPixels: 65_536, maxOutputBytes: 2048 }
    )

    await expect(backend?.(buildRequest({ sourcePath: '  ' }))).rejects.toThrow(
      /source path is required/
    )
    await expect(backend?.(buildRequest())).resolves.toMatchObject({
      sourcePath: 'C:/images/large.png',
      outputWidth: 256,
      outputHeight: 256,
      outputBytes: 3
    })
    expect(createNativeRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: 'C:/images/large.png',
        maxOutputPixels: 65_536,
        maxOutputBytes: 2048
      })
    )
  })

  it('pins a configured source and rejects a different request source', async () => {
    const createNativeRegion = vi.fn()
    const backend = createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
      { createNativeRegion },
      { sourcePath: 'C:/images/large.png', maxOutputPixels: 4096, maxOutputBytes: 1024 }
    )

    await expect(backend?.(buildRequest({ sourcePath: 'C:/other/secret.png' }))).rejects.toThrow(
      /source path does not match/
    )
    expect(createNativeRegion).not.toHaveBeenCalled()
  })

  it('rejects malformed bridge output instead of forwarding it', async () => {
    const createNativeRegion = vi.fn().mockResolvedValue({
      ...buildBridgeResult(),
      outputWidth: 10_000,
      outputHeight: 10_000
    })
    const backend = createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
      { createNativeRegion },
      { sourcePath: '', maxOutputPixels: 4096, maxOutputBytes: 1024 }
    )

    await expect(backend?.(buildRequest())).rejects.toThrow(/pixel budget/)
  })

  it('honors cancellation before and after the bridge call', async () => {
    const createNativeRegion = vi.fn().mockResolvedValue(buildBridgeResult())
    const backend = createCanvasSpatialTileNativeRegionBackendFromThumbnailBridge(
      { createNativeRegion },
      { sourcePath: 'C:/images/large.png', maxOutputPixels: 65_536, maxOutputBytes: 1024 }
    )
    const before = new AbortController()
    before.abort()
    await expect(backend?.(buildRequest(), before.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(createNativeRegion).not.toHaveBeenCalled()

    const after = new AbortController()
    const pending = backend?.(buildRequest(), after.signal)
    after.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
