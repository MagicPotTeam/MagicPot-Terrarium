import { describe, expect, it } from 'vitest'
import {
  createVideoBenchmarkItems,
  getMountedVideoModeCount,
  hasConsistentVideoAccounting,
  isVideoBudgetConverged
} from './videoBenchmark.mjs'

describe('videoBenchmark budget accounting helpers', () => {
  it('builds a deterministic active/paused/poster/unmounted workload and zoom anchor', () => {
    const { items, budgetExpectations, seededLayout, zoomAnchor } = createVideoBenchmarkItems(
      24,
      'file:///fixture.webm',
      'fixture.webm'
    )

    expect(items).toHaveLength(24)
    expect(budgetExpectations).toEqual({ totalVideos: 24, maxActivePlaying: 4 })
    expect(seededLayout.activeCandidateCount).toBeGreaterThan(budgetExpectations.maxActivePlaying)
    expect(seededLayout.visiblePausedCount).toBeGreaterThanOrEqual(8)
    expect(seededLayout.posterFrameCount).toBeGreaterThan(0)
    expect(seededLayout.unmountedCount).toBeGreaterThan(0)
    expect(zoomAnchor).toEqual({ x: 736, y: 572 })
  })

  it('accepts metrics only when dataset and mounted overlay node accounting agree', () => {
    const budgetExpectations = { totalVideos: 24, maxActivePlaying: 4 }
    const metrics = {
      totalVideos: 24,
      activePlayingCount: 4,
      visiblePausedCount: 8,
      posterFrameCount: 2,
      unmountedCount: 10,
      activePlayingOverlayCount: 4,
      visiblePausedOverlayCount: 8,
      posterFrameOverlayCount: 2,
      mountedVideoOverlayCount: 14,
      mountedOverlayNodeCount: 14
    }

    expect(getMountedVideoModeCount(metrics)).toBe(14)
    expect(hasConsistentVideoAccounting(metrics, budgetExpectations)).toBe(true)
    expect(isVideoBudgetConverged(metrics, budgetExpectations, 24)).toBe(true)
    expect(
      hasConsistentVideoAccounting({ ...metrics, posterFrameOverlayCount: 1 }, budgetExpectations)
    ).toBe(false)
    expect(
      hasConsistentVideoAccounting(
        { ...metrics, activePlayingCount: 5, activePlayingOverlayCount: 5 },
        budgetExpectations
      )
    ).toBe(false)
    expect(isVideoBudgetConverged({ ...metrics, unmountedCount: 0 }, budgetExpectations, 24)).toBe(
      false
    )
  })
})
