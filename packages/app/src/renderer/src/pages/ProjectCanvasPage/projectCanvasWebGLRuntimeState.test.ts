import { describe, expect, it } from 'vitest'

import {
  areProjectCanvasSetsEqual,
  areProjectCanvasWebGLRuntimeMetricsEqual,
  areProjectCanvasWebGLRuntimeMetricsEqualForReactState,
  buildProjectCanvasMetricsSnapshot,
  createProjectCanvasWebGLPendingRuntimeState,
  createProjectCanvasWebGLRuntimeMetrics,
  parseProjectCanvasMetricsSnapshot,
  queueProjectCanvasWebGLPendingRuntimeIds,
  queueProjectCanvasWebGLPendingRuntimeMetrics,
  takeProjectCanvasWebGLPendingRuntimeState,
  type ProjectCanvasWebGLRuntimeMetrics
} from './projectCanvasWebGLRuntimeState'
import {
  CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS,
  type CanvasThumbnailRuntimeMetrics
} from './canvasThumbnailTypes'

type CanvasThumbnailWorkerPoolRuntimeMetricKey =
  (typeof CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS)[number]
type CanvasThumbnailWorkerPoolRuntimeMetrics = Pick<
  Required<CanvasThumbnailRuntimeMetrics>,
  CanvasThumbnailWorkerPoolRuntimeMetricKey
>

function createThumbnailWorkerPoolRuntimeMetrics(
  values: readonly number[] = [2, 1, 1, 3, 4, 5, 6, 7, 8, 9, 2, 32]
): CanvasThumbnailWorkerPoolRuntimeMetrics {
  return Object.fromEntries(
    CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS.map((key, index) => [key, values[index] ?? 0])
  ) as CanvasThumbnailWorkerPoolRuntimeMetrics
}

function createMetrics(
  overrides: Partial<ProjectCanvasWebGLRuntimeMetrics> = {}
): ProjectCanvasWebGLRuntimeMetrics {
  return createProjectCanvasWebGLRuntimeMetrics({
    isInitialized: true,
    imageCount: 2,
    loadedImageCount: 2,
    residentImageCount: 1,
    residentTextureBytes: 24000,
    residentCandidateTextureBytes: 48000,
    residentTextureBudgetBytes: 768 * 1024 * 1024,
    spriteCount: 1,
    residentCandidateImageCount: 2,
    viewportCulledImageCount: 1,
    spriteReconcilePassCount: 3,
    lastSpriteReconcileDurationMs: 1.5,
    lastSpriteReconcileCandidateCount: 2,
    lastSpriteReconcileTargetCount: 1,
    lastSpriteReconcileCreatedCount: 1,
    lastSpriteReconcileReusedCount: 2,
    usingPreviewImageCount: 1,
    usingSourceImageCount: 1,
    thumbnailPreviewImageCount: 1,
    renderCount: 4,
    lastRenderDurationMs: 5.25,
    lastUpdateReason: 'items',
    ...overrides
  })
}

