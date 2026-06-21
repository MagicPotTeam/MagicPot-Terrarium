import { describe, expect, it } from 'vitest'
import { readProjectCanvasBenchmarkMetricsFromDomSnapshot } from './webglBenchmark.mjs'

describe('webglBenchmark metrics reader', () => {
  it('prefers the metrics snapshot over legacy dataset fields', () => {
    const metrics = readProjectCanvasBenchmarkMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasMetricsSnapshot: JSON.stringify({
          renderSurface: {
            imageItems: 8,
            webglImageItems: 7,
            fallbackImageItems: 1,
            budgetDowngradedImageItems: 0
          },
          webgl: {
            loadedImageCount: 7,
            residentCandidateImageCount: 7,
            viewportCulledImageCount: 1,
            residentLimit: 7,
            residentRemainingCapacity: 0,
            residentBudgetState: 'full',
            renderCount: 11,
            lastRenderDurationMs: 4.5,
            lastUpdateReason: 'snapshot'
          },
          viewport: {
            scale: 2,
            x: 33,
            y: 44
          },
          reactCommits: 12
        }),
        projectCanvasRenderSurfaceSummary: JSON.stringify({
          imageItems: 99,
          webglImageItems: 99,
          fallbackImageItems: 99,
          budgetDowngradedImageItems: 99
        }),
        projectCanvasWebglLoadedImageCount: '99',
        projectCanvasWebglResidentCandidateImageCount: '99',
        projectCanvasWebglViewportCulledImageCount: '99',
        projectCanvasWebglResidentLimit: '99',
        projectCanvasWebglResidentRemainingCapacity: '99',
        projectCanvasWebglResidentBudgetState: 'legacy',
        projectCanvasWebglRenderCount: '99',
        projectCanvasWebglLastRenderDurationMs: '99',
        projectCanvasWebglLastUpdateReason: 'legacy',
        projectCanvasReactCommitCount: '99',
        stageScale: '99',
        stagePosX: '99',
        stagePosY: '99'
      },
      overlayDataset: {
        projectCanvasOverlayTotalCount: '3',
        projectCanvasDomOverlayCount: '2'
      },
      domNodeCount: 123,
      hasWebglContext: true
    })

    expect(metrics.summary.webglImageItems).toBe(7)
    expect(metrics.loadedImageCount).toBe(7)
    expect(metrics.residentBudgetState).toBe('full')
    expect(metrics.renderCount).toBe(11)
    expect(metrics.lastRenderDurationMs).toBe(4.5)
    expect(metrics.lastUpdateReason).toBe('snapshot')
    expect(metrics.reactCommits).toBe(12)
    expect(metrics.stageScale).toBe(2)
    expect(metrics.stagePosX).toBe(33)
    expect(metrics.stagePosY).toBe(44)
    expect(metrics.overlayMetrics.overlayTotalCount).toBe(3)
    expect(metrics.overlayMetrics.domOverlayCount).toBe(2)
    expect(metrics.largeImageResourceMetrics.diagnosticOnly).toBe(true)
    expect(metrics.diagnosticMetrics.largeImageResources.officialAcceptanceImpact).toBe(false)
    expect(metrics.domNodeCount).toBe(123)
    expect(metrics.hasWebglContext).toBe(true)
  })

  it('falls back to legacy dataset fields when no snapshot exists', () => {
    const metrics = readProjectCanvasBenchmarkMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasRenderSurfaceSummary: JSON.stringify({
          imageItems: 4,
          webglImageItems: 4,
          fallbackImageItems: 0,
          budgetDowngradedImageItems: 0
        }),
        projectCanvasWebglLoadedImageCount: '4',
        projectCanvasWebglResidentCandidateImageCount: '4',
        projectCanvasWebglViewportCulledImageCount: '0',
        projectCanvasWebglResidentLimit: '8',
        projectCanvasWebglResidentBudgetState: 'available',
        projectCanvasWebglRenderCount: '2',
        projectCanvasWebglLastRenderDurationMs: '6.25',
        stageScale: '1.5',
        stagePosX: '12',
        stagePosY: '24'
      }
    })

    expect(metrics.summary.imageItems).toBe(4)
    expect(metrics.loadedImageCount).toBe(4)
    expect(metrics.residentLimit).toBe(8)
    expect(metrics.residentBudgetState).toBe('available')
    expect(metrics.renderCount).toBe(2)
    expect(metrics.lastRenderDurationMs).toBe(6.25)
    expect(metrics.stageScale).toBe(1.5)
    expect(metrics.stagePosX).toBe(12)
    expect(metrics.stagePosY).toBe(24)
    expect(metrics.largeImageResourceMetrics.values.residentTextureBytes).toBeNull()
  })

  it('attaches optional large image resource diagnostics from snapshot and dataset fields', () => {
    const metrics = readProjectCanvasBenchmarkMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasMetricsSnapshot: JSON.stringify({
          renderSurface: {
            imageItems: 2,
            webglImageItems: 2,
            fallbackImageItems: 0,
            budgetDowngradedImageItems: 0
          },
          thumbnailCache: {
            firstThumbnailMs: 33,
            cacheHitCount: 2,
            nativeGeneratedCount: 1,
            sidecarGeneratedCount: 1,
            sidecarFailedCount: 1
          },
          release: {
            revokedObjectUrlCount: 5,
            closedImageBitmapCount: 6,
            disposedTextureCount: 7,
            disposedLeaseCount: 8,
            errorCount: 0
          },
          resourceBudget: {
            budgetPressure: 'decoded-in-flight',
            usage: {
              decodedInFlightBytes: 1024
            }
          },
          webgl: {
            residentTextureBytes: 2048,
            residentTextureBudgetBytes: 8192,
            sourceUpgradeCount: 2,
            evictionReasons: ['budget', 'budget', 'viewport']
          }
        }),
        projectCanvasObjectUrlCount: '4'
      }
    })

    expect(metrics.largeImageResourceMetrics.values).toMatchObject({
      firstThumbnailMs: 33,
      cacheHitCount: 2,
      nativeGeneratedCount: 1,
      sidecarGeneratedCount: 1,
      residentTextureBytes: 2048,
      sourceUpgradeCount: 2,
      evictionCount: 3,
      evictionReasons: {
        budget: 2,
        viewport: 1
      },
      objectUrlCount: 4,
      activeObjectUrlCount: 4,
      revokedObjectUrlCount: 5,
      closedImageBitmapCount: 6,
      disposedTextureCount: 7,
      disposedLeaseCount: 8,
      releaseErrorCount: 0,
      residentTextureBudgetBytes: 8192,
      decodedInFlightBytes: 1024,
      resourceBudgetPressure: 'decoded-in-flight',
      sidecarFailedCount: 1
    })
    expect(metrics.diagnosticMetrics.largeImageResources).toBe(metrics.largeImageResourceMetrics)
  })
})
