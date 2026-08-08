import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCanvasImageSourceIdentity,
  buildCanvasSessionSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import { generateCanvasThumbnailLevelsInScope } from './canvasThumbnailGeneration.worker'
import {
  configureCanvasThumbnailWorkerPoolForTest,
  ensureCanvasThumbnailSet,
  generateCanvasThumbnailLevels,
  getCanvasThumbnailRuntimeMetrics,
  getCanvasThumbnailWorkerPoolMetrics,
  readWarmCanvasThumbnailSet,
  resetCanvasThumbnailRuntimeMetrics,
  resetCanvasThumbnailWorkerPoolForTest
} from './canvasThumbnailWorkerClient'
import type {
  CanvasLocalFileSourceIdentity,
  CanvasImageSourceIdentity,
  CanvasImageThumbnailLevel,
  CanvasThumbnailIpcBridge,
  CanvasThumbnailLevelSize,
  CanvasThumbnailWorkerGenerateMessage,
  CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

function createIdentity(
  overrides: Partial<
    Pick<CanvasLocalFileSourceIdentity, 'canonicalPath' | 'sizeBytes' | 'lastModifiedMs'>
  > = {}
): CanvasLocalFileSourceIdentity {
  const identity = buildCanvasImageSourceIdentity({
    canonicalPath: overrides.canonicalPath ?? 'C:/Images/ref.png',
    sizeBytes: overrides.sizeBytes ?? 1234,
    lastModifiedMs: overrides.lastModifiedMs ?? 5678
  })
  if (!identity || identity.kind !== 'local-file') {
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

class MockThumbnailWorker {
  static instances: MockThumbnailWorker[] = []

  readonly messages: CanvasThumbnailWorkerGenerateMessage[] = []
  terminated = false
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor() {
    MockThumbnailWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: CanvasThumbnailWorkerGenerateMessage): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: CanvasThumbnailWorkerMessage): void {
    const event = {
      data: message,
      currentTarget: this
    } as unknown as MessageEvent<CanvasThumbnailWorkerMessage>
    this.listeners.get('message')?.forEach((listener) => listener(event))
  }

  emitError(): void {
    const event = { currentTarget: this } as unknown as Event
    this.listeners.get('error')?.forEach((listener) => listener(event))
  }
}

function setGlobalWorker(value: unknown): void {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value
  })
}

function setGlobalCreateImageBitmap(value: unknown): void {
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value
  })
}

function installMockThumbnailWorker(): void {
  MockThumbnailWorker.instances = []
  setGlobalWorker(MockThumbnailWorker)
}

function configureSingleMockWorkerPool(maxQueueSize: number): void {
  configureCanvasThumbnailWorkerPoolForTest({
    maxWorkers: 1,
    maxQueueSize,
    requestTimeoutMs: 1000,
    idleWorkerTtlMs: 1000
  })
}

type RendererThumbnailMocksOptions = {
  width?: number
  height?: number
  drawImage?: ReturnType<typeof vi.fn>
  close?: ReturnType<typeof vi.fn>
  toBlob?: (callback: BlobCallback, requestedType?: string) => void
}

function installRendererThumbnailMocks({
  width = 1024,
  height = 512,
  drawImage = vi.fn(),
  close = vi.fn(),
  toBlob = (callback, requestedType) => {
    callback?.(new Blob([requestedType || 'image/webp'], { type: requestedType || 'image/webp' }))
  }
}: RendererThumbnailMocksOptions = {}) {
  setGlobalCreateImageBitmap(
    vi.fn(async () => ({
      width,
      height,
      close
    }))
  )
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      clearRect: vi.fn(),
      drawImage,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low'
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toBlob = vi.fn(toBlob)
  return { drawImage, close }
}