describe('projectCanvasWebGLRuntimeState', () => {
  it('compares set membership without depending on identity or insertion order', () => {
    expect(
      areProjectCanvasSetsEqual(new Set(['image-a', 'image-b']), new Set(['image-b', 'image-a']))
    ).toBe(true)
    expect(areProjectCanvasSetsEqual(new Set(['image-a']), new Set(['image-a', 'image-b']))).toBe(
      false
    )
    expect(areProjectCanvasSetsEqual(new Set(['image-a']), new Set(['image-b']))).toBe(false)
  })

  it('compares every WebGL runtime metric field used by the stage dataset', () => {
    const metrics = createMetrics()

    expect(areProjectCanvasWebGLRuntimeMetricsEqual(null, metrics)).toBe(false)
    expect(areProjectCanvasWebGLRuntimeMetricsEqual(createMetrics(), metrics)).toBe(true)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqual(
        createMetrics({ residentCandidateTextureBytes: metrics.residentCandidateTextureBytes + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqual(
        createMetrics({ spriteReconcilePassCount: metrics.spriteReconcilePassCount! + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqual(
        createMetrics({ lastSpriteReconcileDeferredCount: 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqual(
        createMetrics({ lastUpdateReason: 'preview' }),
        metrics
      )
    ).toBe(false)
  })

  it('keeps React state in sync for benchmark-visible WebGL metrics', () => {
    const metrics = createMetrics()

    expect(areProjectCanvasWebGLRuntimeMetricsEqualForReactState(null, metrics)).toBe(false)
    expect(areProjectCanvasWebGLRuntimeMetricsEqualForReactState(createMetrics(), metrics)).toBe(
      true
    )
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ renderCount: metrics.renderCount + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ lastRenderDurationMs: metrics.lastRenderDurationMs! + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ thumbnailImageCacheCount: metrics.thumbnailImageCacheCount + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ sourceUpgradeQueueCount: metrics.sourceUpgradeQueueCount + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ usingSourceImageCount: metrics.usingSourceImageCount + 1 }),
        metrics
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
        createMetrics({ lastUpdateReason: 'preview' }),
        metrics
      )
    ).toBe(false)
  })

  it('queues the latest pending runtime state and clears it after taking a flush snapshot', () => {
    const initial = createProjectCanvasWebGLPendingRuntimeState<ProjectCanvasWebGLRuntimeMetrics>()
    const sourceResidentIds = new Set(['image-a'])
    let pending = queueProjectCanvasWebGLPendingRuntimeIds(
      initial,
      'residentIds',
      sourceResidentIds
    )
    sourceResidentIds.add('image-mutated-after-queue')
    pending = queueProjectCanvasWebGLPendingRuntimeIds(
      pending,
      'resolvedIds',
      new Set(['image-a', 'image-b'])
    )
    pending = queueProjectCanvasWebGLPendingRuntimeIds(pending, 'failedIds', new Set(['image-c']))
    pending = queueProjectCanvasWebGLPendingRuntimeMetrics(
      pending,
      createMetrics({ renderCount: 1 })
    )
    pending = queueProjectCanvasWebGLPendingRuntimeMetrics(
      pending,
      createMetrics({ renderCount: 2 })
    )

    const { pending: flushSnapshot, next } = takeProjectCanvasWebGLPendingRuntimeState(pending)

    expect(flushSnapshot.residentIds).toEqual(new Set(['image-a']))
    expect(flushSnapshot.resolvedIds).toEqual(new Set(['image-a', 'image-b']))
    expect(flushSnapshot.failedIds).toEqual(new Set(['image-c']))
    expect(flushSnapshot.metrics).toEqual(expect.objectContaining({ renderCount: 2 }))
    expect(next).toEqual({
      residentIds: null,
      resolvedIds: null,
      failedIds: null,
      metrics: null
    })
  })

  it('builds and parses the benchmark metrics snapshot without DOM dataset field knowledge', () => {
    const metrics = createMetrics({ residentImageCount: 1 })
    const snapshot = buildProjectCanvasMetricsSnapshot({
      stageScale: 0.75,
      stagePos: { x: -100, y: 50 },
      reactCommits: 3,
      totalItemCount: 4,
      totalImageItemCount: 2,
      visibleItemCount: 3,
      visibleImageItemCount: 2,
      renderSurface: {
        imageItems: 2,
        webglImageItems: 1,
        budgetDowngradedImageItems: 1,
        fallbackImageItems: 0
      },
      fallbackImages: {
        unloadedImageItems: 0,
        failedImageItems: 0,
        unsupportedImageItems: 0
      },
      thumbnailCacheMetrics: {
        thumbnailCount: 2,
        cacheHitCount: 1,
        generatedCount: 1,
        sidecarGeneratedCount: 0,
        nativeGeneratedCount: 0,
        staleCount: 0,
        failedCount: 0,
        ...createThumbnailWorkerPoolRuntimeMetrics()
      },
      webglMetrics: metrics,
      residentLimit: 48,
      residentRemainingCapacity: 47,
      residentTextureRemainingBytes: 1000,
      residentBudgetState: 'available'
    })

    const parsed = parseProjectCanvasMetricsSnapshot(JSON.stringify(snapshot))

    expect(parsed).toEqual(snapshot)
    expect(parsed?.viewport).toEqual({ scale: 0.75, x: -100, y: 50 })
    expect(parsed?.webgl).toEqual(
      expect.objectContaining({
        renderCount: 4,
        spriteReconcilePassCount: 3,
        lastSpriteReconcileDurationMs: 1.5,
        lastSpriteReconcileTargetCount: 1,
        lastSpriteReconcileDeferredCount: 0,
        residentLimit: 48,
        residentBudgetState: 'available'
      })
    )
    expect(parsed?.thumbnailCache).toEqual(
      expect.objectContaining({
        thumbnailCount: 2,
        cacheHitCount: 1,
        cacheGeneratedCount: 1,
        cacheStaleCount: 0,
        ...createThumbnailWorkerPoolRuntimeMetrics()
      })
    )
    expect(parseProjectCanvasMetricsSnapshot('not-json')).toBeNull()
  })

  it('leaves thumbnail worker-pool telemetry absent when no runtime metrics are available', () => {
    const snapshot = buildProjectCanvasMetricsSnapshot({
      stageScale: 1,
      stagePos: { x: 0, y: 0 },
      reactCommits: 0,
      totalItemCount: 0,
      totalImageItemCount: 0,
      visibleItemCount: 0,
      visibleImageItemCount: 0,
      renderSurface: {},
      fallbackImages: {},
      thumbnailCacheMetrics: null,
      webglMetrics: null,
      residentLimit: 0,
      residentRemainingCapacity: 0,
      residentTextureRemainingBytes: 0,
      residentBudgetState: 'uninitialized'
    })

    expect(snapshot.thumbnailCache).toMatchObject({
      thumbnailCount: 0,
      cacheHitCount: 0,
      cacheGeneratedCount: 0
    })
    for (const key of CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS) {
      expect(snapshot.thumbnailCache).not.toHaveProperty(key)
    }
  })
})
