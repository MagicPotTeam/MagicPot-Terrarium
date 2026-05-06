import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCanvasImageSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import {
  ensureCanvasThumbnailSet,
  getCanvasThumbnailRuntimeMetrics,
  readWarmCanvasThumbnailSet,
  resetCanvasThumbnailRuntimeMetrics
} from './canvasThumbnailWorkerClient'
import type {
  CanvasImageSourceIdentity,
  CanvasImageThumbnailLevel,
  CanvasThumbnailIpcBridge,
  CanvasThumbnailLevelSize
} from './canvasThumbnailTypes'

function createIdentity(): CanvasImageSourceIdentity {
  const identity = buildCanvasImageSourceIdentity({
    canonicalPath: 'C:/Images/ref.png',
    sizeBytes: 1234,
    lastModifiedMs: 5678
  })
  if (!identity) {
    throw new Error('Expected test source identity to be valid.')
  }
  return identity
}

function createLevel(maxSide: CanvasThumbnailLevelSize): CanvasImageThumbnailLevel {
  return {
    maxSide,
    width: maxSide,
    height: Math.max(1, Math.round(maxSide / 2)),
    mimeType: 'image/webp',
    filename: `${maxSide}.webp`,
    src: `local-media:///thumb/${maxSide}.webp`,
    sizeBytes: maxSide * 10
  }
}

function createCompleteLevels(): CanvasImageThumbnailLevel[] {
  return ([128, 256, 512, 1024, 2048] as const).map(createLevel)
}

describe('canvasThumbnailWorkerClient', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap
  const originalWorker = globalThis.Worker
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToBlob = HTMLCanvasElement.prototype.toBlob

  beforeEach(() => {
    resetCanvasThumbnailRuntimeMetrics()
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: undefined
    })
    URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`)
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: originalCreateImageBitmap
    })
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: originalWorker
    })
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toBlob = originalToBlob
    vi.restoreAllMocks()
  })

  it('returns a fresh warm-cache manifest without regenerating', async () => {
    const identity = createIdentity()
    const thumbnailSet = createCanvasThumbnailSet({
      identity,
      levels: createCompleteLevels()
    })
    const manifest = canvasThumbnailManifestFromSet(thumbnailSet)
    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest }))
    }

    const result = await readWarmCanvasThumbnailSet(identity, bridge)

    expect(result.status).toBe('cache-hit')
    expect(result.thumbnailSet).toEqual(thumbnailSet)
    expect(getCanvasThumbnailRuntimeMetrics()).toEqual(
      expect.objectContaining({
        thumbnailCount: 1,
        cacheHitCount: 1,
        generatedCount: 0
      })
    )
    expect(bridge.readThumbnailManifest).toHaveBeenCalledWith({ cacheKey: identity.cacheKey })
  })

  it('generates persistent thumbnail levels as WebP in renderer fallback', async () => {
    const identity = createIdentity()
    const drawImage = vi.fn()
    const close = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => ({
        width: 1024,
        height: 512,
        close
      }))
    })
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        clearRect: vi.fn(),
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback, requestedType) => {
      callback?.(new Blob([requestedType || 'image/webp'], { type: requestedType || 'image/webp' }))
    })
    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      writeThumbnailSet: vi.fn(async ({ manifest }) => ({ manifest }))
    }

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge
    })

    expect(result.status).toBe('generated')
    expect(result.thumbnailSet?.levels.map((level) => level.maxSide)).toEqual([
      128, 256, 512, 1024, 2048
    ])
    expect(result.thumbnailSet?.levels.every((level) => level.mimeType === 'image/webp')).toBe(true)
    expect(drawImage).toHaveBeenCalledTimes(5)
    expect(close).toHaveBeenCalled()
    expect(bridge.writeThumbnailSet).toHaveBeenCalled()
    expect(getCanvasThumbnailRuntimeMetrics()).toEqual(
      expect.objectContaining({
        thumbnailCount: 1,
        cacheHitCount: 0,
        generatedCount: 1
      })
    )
  })

  it('falls back to PNG when WebP encoding is unavailable', async () => {
    const identity = createIdentity()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => ({
        width: 1024,
        height: 512,
        close: vi.fn()
      }))
    })
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback, requestedType) => {
      callback?.(requestedType === 'image/webp' ? null : new Blob(['png'], { type: 'image/png' }))
    })

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge: {
        readThumbnailManifest: vi.fn(async () => ({ manifest: null }))
      }
    })

    expect(result.status).toBe('generated')
    expect(result.thumbnailSet?.levels.every((level) => level.mimeType === 'image/png')).toBe(true)
  })

  it('uses native thumbnail fallback when renderer generation fails', async () => {
    const identity = createIdentity()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => {
        throw new Error('decode failed')
      })
    })
    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      createNativeThumbnail: vi.fn(async ({ maxSide }) => ({
        data: new Uint8Array([1, 2, 3]),
        width: maxSide,
        height: Math.max(1, maxSide / 2),
        mimeType: 'image/png'
      })),
      writeThumbnailSet: vi.fn(async ({ manifest }) => ({ manifest }))
    }

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge
    })

    expect(result.status).toBe('native-generated')
    expect(result.thumbnailSet?.levels.map((level) => level.mimeType)).toEqual([
      'image/png',
      'image/png',
      'image/png',
      'image/png',
      'image/png'
    ])
    expect(bridge.createNativeThumbnail).toHaveBeenCalledTimes(5)
  })

  it('marks stale warm cache when regenerating after source metadata changes', async () => {
    const identity = createIdentity()
    const staleIdentity = buildCanvasImageSourceIdentity({
      canonicalPath: identity.canonicalPath,
      sizeBytes: identity.sizeBytes + 1,
      lastModifiedMs: identity.lastModifiedMs
    })
    if (!staleIdentity) {
      throw new Error('Expected stale source identity to be valid.')
    }
    const staleSet = createCanvasThumbnailSet({
      identity: staleIdentity,
      levels: createCompleteLevels()
    })
    const staleManifest = canvasThumbnailManifestFromSet(staleSet)
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => ({
        width: 1024,
        height: 512,
        close: vi.fn()
      }))
    })
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback, requestedType) => {
      callback?.(new Blob(['thumb'], { type: requestedType || 'image/webp' }))
    })

    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: staleManifest }))
    }

    const warm = await readWarmCanvasThumbnailSet(identity, bridge)
    expect(warm.status).toBe('cache-stale')

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge
    })

    expect(result.status).toBe('generated')
    expect(result.thumbnailSet).not.toBeNull()
  })
})
