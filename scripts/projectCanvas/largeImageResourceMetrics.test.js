import { describe, expect, it } from 'vitest'
import {
  collectProjectCanvasLargeImageResourceMetricsFromDomSnapshot,
  formatProjectCanvasLargeImageResourceMetrics,
  validateProjectCanvasLargeImageResourceMetrics
} from './largeImageResourceMetrics.mjs'

describe('large image resource diagnostic metrics', () => {
  it('collects optional schema fields from the metrics snapshot without acceptance impact', () => {
    const metrics = collectProjectCanvasLargeImageResourceMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasMetricsSnapshot: JSON.stringify({
          thumbnailCache: {
            firstThumbnailMs: 42.5,
            cacheHitCount: 7,
            nativeGeneratedCount: 3,
            sidecarGeneratedCount: 4,
            sidecarFailedCount: 1
          },
          objectUrls: {
            activeObjectUrlCount: 6,
            revokedObjectUrlCount: 9
          },
          release: {
            closedImageBitmapCount: 10,
            disposedTextureCount: 11,
            disposedLeaseCount: 12,
            errorCount: 1
          },
          resourceBudget: {
            budgetPressure: 'source-texture',
            usage: {
              decodedInFlightBytes: 512
            }
          },
          webgl: {
            residentTextureBytes: 1024,
            residentTextureBudgetBytes: 8192,
            sourceUpgradeCompletedImageCount: 5,
            evictionReasonCounts: {
              budget: 2,
              viewport: 1
            },
            objectUrlCount: 6
          }
        })
      }
    })

    expect(metrics.diagnosticOnly).toBe(true)
    expect(metrics.officialAcceptanceImpact).toBe(false)
    expect(metrics.thresholdsChanged).toBe(false)
    expect(metrics.values).toMatchObject({
      firstThumbnailMs: 42.5,
      cacheHitCount: 7,
      nativeGeneratedCount: 3,
      sidecarGeneratedCount: 4,
      residentTextureBytes: 1024,
      sourceUpgradeCount: 5,
      evictionCount: 3,
      evictionReasons: {
        budget: 2,
        viewport: 1
      },
      objectUrlCount: 6,
      activeObjectUrlCount: 6,
      revokedObjectUrlCount: 9,
      closedImageBitmapCount: 10,
      disposedTextureCount: 11,
      disposedLeaseCount: 12,
      releaseErrorCount: 1,
      residentTextureBudgetBytes: 8192,
      decodedInFlightBytes: 512,
      resourceBudgetPressure: 'source-texture',
      sidecarFailedCount: 1
    })
    expect(metrics.fields).toMatchObject({
      'first-thumbnail-ms': 42.5,
      'cache-hit-count': 7,
      'native-generated-count': 3,
      'sidecar-generated-count': 4,
      'resident-texture-bytes': 1024,
      'source-upgrade-count': 5,
      'eviction-count': 3,
      'eviction-reasons': {
        budget: 2,
        viewport: 1
      },
      'object-url-count': 6,
      'active-object-url-count': 6,
      'revoked-object-url-count': 9,
      'closed-image-bitmap-count': 10,
      'disposed-texture-count': 11,
      'disposed-lease-count': 12,
      'release-error-count': 1,
      'resident-texture-budget-bytes': 8192,
      'decoded-in-flight-bytes': 512,
      'resource-budget-pressure': 'source-texture',
      'sidecar-failed-count': 1
    })
    expect(metrics.derivedFields).toContain('evictionCount')
    expect(validateProjectCanvasLargeImageResourceMetrics(metrics)).toEqual([])
  })

  it('falls back to legacy dataset fields and formats observed diagnostics', () => {
    const metrics = collectProjectCanvasLargeImageResourceMetricsFromDomSnapshot({
      rootDataset: {
        projectCanvasThumbnailFirstMs: '12',
        projectCanvasThumbnailCacheHitCount: '9',
        projectCanvasNativeThumbnailGeneratedCount: '2',
        projectCanvasSidecarThumbnailGeneratedCount: '8',
        projectCanvasWebglResidentTextureBytes: '4096',
        projectCanvasWebglSourceUpgradeCompletedCount: '4',
        projectCanvasWebglEvictionCount: '3',
        projectCanvasWebglLastEvictionReason: 'texture-budget',
        projectCanvasObjectUrlCount: '11'
      }
    })

    expect(metrics.values).toMatchObject({
      firstThumbnailMs: 12,
      cacheHitCount: 9,
      nativeGeneratedCount: 2,
      sidecarGeneratedCount: 8,
      residentTextureBytes: 4096,
      sourceUpgradeCount: 4,
      evictionCount: 3,
      lastEvictionReason: 'texture-budget',
      objectUrlCount: 11
    })
    expect(formatProjectCanvasLargeImageResourceMetrics(metrics)).toContain(
      'first-thumbnail-ms=12ms'
    )
    expect(formatProjectCanvasLargeImageResourceMetrics(metrics)).toContain('object-url-count=11')
  })

  it('derives resource budget pressure from structured budget pressure and validates state strings', () => {
    const metrics = collectProjectCanvasLargeImageResourceMetricsFromDomSnapshot({
      metricsSnapshot: {
        resourceBudget: {
          pressure: {
            sourceTextureBytes: 'pressure',
            thumbnailTextureBytes: 'available',
            decodedInFlightBytes: 'unbounded',
            objectUrls: 'limit-reached'
          }
        }
      }
    })

    expect(metrics.values.resourceBudgetPressure).toBe(
      'sourceTextureBytes:pressure,objectUrls:limit-reached'
    )
    expect(metrics.derivedFields).toContain('resourceBudgetPressure')
    expect(validateProjectCanvasLargeImageResourceMetrics(metrics)).toEqual([])

    const invalidMetrics = {
      ...metrics,
      values: {
        ...metrics.values,
        resourceBudgetPressure: 1
      }
    }
    expect(validateProjectCanvasLargeImageResourceMetrics(invalidMetrics)).toContain(
      'resourceBudgetPressure must be a string or null'
    )
  })

  it('keeps missing optional telemetry explicit instead of manufacturing zeroes', () => {
    const metrics = collectProjectCanvasLargeImageResourceMetricsFromDomSnapshot({
      rootDataset: {}
    })

    expect(metrics.values.firstThumbnailMs).toBeNull()
    expect(metrics.values.cacheHitCount).toBeNull()
    expect(metrics.values.residentTextureBytes).toBeNull()
    expect(metrics.availability.firstThumbnailMs).toBe(false)
    expect(formatProjectCanvasLargeImageResourceMetrics(metrics)).toBe(
      'no optional large image resource diagnostics observed'
    )
    expect(validateProjectCanvasLargeImageResourceMetrics(metrics)).toEqual([])
  })
})
