import { describe, expect, it } from 'vitest'
import { getOverlayKindTotal, hasConsistentOverlayAccounting } from './overlayBenchmark.mjs'

describe('overlayBenchmark accounting helpers', () => {
  it('accepts overlay totals only when DOM and per-kind counts agree', () => {
    const metrics = {
      overlayTotalCount: 12,
      domOverlayCount: 12,
      htmlOverlayCount: 3,
      fileOverlayCount: 3,
      textOverlayCount: 3,
      annotationOverlayCount: 3
    }

    expect(getOverlayKindTotal(metrics)).toBe(12)
    expect(hasConsistentOverlayAccounting(metrics)).toBe(true)
    expect(hasConsistentOverlayAccounting({ ...metrics, domOverlayCount: 11 })).toBe(false)
    expect(hasConsistentOverlayAccounting({ ...metrics, annotationOverlayCount: 2 })).toBe(false)
  })
})
