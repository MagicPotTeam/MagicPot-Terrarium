import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCanvasImageSourceIdentity,
  buildCanvasSessionSourceIdentity,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import {
  canvasImageObjectUrlRegistry,
  createCanvasImageObjectUrlHandle,
  getCanvasImageObjectUrlRegistryMetrics
} from './canvasImageObjectUrlRegistry'
import {
  generateCanvasThumbnailLevelsInScope,
  pickCanvasThumbnailFirstLevel,
  planCanvasThumbnailLevels
} from './canvasThumbnailGeneration.worker'
import {
  CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT,
  configureCanvasThumbnailWorkerPoolForTest,
  ensureCanvasThumbnailSet,
  generateCanvasThumbnailLevels,
  getCanvasThumbnailRuntimeMetrics,
  getCanvasThumbnailTransientObjectUrlMetrics,
  getCanvasThumbnailWorkerPoolMetrics,
  readWarmCanvasThumbnailSet,
  resetCanvasThumbnailRuntimeMetrics,
  resetCanvasThumbnailWorkerPoolForTest,
  revokeCanvasThumbnailTransientObjectUrlsForTest
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
    revokeCanvasThumbnailTransientObjectUrlsForTest()
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

  it('generates only the levels below the source size and persists them as WebP in renderer fallback', async () => {
    const identity = createIdentity()
    // The mocked source decodes to 1024 x 512: 128, 256 and 512 are below it.
    const { drawImage, close } = installRendererThumbnailMocks()
    const writeThumbnailSet = vi.fn(
      async ({
        manifest
      }: Parameters<NonNullable<CanvasThumbnailIpcBridge['writeThumbnailSet']>>[0]) => ({
        manifest: {
          ...manifest,
          levels: manifest.levels.map((level) => ({
            ...level,
            src: `local-media:///cache/${level.filename}`
          }))
        }
      })
    )
    const bridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      writeThumbnailSet
    }

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      bridge
    })

    expect(result.status).toBe('generated')
    // The set still lists every level ...
    expect(result.thumbnailSet?.levels.map((level) => level.maxSide)).toEqual([
      128, 256, 512, 1024, 2048
    ])
    expect(result.thumbnailSet?.levels.every((level) => level.mimeType === 'image/webp')).toBe(true)
    // ... but a level at or above the source is no encode and no file of its own.
    expect(drawImage).toHaveBeenCalledTimes(3)
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledTimes(3)
    expect(result.thumbnailSet?.levels.map((level) => level.filename)).toEqual([
      '128.webp',
      '256.webp',
      '512.webp',
      '512.webp',
      '512.webp'
    ])
    expect(result.thumbnailSet?.levels.map((level) => [level.width, level.height])).toEqual([
      [128, 64],
      [256, 128],
      [512, 256],
      [512, 256],
      [512, 256]
    ])
    const written = writeThumbnailSet.mock.calls[0][0]
    expect(written.files.map((file) => file.filename)).toEqual(['128.webp', '256.webp', '512.webp'])
    // A level that goes to the cache never becomes an object URL: it is read from the cache.
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(result.thumbnailSet?.levels.every((level) => level.src.startsWith('local-media:'))).toBe(
      true
    )
    expect(written.manifest.levels.map((level) => level.filename)).toEqual([
      '128.webp',
      '256.webp',
      '512.webp',
      '512.webp',
      '512.webp'
    ])
    expect(close).toHaveBeenCalled()
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

  it('keeps the levels of a pathless image outside the shared object-URL registry', async () => {
    const identity = buildCanvasSessionSourceIdentity({
      sourceKey: 'canvas-session:test-pathless',
      sizeBytes: 15,
      mimeType: 'image/png',
      fileName: 'pathless.png'
    })
    installRendererThumbnailMocks()
    const writeThumbnailSet = vi.fn()
    // The image layer's registry is full: pasted thumbnails must not depend on it.
    canvasImageObjectUrlRegistry.revokeAll()
    canvasImageObjectUrlRegistry.setMaxCount(1)
    const filler = createCanvasImageObjectUrlHandle('test-filler', new Blob(['filler']))
    expect(filler).not.toBeNull()
    expect(createCanvasImageObjectUrlHandle('test-overflow', new Blob(['overflow']))).toBeNull()
    const registryBefore = getCanvasImageObjectUrlRegistryMetrics()
    let nextUrl = 0
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:pathless-level-${++nextUrl}`)

    try {
      const result = await ensureCanvasThumbnailSet({
        source: new Blob(['pathless-source'], { type: 'image/png' }),
        identity,
        bridge: {
          readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
          writeThumbnailSet
        }
      })

      expect(result.status).toBe('generated')
      // Every level has a source, so the set is usable: three files, five entries.
      expect(result.thumbnailSet?.levels.map((level) => level.src)).toEqual([
        'blob:pathless-level-1',
        'blob:pathless-level-2',
        'blob:pathless-level-3',
        'blob:pathless-level-3',
        'blob:pathless-level-3'
      ])
      expect(getCanvasThumbnailTransientObjectUrlMetrics().count).toBe(3)
      const registryAfter = getCanvasImageObjectUrlRegistryMetrics()
      expect(registryAfter.activeCount).toBe(registryBefore.activeCount)
      expect(registryAfter.createdCount).toBe(registryBefore.createdCount)
      expect(registryAfter.rejectedCount).toBe(registryBefore.rejectedCount)
      expect(writeThumbnailSet).not.toHaveBeenCalled()
    } finally {
      filler?.revoke()
      canvasImageObjectUrlRegistry.setMaxCount(128)
    }
  })

  it('shows the levels of a set whose cache write failed from session URLs', async () => {
    installRendererThumbnailMocks()
    let nextUrl = 0
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:unwritten-${++nextUrl}`)
    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity: createIdentity(),
      bridge: {
        readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
        writeThumbnailSet: vi.fn(async () => {
          throw new Error('disk full')
        })
      }
    })

    expect(result.status).toBe('generated')
    expect(result.thumbnailSet?.levels.every((level) => level.src.startsWith('blob:'))).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3)
    expect(getCanvasThumbnailTransientObjectUrlMetrics().count).toBe(3)
  })

  it('keeps only the newest session thumbnail URLs and revokes the oldest', async () => {
    installRendererThumbnailMocks()
    let nextUrl = 0
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:pasted-${++nextUrl}`)
    const paste = (index: number) =>
      ensureCanvasThumbnailSet({
        source: new Blob([`pasted-${index}`], { type: 'image/png' }),
        identity: buildCanvasSessionSourceIdentity({
          sourceKey: `canvas-session:pasted-${index}`,
          sizeBytes: 8,
          mimeType: 'image/png'
        }),
        bridge: null
      })

    const pasteCount = Math.ceil(CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT / 3) + 2
    const first = await paste(0)
    for (let index = 1; index < pasteCount; index += 1) {
      await paste(index)
    }

    expect(getCanvasThumbnailTransientObjectUrlMetrics().count).toBe(
      CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT
    )
    // The first paste's URLs went first; the newest paste keeps all of its own.
    const firstUrls = new Set(first.thumbnailSet?.levels.map((level) => level.src))
    firstUrls.forEach((src) => expect(URL.revokeObjectURL).toHaveBeenCalledWith(src))
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(`blob:pasted-${nextUrl}`)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(
      pasteCount * 3 - CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT
    )
  })

  it('does not read the cache again when the caller has just missed it', async () => {
    const identity = createIdentity()
    installRendererThumbnailMocks()
    const readThumbnailManifest = vi.fn(async () => ({ manifest: null }))

    const result = await ensureCanvasThumbnailSet({
      source: new Blob(['source'], { type: 'image/png' }),
      identity,
      skipWarmRead: true,
      bridge: { readThumbnailManifest }
    })

    expect(result.status).toBe('generated')
    expect(readThumbnailManifest).not.toHaveBeenCalled()
  })

  it('asks a switched-off sidecar once and a failing one three times, then leaves it alone', async () => {
    installRendererThumbnailMocks()
    const run = async (bridge: CanvasThumbnailIpcBridge, index: number) =>
      ensureCanvasThumbnailSet({
        source: new Blob(['source'], { type: 'image/png' }),
        identity: createIdentity({ canonicalPath: `C:/Images/sidecar-${index}.png` }),
        bridge
      })

    const disabled = vi.fn(async () => ({
      manifest: null,
      status: 'fallback' as const,
      sidecar: { used: false, fallback: true, reason: 'feature-disabled' }
    }))
    const disabledBridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      generateThumbnailSet: disabled
    }
    for (let index = 0; index < 4; index += 1) {
      expect((await run(disabledBridge, index)).status).toBe('generated')
    }
    expect(disabled).toHaveBeenCalledTimes(1)

    const failing = vi.fn(async () => ({
      manifest: null,
      status: 'failed' as const,
      error: 'Canvas thumbnail sidecar output failed manifest validation.',
      sidecar: { used: true, fallback: false }
    }))
    const failingBridge: CanvasThumbnailIpcBridge = {
      readThumbnailManifest: vi.fn(async () => ({ manifest: null })),
      generateThumbnailSet: failing
    }
    for (let index = 0; index < 6; index += 1) {
      expect((await run(failingBridge, 10 + index)).status).toBe('generated')
    }
    expect(failing).toHaveBeenCalledTimes(3)
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

  it('draws thumbnail levels on a CPU canvas and keeps no pixels in the idle canvas', async () => {
    setGlobalCreateImageBitmap(
      vi.fn(async () => ({
        width: 4096,
        height: 4096,
        close: vi.fn()
      }))
    )
    const contextCalls: Array<{ canvas: HTMLCanvasElement; settings: unknown }> = []
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      _contextId: string,
      settings?: unknown
    ) {
      contextCalls.push({ canvas: this, settings })
      return {
        clearRect: vi.fn(),
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      } as unknown as CanvasRenderingContext2D
    } as typeof HTMLCanvasElement.prototype.getContext)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob(['encoded'], { type: 'image/webp' }))
    })

    await expect(
      generateCanvasThumbnailLevelsInScope({
        source: new Blob(['source'], { type: 'image/jpeg' }),
        levels: [512, 2048]
      })
    ).resolves.toHaveLength(2)

    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(contextCalls.length).toBeGreaterThan(0)
    // An accelerated canvas would stage every full-size source upload in GPU shared memory
    // that the worker keeps until it ends; a CPU canvas has no GPU context at all.
    expect(
      contextCalls.every(
        ({ settings }) =>
          (settings as { willReadFrequently?: boolean })?.willReadFrequently === true
      )
    ).toBe(true)
    // The canvas kept for the next level holds no 2048 x 2048 pixels while it waits.
    const pooled = contextCalls[contextCalls.length - 1].canvas
    expect(pooled.width * pooled.height).toBe(1)
  })

  it('draws every level before the first encode, each from the level above it, and frees the decoded source early', async () => {
    const pendingEncodes: Array<(blob: Blob | null) => void> = []
    const contextCanvases: HTMLCanvasElement[] = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
      originalCreateElement(tagName as 'canvas')) as typeof document.createElement)

    const close = vi.fn()
    const bitmap = { width: 4096, height: 2048, close }
    setGlobalCreateImageBitmap(vi.fn(async () => bitmap))
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
    expect(close).toHaveBeenCalledTimes(1)
    // The canvas of the failed job went back to the pool without pixels.
    expect(contextCanvases[0].width).toBe(1)

    const draws: Array<{ source: unknown; width: number; height: number }> = []
    getContext.mockImplementation(function (this: HTMLCanvasElement) {
      contextCanvases.push(this)
      return {
        clearRect: vi.fn(),
        drawImage: (source: unknown, _x: number, _y: number, width: number, height: number) => {
          draws.push({ source, width, height })
        },
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      } as unknown as ReturnType<HTMLCanvasElement['getContext']>
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      pendingEncodes.push((blob) => callback(blob))
    })

    const generation = generateCanvasThumbnailLevelsInScope({
      source: new Blob(['source'], { type: 'image/png' }),
      levels: [128, 256, 512]
    })
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))

    // All three draws happened before anything was encoded: 512 from the decoded source,
    // 256 from the 512 canvas, 128 from the 256 canvas.
    expect(draws.map((draw) => [draw.width, draw.height])).toEqual([
      [512, 256],
      [256, 128],
      [128, 64]
    ])
    expect(draws[0].source).toBe(bitmap)
    expect(draws[1].source).toBeInstanceOf(HTMLCanvasElement)
    expect((draws[1].source as HTMLCanvasElement).width).toBe(512)
    expect((draws[2].source as HTMLCanvasElement).width).toBe(256)
    // The 32 MB of decoded source are released before the encodes run.
    expect(close).toHaveBeenCalledTimes(2)

    pendingEncodes.shift()?.(new Blob(['encoded-128'], { type: 'image/webp' }))
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
    pendingEncodes.shift()?.(new Blob(['encoded-256'], { type: 'image/webp' }))
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
    pendingEncodes.shift()?.(new Blob(['encoded-512'], { type: 'image/webp' }))

    const levels = await generation
    expect(levels.map((level) => [level.maxSide, level.width, level.height])).toEqual([
      [128, 128, 64],
      [256, 256, 128],
      [512, 512, 256]
    ])
    // Canvases are only handed back (emptied) after their encode is done.
    expect(new Set(draws.map((draw) => draw.source)).size).toBe(3)
    expect(contextCanvases.slice(-3).every((canvas) => canvas.width === 1)).toBe(true)
  })

  it('encodes the display level first and hands it over before the larger levels are encoded', async () => {
    const pendingEncodes: Array<{ width: number; finish: (blob: Blob | null) => void }> = []
    const sourceBitmap = { width: 4096, height: 3072, close: vi.fn() }
    const createImageBitmapMock = vi.fn(async () => sourceBitmap)
    setGlobalCreateImageBitmap(createImageBitmapMock)
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      callback: BlobCallback
    ) {
      pendingEncodes.push({ width: this.width, finish: (blob) => callback(blob) })
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob
    const onFirstLevel = vi.fn()

    const generation = generateCanvasThumbnailLevelsInScope({
      source: new Blob(['source'], { type: 'image/png' }),
      firstLevelMaxSide: 512,
      onFirstLevel
    })
    await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))

    // The first encode is the 512 level, not the smallest one.
    expect(pendingEncodes[0].width).toBe(512)
    expect(onFirstLevel).not.toHaveBeenCalled()
    const firstBlob = new Blob(['level-512'], { type: 'image/webp' })
    pendingEncodes.shift()?.finish(firstBlob)
    await vi.waitFor(() => expect(onFirstLevel).toHaveBeenCalledTimes(1))
    expect(onFirstLevel).toHaveBeenCalledWith(
      expect.objectContaining({ maxSide: 512, width: 512, height: 384, blob: firstBlob })
    )

    // The other four follow, smallest first; the 512 level is not encoded twice.
    const encodedWidths: number[] = []
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(pendingEncodes).toHaveLength(1))
      const next = pendingEncodes.shift()
      encodedWidths.push(next?.width ?? 0)
      next?.finish(new Blob([`level-${index}`], { type: 'image/webp' }))
    }
    const levels = await generation
    expect(encodedWidths).toEqual([128, 256, 1024, 2048])
    expect(levels.map((level) => level.maxSide)).toEqual([128, 256, 512, 1024, 2048])
    expect(levels[2].blob).toBe(firstBlob)
    expect(onFirstLevel).toHaveBeenCalledTimes(1)
    // No second decode or bitmap for the early level: it is the level's own encoded bytes.
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1)
  })

  it('hands no level over early when the display level is the last one to encode or none covers it', () => {
    const plan = (sourceWidth: number, sourceHeight: number) =>
      planCanvasThumbnailLevels({ sourceWidth, sourceHeight })
    const first = (sourceWidth: number, sourceHeight: number, maxSide: number | undefined) =>
      pickCanvasThumbnailFirstLevel(plan(sourceWidth, sourceHeight), maxSide)?.maxSide ?? null

    // Larger levels follow: worth an early message.
    expect(first(4096, 3072, 512)).toBe(512)
    expect(first(4096, 3072, 300)).toBe(512)
    expect(first(2048, 1536, 256)).toBe(256)
    // 1024 px source: 512 is its largest file, the job ends right after it.
    expect(first(1024, 768, 512)).toBeNull()
    // 300 px source shown at 512: the source itself is displayed, no level covers it.
    expect(first(300, 200, 512)).toBeNull()
    expect(first(100, 80, 128)).toBeNull()
    expect(first(4096, 3072, undefined)).toBeNull()
    expect(first(4096, 3072, 0)).toBeNull()
  })

  it('plans the levels of a source: only below its size, and never none', () => {
    const sides = (sourceWidth: number, sourceHeight: number) =>
      planCanvasThumbnailLevels({ sourceWidth, sourceHeight }).map((level) => [
        level.maxSide,
        level.width,
        level.height
      ])

    expect(sides(4096, 3072)).toEqual([
      [128, 128, 96],
      [256, 256, 192],
      [512, 512, 384],
      [1024, 1024, 768],
      [2048, 2048, 1536]
    ])
    // A 2048 px source is its own top level: no full-size re-encode.
    expect(sides(2048, 2048).map(([maxSide]) => maxSide)).toEqual([128, 256, 512, 1024])
    expect(sides(1024, 768).map(([maxSide]) => maxSide)).toEqual([128, 256, 512])
    expect(sides(300, 200)).toEqual([
      [128, 128, 85],
      [256, 256, 171]
    ])
    // Smaller than every level: one level at its own size, so that the set has a file.
    expect(sides(100, 80)).toEqual([[128, 100, 80]])
    expect(sides(128, 64)).toEqual([[128, 128, 64]])
    expect(sides(768, 1024).map(([maxSide]) => maxSide)).toEqual([128, 256, 512])
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
