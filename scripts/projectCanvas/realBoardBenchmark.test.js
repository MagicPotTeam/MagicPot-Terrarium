import { describe, expect, it } from 'vitest'
import {
  CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS,
  buildAcceptance,
  buildAggregateScenarioResult,
  buildRealBoardAggregateReport,
  buildRealBoardBenchmarkProfileMetadata,
  buildRepeatWorkloadAssessment,
  resolveRealBoardCachePasses,
  buildSourceTextureVisualFailures,
  isRealBoardBenchmarkMetricsReady,
  readProjectCanvasRealBoardMetricsFromDomSnapshot
} from './realBoardBenchmark.mjs'

function buildWorkerPoolMetrics(values = [2, 1, 1, 4, 5, 6, 7, 8, 9, 10, 2, 32]) {
  return Object.fromEntries(
    CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS.map((key, index) => [key, values[index] ?? 0])
  )
}

function buildFinalMetrics(overrides = {}) {
  return {
    webgl: {
      hasWebglContext: true,
      sourceUpgradeFailedImageCount: 0,
      residentCandidateImageCount: 4,
      sourceCount: 4,
      placeholderMetricAvailable: true,
      placeholderCount: 0,
      ...overrides.webgl
    }
  }
}

function buildInteractionBurst(overrides = {}) {
  return {
    hotPathReactCommits: 0,
    postIdleReactCommits: 0,
    ...overrides
  }
}

function buildOfficialProfileMetadata(overrides = {}) {
  return buildRealBoardBenchmarkProfileMetadata({
    scenarioMode: 'mixed',
    imageCount: 3000,
    pressureDurationMs: 30000,
    cachePasses: ['cold-cache', 'warm-cache'],
    allowRepeat: false,
    memoryWatchdogEnabled: true,
    memorySoftLimitFraction: 0.75,
    memoryHardLimitFraction: 0.8,
    importBatchSize: 128,
    importBatchSettleMs: 500,
    importBatchWaitMetrics: true,
    ...overrides
  })
}

function buildPassingAggregateResult(overrides = {}) {
  return {
    corpusLabel: 'real-corpus',
    scenarioMode: 'mixed',
    cachePass: 'cold-cache',
    benchmarkImageCount: 3000,
    acceptance: { passed: true },
    ...overrides
  }
}

function buildAggregateWithProfile(overrides = {}) {
  const currentResults = overrides.currentResults ?? [buildPassingAggregateResult()]
  const profileMetadata =
    overrides.profileMetadata ?? buildOfficialProfileMetadata(overrides.profileOverrides)

  return buildRealBoardAggregateReport({
    aggregateRoot: 'C:/repo/.magicpot-trash/run-1/real-board',
    currentResults,
    existingResults: [],
    generatedAt: '2025-01-01T00:00:00.000Z',
    memoryWatchdogReport: null,
    profileMetadata
  })
}

function buildVisualFailures(overrides = {}) {
  return {
    failedImages: 0,
    sourceUpgradeFailures: 0,
    sourceUpgradeNotObserved: false,
    sourceTextureRetentionFailure: false,
    retainedSourceCount: 4,
    residentCandidateImageCount: 4,
    missingImages: 0,
    placeholderMetricAvailable: true,
    permanentPlaceholders: 0,
    persistentBlurredImages: 0,
    tinyZoomEnabled: false,
    tinyZoomStageScaleReached: true,
    tinyZoomStageScale: 0.001,
    tinyZoomSourceCount: 0,
    overviewSourceSuppressionAtTinyZoom: true,
    tinyZoomCoordinateMappingFinite: true,
    warmCacheRun: false,
    warmCacheMetricsAvailable: true,
    warmCacheHitCount: 0,
    warmCacheGeneratedCount: 0,
    warmCacheHitsCoverImported: true,
    warmCacheGeneratedNearZero: true,
    frameTimeP95Overflow: false,
    frameTimeP95Ms: 0,
    frameTimeP95LimitMs: 24,
    rightSideOcclusion: false,
    rightOcclusionPx: 0,
    drawableRightMismatchPx: 0,
    hotPathReactCommitOverflow: false,
    postIdleReactCommitOverflow: false,
    maximumUpdateDepthErrors: 0,
    windowPlacementFailures: [],
    repeatWorkload: false,
    repeatWorkloadAccepted: true,
    repeatSmokeRun: false,
    repeatMinUniqueFraction: null,
    repeatMinUniqueImageCount: 0,
    repeatUniqueImageCount: null,
    repeatBenchmarkImageCount: null,
    repeatUniqueFraction: null,
    pressureSamplingConfigured: false,
    pressureSamplingIncomplete: false,
    pressureSampleCount: 0,
    ...overrides
  }
}