function createWorkerLevel(maxSide: CanvasThumbnailLevelSize = 128) {
  return {
    maxSide,
    width: maxSide,
    height: Math.max(1, Math.round(maxSide / 2)),
    mimeType: 'image/webp' as const,
    format: 'webp' as const,
    blob: new Blob(['worker-thumb'], { type: 'image/webp' })
  }
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
    resetCanvasThumbnailWorkerPoolForTest()
    setGlobalWorker(undefined)
    URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`)
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    resetCanvasThumbnailWorkerPoolForTest()
    setGlobalCreateImageBitmap(originalCreateImageBitmap)
    setGlobalWorker(originalWorker)
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
        generatedCount: 0,
        sidecarGeneratedCount: 0
      })
    )
    expect(bridge.readThumbnailManifest).toHaveBeenCalledWith({ cacheKey: identity.cacheKey })
  })

  it('uses main-process sidecar generated manifests before renderer decode fallback', async () => {
    const identity = createIdentity()
    const thumbnailSet = createCanvasThumbnailSet({
      identity,
      levels: createCompleteLevels()
    })
    const manifest = canvasThumbnailManifestFromSet(thumbnailSet)
    const createImageBitmap = vi.fn()
    setGlobalCreateImageBitmap(createImageBitmap)
    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      generateThumbnailSet: vi.fn(async () => ({
        manifest,
        status: 'generated' as const,
        sidecar: { used: true, fallback: false }
      })),
      writeThumbnailSet: vi.fn(async ({ manifest }) => ({ manifest }))
    }

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge
    })

    expect(result.status).toBe('sidecar-generated')
    expect(result.thumbnailSet).toEqual(thumbnailSet)
    expect(bridge.generateThumbnailSet).toHaveBeenCalledWith({
      fullPath: identity.canonicalPath,
      levels: [128, 256, 512, 1024, 2048],
      format: 'image/webp'
    })
    expect(bridge.writeThumbnailSet).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(getCanvasThumbnailRuntimeMetrics()).toEqual(
      expect.objectContaining({
        thumbnailCount: 1,
        sidecarGeneratedCount: 1,
        generatedCount: 0,
        nativeGeneratedCount: 0
      })
    )
  })

  it('generates persistent thumbnail levels as WebP in renderer fallback', async () => {
    const identity = createIdentity()
    const { drawImage, close } = installRendererThumbnailMocks()
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
        generatedCount: 1,
        sidecarGeneratedCount: 0,
        workerPoolWorkerCount: 0,
        workerPoolQueuedRequestCount: 0,
        workerPoolRejectedRequestCount: 0
      })
    )
  })

  it('generates all five levels for a pathless identity as a renderer-only transient set', async () => {
    const identity = buildCanvasSessionSourceIdentity({
      sourceKey: 'canvas-session:test-pathless',
      sizeBytes: 15,
      mimeType: 'image/png',
      fileName: 'pathless.png'
    })
    const { drawImage, close } = installRendererThumbnailMocks()
    const generateThumbnailSet = vi.fn()
    const createNativeThumbnail = vi.fn()
    const writeThumbnailSet = vi.fn()

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['pathless-source'], { type: 'image/png' }),
      identity,
      bridge: {
        readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
        generateThumbnailSet,
        createNativeThumbnail,
        writeThumbnailSet
      }
    })

    expect(result.status).toBe('generated')
    expect(result.thumbnailSet?.levels.map((level) => level.maxSide)).toEqual([
      128, 256, 512, 1024, 2048
    ])
    expect(drawImage).toHaveBeenCalledTimes(5)
    expect(close).toHaveBeenCalled()
    expect(generateThumbnailSet).not.toHaveBeenCalled()
    expect(createNativeThumbnail).not.toHaveBeenCalled()
    expect(writeThumbnailSet).not.toHaveBeenCalled()
  })

  it('falls back to PNG when WebP encoding is unavailable', async () => {
    const identity = createIdentity()
    installRendererThumbnailMocks({
      toBlob: (callback, requestedType) => {
        callback?.(requestedType === 'image/webp' ? null : new Blob(['png'], { type: 'image/png' }))
      }
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

  it('reuses persistent thumbnail workers and deduplicates matching in-flight requests', async () => {
    installMockThumbnailWorker()
    configureSingleMockWorkerPool(4)
    const identity = createIdentity()
    const source = new Blob(['source'], { type: 'image/png' })
    const equivalentSource = new Blob(['source'], { type: 'image/png' })

    const first = generateCanvasThumbnailLevels({ source, identity, levels: [128] })
    const second = generateCanvasThumbnailLevels({
      source: equivalentSource,
      identity,
      levels: [128]
    })

    expect(MockThumbnailWorker.instances).toHaveLength(1)
    expect(MockThumbnailWorker.instances[0].messages).toHaveLength(1)
    expect(getCanvasThumbnailWorkerPoolMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 1,
        dedupedRequestCount: 1,
        queuedRequestCount: 0
      })
    )

    const message = MockThumbnailWorker.instances[0].messages[0]
    MockThumbnailWorker.instances[0].emit({
      type: 'success',
      requestId: message.requestId,
      levels: [createWorkerLevel(128)]
    })

    const [firstLevels, secondLevels] = await Promise.all([first, second])
    expect(firstLevels).toHaveLength(1)
    expect(secondLevels).toHaveLength(1)
    expect(secondLevels).not.toBe(firstLevels)
    expect(secondLevels[0]).toEqual(
      expect.objectContaining({
        maxSide: firstLevels[0].maxSide,
        mimeType: firstLevels[0].mimeType,
        sizeBytes: firstLevels[0].sizeBytes
      })
    )
    expect(MockThumbnailWorker.instances[0].terminated).toBe(false)
    expect(getCanvasThumbnailWorkerPoolMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 0,
        completedRequestCount: 1,
        idleWorkerCount: 1,
        workerCount: 1
      })
    )
    expect(getCanvasThumbnailRuntimeMetrics()).toEqual(
      expect.objectContaining({
        workerPoolDedupedRequestCount: 1,
        workerPoolCompletedRequestCount: 1,
        workerPoolWorkerCount: 1,
        workerPoolMaxWorkers: 1,
        workerPoolMaxQueueSize: 4
      })
    )
  })

  it('queues thumbnail worker requests and falls back to renderer generation under backpressure', async () => {
    installMockThumbnailWorker()
    configureSingleMockWorkerPool(1)
    const { drawImage, close } = installRendererThumbnailMocks({ width: 512, height: 256 })

    const first = generateCanvasThumbnailLevels({
      source: new Blob(['source-1'], { type: 'image/png' }),
      identity: createIdentity({ canonicalPath: 'C:/Images/ref-1.png' }),
      levels: [128]
    })
    const second = generateCanvasThumbnailLevels({
      source: new Blob(['source-2'], { type: 'image/png' }),
      identity: createIdentity({ canonicalPath: 'C:/Images/ref-2.png' }),
      levels: [128]
    })
    const backpressured = generateCanvasThumbnailLevels({
      source: new Blob(['source-3'], { type: 'image/png' }),
      identity: createIdentity({ canonicalPath: 'C:/Images/ref-3.png' }),
      levels: [128]
    })

    expect(MockThumbnailWorker.instances).toHaveLength(1)
    expect(MockThumbnailWorker.instances[0].messages).toHaveLength(1)
    expect(getCanvasThumbnailWorkerPoolMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 1,
        queuedRequestCount: 1,
        rejectedRequestCount: 1
      })
    )

    const firstMessage = MockThumbnailWorker.instances[0].messages[0]
    MockThumbnailWorker.instances[0].emit({
      type: 'success',
      requestId: firstMessage.requestId,
      levels: [createWorkerLevel(128)]
    })
    await first

    expect(MockThumbnailWorker.instances[0].messages).toHaveLength(2)
    const secondMessage = MockThumbnailWorker.instances[0].messages[1]
    MockThumbnailWorker.instances[0].emit({
      type: 'success',
      requestId: secondMessage.requestId,
      levels: [createWorkerLevel(128)]
    })
    await second

    const backpressuredLevels = await backpressured
    expect(backpressuredLevels).toHaveLength(1)
    expect(backpressuredLevels[0]).toEqual(
      expect.objectContaining({
        maxSide: 128,
        mimeType: 'image/webp'
      })
    )
    expect(drawImage).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('uses native thumbnail fallback when renderer generation fails', async () => {
    const identity = createIdentity()
    setGlobalCreateImageBitmap(
      vi.fn(async () => {
        throw new Error('decode failed')
      })
    )
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

  it('reuses one canvas only after async encoding completes and returns it after errors', async () => {
    const pendingEncodes: Array<(blob: Blob | null) => void> = []
    const contextCanvases: HTMLCanvasElement[] = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
      originalCreateElement(tagName as 'canvas')) as typeof document.createElement)

    setGlobalCreateImageBitmap(
      vi.fn(async () => ({
        width: 1024,
        height: 512,
        close: vi.fn()
      }))
    )
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(function (this: HTMLCanvasElement) {
        contextCanvases.push(this)
        return null
      })

    await expect(
      generateCanvasThumbnailLevelsInScope({
        source: new Blob(['source'], { type: 'image/png' }),
        levels: [128]
      })
    ).rejects.toThrow('Failed to create thumbnail canvas context.')

    const drawImage = vi.fn()
    getContext.mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low'
    } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      pendingEncodes.push((blob) => callback(blob))
    })

    const generation = generateCanvasThumbnailLevelsInScope({
      source: new Blob(['source'], { type: 'image/png' }),
      levels: [128, 256]
    })
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
    expect(drawImage).toHaveBeenCalledTimes(1)

    pendingEncodes.shift()?.(new Blob(['encoded-128'], { type: 'image/webp' }))
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
    expect(drawImage).toHaveBeenCalledTimes(2)

    pendingEncodes.shift()?.(new Blob(['encoded-256'], { type: 'image/webp' }))
    await expect(generation).resolves.toHaveLength(2)
    expect(contextCanvases.length).toBeGreaterThan(0)
    expect(contextCanvases.every((canvas) => canvas === contextCanvases[0])).toBe(true)
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
    installRendererThumbnailMocks({
      toBlob: (callback, requestedType) => {
        callback?.(new Blob(['thumb'], { type: requestedType || 'image/webp' }))
      }
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