describe('realBoardBenchmark acceptance gates', () => {
  it('marks the default official mixed-3000 profile as non-diagnostic', () => {
    const profile = buildOfficialProfileMetadata()
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(true)
    expect(profile.diagnosticReasons).toEqual([])
    expect(aggregate.officialProfile).toBe(true)
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(true)
    expect(aggregate.allPassed).toBe(true)
  })

  it('prevents allow-repeat runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ allowRepeat: true })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('allowRepeat=true')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents watchdog-disabled runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ memoryWatchdogEnabled: false })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('memory watchdog disabled')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents relaxed watchdog thresholds from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({
      memorySoftLimitFraction: 0.9,
      memoryHardLimitFraction: 0.95
    })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('memory watchdog soft limit=0.9')
    expect(profile.diagnosticReasons.join(' ')).toContain('memory watchdog hard limit=0.95')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents lowered image count runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ imageCount: 300 })
    const aggregate = buildAggregateWithProfile({
      profileMetadata: profile,
      currentResults: [buildPassingAggregateResult({ benchmarkImageCount: 300 })]
    })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('imageCount=300')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents shortened pressure runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ pressureDurationMs: 15000 })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('pressureDurationMs=15000')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents disabled pressure runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ pressureDurationMs: 0 })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('pressureDurationMs=0')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents import batching overrides from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({
      importBatchSize: 64,
      importBatchSettleMs: 0,
      importBatchWaitMetrics: false
    })
    const aggregate = buildAggregateWithProfile({ profileMetadata: profile })
    const reasons = profile.diagnosticReasons.join(' ')

    expect(profile.officialProfile).toBe(false)
    expect(reasons).toContain('importBatchSize=64')
    expect(reasons).toContain('importBatchSettleMs=0')
    expect(reasons).toContain('importBatchWaitMetrics=false')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('prevents single cache pass runs from reporting official aggregate allPassed', () => {
    const profile = buildOfficialProfileMetadata({ cachePasses: ['cold-cache'] })
    const aggregate = buildAggregateWithProfile({
      profileMetadata: profile,
      currentResults: [buildPassingAggregateResult({ cachePass: 'cold-cache' })]
    })

    expect(profile.officialProfile).toBe(false)
    expect(profile.diagnosticReasons.join(' ')).toContain('cachePasses=cold-cache')
    expect(aggregate.acceptanceAllPassed).toBe(true)
    expect(aggregate.officialAllPassed).toBe(false)
    expect(aggregate.allPassed).toBe(false)
  })

  it('promotes final overlay, React, heap, and texture metrics into aggregate results', () => {
    const aggregateResult = buildAggregateScenarioResult({
      corpusLabel: 'real-corpus',
      corpusRoot: 'C:/images',
      scenarioMode: 'mixed',
      benchmarkImageCount: 3000,
      scenarioRoot: 'C:/repo/.magicpot-trash/run-1/real-board/real-corpus/mixed-3000',
      reportPath:
        'C:/repo/.magicpot-trash/run-1/real-board/real-corpus/mixed-3000/real-board-benchmark-report.json',
      corpus: {
        label: 'real-corpus',
        root: 'C:/images',
        candidateImageCount: 1800,
        uniqueContentHashCount: 1800,
        decodedImageCount: 3000,
        skippedImageCount: 0
      },
      candidateImageCount: 1800,
      uniqueContentHashCount: 1800,
      decodedImageCount: 3000,
      skippedImageCount: 0,
      culledImageCount: 2400,
      frameTime: { p95: 8.5 },
      hotPathReactCommits: 0,
      sourceUpgradeLatencyMs: 421,
      sourceUpgradeFailures: 0,
      persistentPreviewCount: 0,
      finalMetrics: {
        reactCommits: 12,
        domNodeCount: 345,
        jsHeapBytes: 123456789,
        overlayMetrics: {
          overlayTotalCount: 24,
          domOverlayCount: 6,
          mountedVideoOverlayCount: 2
        },
        webgl: {
          loadedImageCount: 3000,
          failedImageCount: 0,
          missingImageCount: 0,
          placeholderMetricAvailable: true,
          placeholderCount: 0,
          residentImageCount: 384,
          residentTextureBytes: 987654321,
          residentTextureBudgetBytes: 1073741824,
          previewCount: 0,
          sourceCount: 384,
          sourceUpgradeablePreviewCount: 0,
          upgradePendingCount: 0,
          sourceUpgradeFailedImageCount: 0
        },
        thumbnailCache: {
          metricAvailable: true,
          thumbnailCount: 9000,
          cacheHitCount: 3000,
          cacheGeneratedCount: 0,
          cacheStaleCount: 0,
          ...buildWorkerPoolMetrics()
        },
        largeImageResourceMetrics: {
          schemaName: 'project-canvas-large-image-resource-diagnostics',
          schemaVersion: 1,
          diagnosticOnly: true,
          officialAcceptanceImpact: false,
          thresholdsChanged: false,
          values: {
            firstThumbnailMs: 19,
            cacheHitCount: 3000,
            nativeGeneratedCount: 0,
            sidecarGeneratedCount: 0,
            residentTextureBytes: 987654321,
            sourceUpgradeCount: 384,
            evictionCount: 2,
            evictionReasons: { budget: 2 },
            lastEvictionReason: 'budget',
            objectUrlCount: 3
          },
          fields: {},
          availability: {},
          sources: {},
          derivedFields: [],
          schema: { fields: [] }
        }
      },
      tinyZoomAcceptance: {
        enabled: true,
        stageScale: 0.001,
        sourceCountAtTinyZoom: 0,
        passed: true
      },
      visualFailures: buildVisualFailures(),
      acceptance: { passed: true }
    })

    expect(aggregateResult.officialProfile).toBe(false)
    expect(aggregateResult.diagnosticReasons.join(' ')).toContain('pressureDurationMs=0')
    expect(aggregateResult.metrics).toEqual({
      reactCommits: 12,
      domNodeCount: 345,
      jsHeapBytes: 123456789,
      overlayTotalCount: 24,
      domOverlayCount: 6,
      mountedVideoOverlayCount: 2,
      loadedImageCount: 3000,
      failedImageCount: 0,
      missingImageCount: 0,
      placeholderCount: 0,
      placeholderMetricAvailable: true,
      residentImageCount: 384,
      residentTextureBytes: 987654321,
      residentTextureBudgetBytes: 1073741824,
      previewCount: 0,
      sourceCount: 384,
      sourceUpgradeSuppressedImageCount: null,
      sourceUpgradeablePreviewCount: 0,
      upgradePendingCount: 0,
      sourceUpgradeFailedImageCount: 0
    })
    expect(aggregateResult.thumbnailCache).toEqual({
      metricAvailable: true,
      thumbnailCount: 9000,
      cacheHitCount: 3000,
      cacheGeneratedCount: 0,
      cacheStaleCount: 0,
      ...buildWorkerPoolMetrics()
    })
    expect(aggregateResult.largeImageResourceMetrics.diagnosticOnly).toBe(true)
    expect(aggregateResult.largeImageResourceMetrics.officialAcceptanceImpact).toBe(false)
    expect(aggregateResult.largeImageResourceMetrics.values).toMatchObject({
      firstThumbnailMs: 19,
      cacheHitCount: 3000,
      residentTextureBytes: 987654321,
      sourceUpgradeCount: 384,
      evictionCount: 2,
      objectUrlCount: 3
    })
    expect(aggregateResult.diagnosticSummary.largeImageResources).toContain(
      'first-thumbnail-ms=19ms'
    )
    expect(aggregateResult.tinyZoomAcceptance).toEqual({
      enabled: true,
      stageScale: 0.001,
      sourceCountAtTinyZoom: 0,
      passed: true
    })
    expect(aggregateResult.benchmarkImageCount).toBe(3000)
  })

  it('parses real-board optional large image resource diagnostics without acceptance gates', () => {
    const metrics = readProjectCanvasRealBoardMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasRenderSurfaceSummary: JSON.stringify({
          totalItems: 10,
          imageItems: 10
        }),
        projectCanvasTotalImageItemCount: '10',
        projectCanvasVisibleImageItemCount: '4',
        projectCanvasWebglLoadedImageCount: '4',
        projectCanvasWebglResidentTextureBytes: '8192',
        projectCanvasMetricsSnapshot: JSON.stringify({
          thumbnailCache: {
            firstThumbnailLatencyMs: 27,
            cacheHitCount: 5,
            nativeGeneratedCount: 2,
            sidecarGeneratedCount: 3,
            ...buildWorkerPoolMetrics([2, 1, 1, 3, 4, 5, 6, 7, 8, 9, 2, 32])
          },
          webgl: {
            loadedImageCount: 7,
            pendingImageCount: 2,
            residentTextureBytes: 16384,
            sourceImageCacheCount: 11,
            thumbnailImageCacheCount: 12,
            sourceUpgradeQueueCount: 13,
            thumbnailLoadQueueCount: 14,
            initialLoadQueueCount: 15,
            renderCount: 3,
            lastRenderDurationMs: 4.5,
            spriteReconcilePassCount: 8,
            lastSpriteReconcileDurationMs: 1.125,
            lastSpriteReconcileCandidateCount: 10,
            lastSpriteReconcileTargetCount: 7,
            lastSpriteReconcileCreatedCount: 3,
            lastSpriteReconcileReusedCount: 4,
            lastSpriteReconcileRemovedCount: 2,
            lastSpriteReconcileDeferredCount: 1,
            lastUpdateReason: 'items',
            sourceUpgradeCompletedCount: 4,
            evictionReasons: [{ reason: 'budget', count: 2 }]
          }
        }),
        projectCanvasObjectUrlCount: '6'
      },
      domMetrics: {
        domNodeCount: 25,
        viewportWidth: 1024,
        clientRect: { x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 },
        drawableRect: { x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 },
        hasWebglContext: true
      }
    })

    expect(metrics.largeImageResourceMetrics.diagnosticOnly).toBe(true)
    expect(metrics.largeImageResourceMetrics.thresholdsChanged).toBe(false)
    expect(metrics.largeImageResourceMetrics.values).toMatchObject({
      firstThumbnailMs: 27,
      cacheHitCount: 5,
      nativeGeneratedCount: 2,
      sidecarGeneratedCount: 3,
      residentTextureBytes: 16384,
      sourceUpgradeCount: 4,
      evictionCount: 2,
      evictionReasons: { budget: 2 },
      objectUrlCount: 6
    })
    expect(metrics.diagnosticMetrics.largeImageResources).toBe(metrics.largeImageResourceMetrics)
    expect(metrics.webgl).toMatchObject({
      hasWebglContext: true,
      loadedImageCount: 7,
      pendingImageCount: 2,
      residentTextureBytes: 16384,
      sourceImageCacheCount: 11,
      thumbnailImageCacheCount: 12,
      sourceUpgradeQueueCount: 13,
      thumbnailLoadQueueCount: 14,
      initialLoadQueueCount: 15,
      renderCount: 3,
      lastRenderDurationMs: 4.5,
      spriteReconcilePassCount: 8,
      lastSpriteReconcileDurationMs: 1.125,
      lastSpriteReconcileCandidateCount: 10,
      lastSpriteReconcileTargetCount: 7,
      lastSpriteReconcileCreatedCount: 3,
      lastSpriteReconcileReusedCount: 4,
      lastSpriteReconcileRemovedCount: 2,
      lastSpriteReconcileDeferredCount: 1,
      lastUpdateReason: 'items'
    })
  })

  it('falls back to real-board dataset fields for WebGL sprite reconcile metrics', () => {
    const metrics = readProjectCanvasRealBoardMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasRenderSurfaceSummary: JSON.stringify({
          totalItems: 4,
          imageItems: 4
        }),
        projectCanvasWebglSpriteReconcilePassCount: '3',
        projectCanvasWebglLastSpriteReconcileDurationMs: '0.75',
        projectCanvasWebglLastSpriteReconcileCandidateCount: '4',
        projectCanvasWebglLastSpriteReconcileTargetCount: '4',
        projectCanvasWebglLastSpriteReconcileCreatedCount: '2',
        projectCanvasWebglLastSpriteReconcileReusedCount: '2',
        projectCanvasWebglLastSpriteReconcileRemovedCount: '1',
        projectCanvasWebglLastSpriteReconcileDeferredCount: '0'
      }
    })

    expect(metrics.webgl).toMatchObject({
      spriteReconcilePassCount: 3,
      lastSpriteReconcileDurationMs: 0.75,
      lastSpriteReconcileCandidateCount: 4,
      lastSpriteReconcileTargetCount: 4,
      lastSpriteReconcileCreatedCount: 2,
      lastSpriteReconcileReusedCount: 2,
      lastSpriteReconcileRemovedCount: 1,
      lastSpriteReconcileDeferredCount: 0
    })
  })

  it('requires real-board readiness to observe post-import render and sprite reconcile metrics', () => {
    const readyMetrics = {
      itemCounts: {
        totalImageItemCount: 4
      },
      webgl: {
        hasWebglContext: true,
        loadedImageCount: 4,
        failedImageCount: 0,
        pendingImageCount: 0,
        residentCandidateImageCount: 4,
        viewportCulledImageCount: 0,
        sourceUpgradeQueueCount: 0,
        thumbnailLoadQueueCount: 0,
        initialLoadQueueCount: 0,
        renderCount: 12,
        spriteReconcilePassCount: 12,
        lastSpriteReconcileCandidateCount: 4,
        lastSpriteReconcileDeferredCount: 0,
        lastRenderDurationMs: 5.5,
        lastUpdateReason: 'items'
      }
    }

    expect(isRealBoardBenchmarkMetricsReady(readyMetrics, 4, 11, 11)).toBe(true)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, renderCount: 11 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, spriteReconcilePassCount: 11 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        {
          ...readyMetrics,
          webgl: { ...readyMetrics.webgl, lastSpriteReconcileDeferredCount: 1 }
        },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        {
          ...readyMetrics,
          webgl: { ...readyMetrics.webgl, lastSpriteReconcileCandidateCount: 3 }
        },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, itemCounts: { totalImageItemCount: 3 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        {
          ...readyMetrics,
          webgl: {
            ...readyMetrics.webgl,
            residentCandidateImageCount: 3,
            viewportCulledImageCount: 0,
            lastSpriteReconcileCandidateCount: 3
          }
        },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, sourceUpgradeQueueCount: 1 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, thumbnailLoadQueueCount: 1 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, initialLoadQueueCount: 1 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, lastRenderDurationMs: 0 } },
        4,
        11,
        11
      )
    ).toBe(false)
    expect(
      isRealBoardBenchmarkMetricsReady(
        { ...readyMetrics, webgl: { ...readyMetrics.webgl, lastUpdateReason: 'cleanup' } },
        4,
        11,
        11
      )
    ).toBe(false)
  })

  it('allows bounded deferred React commits for idle source texture upgrades', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures({
        postIdleReactCommitOverflow: false
      }),
      interactionBurst: buildInteractionBurst({
        postIdleReactCommits: 5
      })
    })

    expect(acceptance.postIdleReactCommitsWithinLimit).toBe(true)
    expect(acceptance.postIdleReactCommitLimit).toBe(8)
    expect(acceptance.postIdleReactCommits).toBe(5)
    expect(acceptance.passed).toBe(true)
  })

  it('fails excessive deferred React commits after the interaction burst settles', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures({
        postIdleReactCommitOverflow: true
      }),
      interactionBurst: buildInteractionBurst({
        postIdleReactCommits: 9
      })
    })

    expect(acceptance.postIdleReactCommitsWithinLimit).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain('Deferred/post-idle React commits 9 exceeded limit 8.')
  })

  it('accepts repeat-heavy real workloads when unique source coverage meets the floor', () => {
    const repeatAssessment = buildRepeatWorkloadAssessment({
      allowRepeat: true,
      benchmarkImageCount: 944,
      benchmarkUniqueContentHashCount: 472
    })
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures(repeatAssessment),
      interactionBurst: buildInteractionBurst()
    })

    expect(repeatAssessment.repeatWorkload).toBe(true)
    expect(repeatAssessment.repeatSmokeRun).toBe(false)
    expect(repeatAssessment.repeatMinUniqueImageCount).toBe(472)
    expect(repeatAssessment.repeatUniqueFraction).toBe(0.5)
    expect(acceptance.repeatWorkloadAccepted).toBe(true)
    expect(acceptance.passed).toBe(true)
  })

  it('keeps low-coverage repeated corpora as diagnostic smoke instead of acceptance', () => {
    const repeatAssessment = buildRepeatWorkloadAssessment({
      allowRepeat: true,
      benchmarkImageCount: 944,
      benchmarkUniqueContentHashCount: 12
    })
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures(repeatAssessment),
      interactionBurst: buildInteractionBurst()
    })

    expect(repeatAssessment.repeatSmokeRun).toBe(true)
    expect(acceptance.repeatWorkloadAccepted).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      'Repeat-heavy real workload requires at least 472 unique source image(s) for 944 benchmark item(s); found 12. Lower MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION only for diagnostic smoke runs.'
    )
  })

  it('fails when pressure sampling is configured but absent or incomplete', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures({
        pressureSamplingConfigured: true,
        pressureSamplingIncomplete: true,
        pressureSampleCount: 1
      }),
      interactionBurst: buildInteractionBurst()
    })

    expect(acceptance.pressureSamplingEnabledWhenConfigured).toBe(false)
    expect(acceptance.pressureSamplingCompleted).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      'Pressure sampling was configured but did not run in the real-board benchmark stress path.'
    )
    expect(acceptance.failures).toContain(
      'Pressure sampling was configured but captured only 1 sample(s).'
    )
  })

  it('fails when placeholder telemetry is missing instead of treating it as zero', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics({
        webgl: {
          placeholderMetricAvailable: false,
          placeholderCount: null
        }
      }),
      visualFailures: buildVisualFailures({
        placeholderMetricAvailable: false,
        permanentPlaceholders: null
      }),
      interactionBurst: buildInteractionBurst()
    })

    expect(acceptance.placeholderMetricAvailable).toBe(false)
    expect(acceptance.noPermanentPlaceholders).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      'ProjectCanvas benchmark metrics did not expose placeholderCount; refusing to treat missing placeholder telemetry as zero.'
    )
  })

  it('fails permanent placeholder thumbnails after preview generation settles', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics({
        webgl: {
          placeholderCount: 3
        }
      }),
      visualFailures: buildVisualFailures({
        permanentPlaceholders: 3
      }),
      interactionBurst: buildInteractionBurst()
    })

    expect(acceptance.noPermanentPlaceholders).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      '3 permanent placeholder image(s) remained after preview generation settled.'
    )
  })

  it('fails tiny-zoom acceptance when overview still has source textures', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures({
        tinyZoomEnabled: true,
        tinyZoomStageScaleReached: true,
        overviewSourceSuppressionAtTinyZoom: false,
        tinyZoomSourceCount: 2
      }),
      interactionBurst: buildInteractionBurst()
    })

    expect(acceptance.overviewSourceSuppressedAtTinyZoom).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      'Tiny-zoom overview still reported 2 source texture(s); expected 0 at scale <= 0.15.'
    )
  })

  it('requires warm-cache hit/generated thumbnail metrics for acceptance', () => {
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures({
        benchmarkImageCount: 472,
        warmCacheRun: true,
        warmCacheMetricsAvailable: true,
        warmCacheHitCount: 471,
        warmCacheGeneratedCount: 2,
        warmCacheHitsCoverImported: false,
        warmCacheGeneratedNearZero: false
      }),
      interactionBurst: buildInteractionBurst()
    })

    expect(acceptance.warmCacheMetricsAvailable).toBe(true)
    expect(acceptance.warmCacheHitsCoverImported).toBe(false)
    expect(acceptance.warmCacheGeneratedNearZero).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain(
      'Warm-cache run reported 471 thumbnail cache hit(s) for 472 imported image(s).'
    )
    expect(acceptance.failures).toContain('Warm-cache run generated 2 thumbnail(s), above limit 1.')
  })

  it('defaults real-corpus import benchmarks to cold and warm cache passes', () => {
    expect(
      resolveRealBoardCachePasses({
        configuredValue: '',
        scenarioMode: 'import',
        hasConfiguredRealCorpus: true
      })
    ).toEqual(['cold-cache', 'warm-cache'])
    expect(
      resolveRealBoardCachePasses({
        configuredValue: '',
        scenarioMode: 'seeded-hires',
        hasConfiguredRealCorpus: false
      })
    ).toEqual(['cold-cache'])
  })

  it('rejects warm-cache-only real-board runs because they cannot prove cache warming', () => {
    expect(() =>
      resolveRealBoardCachePasses({
        configuredValue: 'warm-cache',
        scenarioMode: 'import',
        hasConfiguredRealCorpus: true
      })
    ).toThrow('warm-cache real-board acceptance requires a preceding cold-cache pass.')
  })

  it('reports source texture upgrade and retention failures explicitly', () => {
    const sourceFailures = buildSourceTextureVisualFailures(
      {
        sourceUpgradeObserved: false,
        sourceUpgradeFailures: 2,
        afterZoom: {
          residentCandidateImageCount: 5,
          sourceCount: 0
        }
      },
      buildFinalMetrics()
    )
    const acceptance = buildAcceptance({
      finalMetrics: buildFinalMetrics(),
      visualFailures: buildVisualFailures(sourceFailures),
      interactionBurst: buildInteractionBurst()
    })

    expect(sourceFailures.sourceUpgradeFailures).toBe(2)
    expect(sourceFailures.sourceUpgradeNotObserved).toBe(true)
    expect(sourceFailures.sourceTextureRetentionFailure).toBe(true)
    expect(acceptance.noSourceUpgradeFailures).toBe(false)
    expect(acceptance.sourceUpgradeObserved).toBe(false)
    expect(acceptance.sourceTexturesRetained).toBe(false)
    expect(acceptance.passed).toBe(false)
    expect(acceptance.failures).toContain('2 source image upgrade(s) failed.')
    expect(acceptance.failures).toContain(
      'Source texture upgrade did not complete; no source upgrade progress was observed during the high-zoom probe.'
    )
    expect(acceptance.failures).toContain(
      'Source texture retention failed: retained 0 source texture(s) for 5 resident candidate image(s).'
    )
  })
})
