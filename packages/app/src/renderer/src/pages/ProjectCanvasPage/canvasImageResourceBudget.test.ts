import { describe, expect, it } from 'vitest'

import {
  CanvasImageResourceBudgetTracker,
  buildCanvasImageResourceBudgetMetricsSnapshot,
  estimateCanvasImageTextureBytes,
  getCanvasImageResourceBudgetEvictionCandidates,
  resolveCanvasImageResourceBudgetAdmission,
  type CanvasImageResourceBudgetReservation
} from './canvasImageResourceBudget'

function reservation(
  id: string,
  overrides: Partial<CanvasImageResourceBudgetReservation> = {}
): CanvasImageResourceBudgetReservation {
  return {
    id,
    sourceTextureBytes: 0,
    thumbnailTextureBytes: 0,
    decodedInFlightBytes: 0,
    objectUrlCount: 0,
    activeSourceUpgrades: 0,
    evictable: true,
    visible: true,
    selected: false,
    priority: 0,
    lastAccessedAt: 0,
    ...overrides
  }
}

describe('canvasImageResourceBudget', () => {
  it('allows admission when source, thumbnail, decode, object URL, and source upgrade usage fits limits', () => {
    const decision = resolveCanvasImageResourceBudgetAdmission({
      currentUsage: {
        sourceTextureBytes: estimateCanvasImageTextureBytes(8, 8),
        thumbnailTextureBytes: 64,
        decodedInFlightBytes: 128,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      request: {
        sourceTextureBytes: 128,
        thumbnailTextureBytes: 32,
        decodedInFlightBytes: 64,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      limits: {
        sourceTextureBytes: 512,
        thumbnailTextureBytes: 128,
        decodedInFlightBytes: 256,
        objectUrlCount: 3,
        activeSourceUpgrades: 2
      }
    })

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('within-budget')
    expect(decision.reasons).toEqual([])
    expect(decision.projectedUsage.gpuTextureBytesTotal).toBe(
      decision.projectedUsage.sourceTextureBytes +
        decision.projectedUsage.thumbnailTextureBytes +
        decision.projectedUsage.tileResidentBytes
    )
    expect(decision.projectedUsage).toEqual({
      sourceTextureBytes: 384,
      thumbnailTextureBytes: 96,
      gpuTextureBytesTotal: 480,
      decodedResidentBytes: 0,
      decodedInFlightBytes: 192,
      encodedBlobBytes: 0,
      tileResidentBytes: 0,
      gpuUploadBytesInFlight: 0,
      objectUrlCount: 2,
      activeSourceUpgrades: 2,
      thumbnailJobs: 0,
      sourceJobs: 0,
      tileVisibleJobs: 0,
      tilePrefetchJobs: 0
    })
  })

  it('enforces the unified GPU texture budget while retaining legacy dimensions', () => {
    const decision = resolveCanvasImageResourceBudgetAdmission({
      currentUsage: { sourceTextureBytes: 600, thumbnailTextureBytes: 200 },
      request: { tileResidentBytes: 300 },
      limits: { gpuTextureBytesTotal: 1_000 }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('gpu-texture-budget')
    expect(decision.projectedUsage.gpuTextureBytesTotal).toBe(1_100)
    expect(decision.overBudget).toEqual([
      expect.objectContaining({ key: 'gpuTextureBytesTotal', usage: 1_100, limit: 1_000 })
    ])
  })

  it('includes total-only native GPU reservations in aggregate usage and admission', () => {
    const tracker = new CanvasImageResourceBudgetTracker({ gpuTextureBytesTotal: 1_000 })
    expect(tracker.admit({ id: 'native', gpuTextureBytesTotal: 700 }).allowed).toBe(true)
    expect(tracker.admit({ id: 'preview', thumbnailTextureBytes: 200 }).allowed).toBe(true)

    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(900)
    expect(tracker.getMetricsSnapshot()).toMatchObject({
      usage: { gpuTextureBytesTotal: 900 },
      remaining: { gpuTextureBytesTotal: 100 },
      gpuTextureReservationCount: 2
    })
    const rejected = tracker.admit({ id: 'tile', tileResidentBytes: 101 })
    expect(rejected.allowed).toBe(false)
    expect(rejected.reason).toBe('gpu-texture-budget')
    expect(rejected.projectedUsage.gpuTextureBytesTotal).toBe(1_001)
    expect(tracker.getReservation('tile')).toBeNull()
    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(900)
  })

  it('preserves explicit GPU overhead without counting legacy buckets twice on replacement', () => {
    const tracker = new CanvasImageResourceBudgetTracker({ gpuTextureBytesTotal: 1_000 })
    tracker.admit({ id: 'source', sourceTextureBytes: 400, gpuTextureBytesTotal: 700 })
    tracker.admit({ id: 'preview', thumbnailTextureBytes: 200 })
    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(900)

    const rejected = tracker.admit({ id: 'source', gpuTextureBytesTotal: 801 })
    expect(rejected.allowed).toBe(false)
    expect(rejected.replacedUsage.gpuTextureBytesTotal).toBe(700)
    expect(rejected.projectedUsage.gpuTextureBytesTotal).toBe(1_001)
    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(900)

    const reduced = tracker.admit({
      id: 'source',
      sourceTextureBytes: 100,
      gpuTextureBytesTotal: 300
    })
    expect(reduced.allowed).toBe(true)
    expect(tracker.getUsage()).toMatchObject({
      sourceTextureBytes: 100,
      thumbnailTextureBytes: 200,
      gpuTextureBytesTotal: 500
    })
    tracker.remove('source')
    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(200)
    tracker.clear()
    expect(tracker.getUsage().gpuTextureBytesTotal).toBe(0)
  })

  it('can evict native-only reservations when the total GPU budget is under pressure', () => {
    const tracker = new CanvasImageResourceBudgetTracker({ gpuTextureBytesTotal: 1_000 })
    tracker.admit({ id: 'native', gpuTextureBytesTotal: 800, visible: false })
    const candidates = tracker.getEvictionCandidates({ request: { thumbnailTextureBytes: 300 } })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'native',
      reason: 'gpu-texture-budget',
      release: { gpuTextureBytesTotal: 800 }
    })
  })

  it('keeps legacy-only usage compatible with newly normalized dimensions', () => {
    const tracker = new CanvasImageResourceBudgetTracker({ sourceTextureBytes: 2_000 })
    tracker.upsert(reservation('legacy', { sourceTextureBytes: 128 }))

    expect(tracker.getUsage()).toMatchObject({
      sourceTextureBytes: 128,
      thumbnailTextureBytes: 0,
      gpuTextureBytesTotal: 128
    })
  })

  it('denies admission with deterministic budget reasons for exceeded resources', () => {
    const decision = resolveCanvasImageResourceBudgetAdmission({
      currentUsage: {
        sourceTextureBytes: 900,
        thumbnailTextureBytes: 90,
        decodedInFlightBytes: 100,
        objectUrlCount: 1,
        activeSourceUpgrades: 0
      },
      request: {
        sourceTextureBytes: 200,
        thumbnailTextureBytes: 20,
        decodedInFlightBytes: 60,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      limits: {
        sourceTextureBytes: 1024,
        thumbnailTextureBytes: 100,
        decodedInFlightBytes: 128,
        objectUrlCount: 10,
        activeSourceUpgrades: 2
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-texture-budget')
    expect(decision.reasons).toEqual([
      'source-texture-budget',
      'thumbnail-texture-budget',
      'decoded-in-flight-budget'
    ])
    expect(decision.overBudget.map((pressure) => pressure.key)).toEqual([
      'sourceTextureBytes',
      'thumbnailTextureBytes',
      'decodedInFlightBytes'
    ])
  })

  it('tracks object URL budget independently from byte budgets', () => {
    const tracker = new CanvasImageResourceBudgetTracker({
      sourceTextureBytes: 10_000,
      thumbnailTextureBytes: 10_000,
      decodedInFlightBytes: 10_000,
      objectUrlCount: 2,
      activeSourceUpgrades: 10
    })

    expect(tracker.admit(reservation('url-a', { objectUrlCount: 1 })).allowed).toBe(true)
    expect(tracker.admit(reservation('url-b', { objectUrlCount: 1 })).allowed).toBe(true)

    const denied = tracker.admit(reservation('url-c', { objectUrlCount: 1 }))

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('object-url-budget')
    expect(denied.projectedUsage.objectUrlCount).toBe(3)
    expect(tracker.getUsage().objectUrlCount).toBe(2)
  })

  it('enforces the active source upgrade budget for concurrent source upgrades', () => {
    const tracker = new CanvasImageResourceBudgetTracker({
      sourceTextureBytes: 10_000,
      thumbnailTextureBytes: 10_000,
      decodedInFlightBytes: 10_000,
      objectUrlCount: 10,
      activeSourceUpgrades: 1
    })

    expect(
      tracker.admit(
        reservation('upgrade-a', {
          decodedInFlightBytes: 512,
          activeSourceUpgrades: 1
        })
      ).allowed
    ).toBe(true)

    const denied = tracker.admit(
      reservation('upgrade-b', {
        decodedInFlightBytes: 128,
        activeSourceUpgrades: 1
      })
    )

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('source-upgrade-budget')
    expect(denied.projectedUsage.activeSourceUpgrades).toBe(2)
  })

  it('returns eviction candidates that release pressured resources while protecting selected or explicit IDs', () => {
    const candidates = getCanvasImageResourceBudgetEvictionCandidates({
      limits: {
        sourceTextureBytes: 1_000,
        thumbnailTextureBytes: 1_000,
        decodedInFlightBytes: 512,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      reservations: [
        reservation('visible-selected-source', {
          sourceTextureBytes: 800,
          selected: true,
          lastAccessedAt: 1
        }),
        reservation('offscreen-old-source', {
          sourceTextureBytes: 500,
          visible: false,
          lastAccessedAt: 1
        }),
        reservation('protected-object-url', {
          objectUrlCount: 1,
          visible: false,
          lastAccessedAt: 0
        }),
        reservation('upgrade-decode', {
          decodedInFlightBytes: 256,
          activeSourceUpgrades: 1,
          visible: false,
          lastAccessedAt: 2
        }),
        reservation('not-evictable', {
          sourceTextureBytes: 500,
          evictable: false
        })
      ],
      request: {
        sourceTextureBytes: 300,
        decodedInFlightBytes: 300,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      protectedIds: new Set(['protected-object-url'])
    })

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'offscreen-old-source',
      'upgrade-decode',
      'visible-selected-source'
    ])
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        reason: 'source-texture-budget',
        reasons: ['source-texture-budget'],
        release: expect.objectContaining({ sourceTextureBytes: 500 })
      })
    )
    expect(candidates[1].reasons).toEqual(['decoded-in-flight-budget', 'source-upgrade-budget'])
  })

  it('enforces decoded resident, encoded blob, upload, and tile job limits independently', () => {
    const tracker = new CanvasImageResourceBudgetTracker({
      decodedResidentBytes: 100,
      encodedBlobBytes: 200,
      gpuUploadBytesInFlight: 300,
      thumbnailJobs: 1,
      sourceJobs: 1,
      tileVisibleJobs: 1,
      tilePrefetchJobs: 1
    })

    expect(
      tracker.admit(
        reservation('resource-a', {
          decodedResidentBytes: 100,
          encodedBlobBytes: 200,
          gpuUploadBytesInFlight: 300,
          thumbnailJobs: 1,
          sourceJobs: 1,
          tileVisibleJobs: 1,
          tilePrefetchJobs: 1
        })
      ).allowed
    ).toBe(true)

    const denied = tracker.admit(
      reservation('resource-b', {
        decodedResidentBytes: 1,
        encodedBlobBytes: 1,
        gpuUploadBytesInFlight: 1,
        thumbnailJobs: 1,
        sourceJobs: 1,
        tileVisibleJobs: 1,
        tilePrefetchJobs: 1
      })
    )
    expect(denied.allowed).toBe(false)
    expect(denied.reasons).toEqual([
      'decoded-resident-budget',
      'encoded-blob-budget',
      'gpu-upload-budget',
      'thumbnail-job-budget',
      'source-job-budget',
      'tile-visible-job-budget',
      'tile-prefetch-job-budget'
    ])
    expect(tracker.getUsage()).toMatchObject({
      decodedResidentBytes: 100,
      encodedBlobBytes: 200,
      gpuUploadBytesInFlight: 300,
      thumbnailJobs: 1,
      sourceJobs: 1,
      tileVisibleJobs: 1,
      tilePrefetchJobs: 1
    })
  })

  it('builds a metrics snapshot with usage, remaining capacity, pressure, and reservation counts', () => {
    const snapshot = buildCanvasImageResourceBudgetMetricsSnapshot({
      limits: {
        sourceTextureBytes: 1_000,
        thumbnailTextureBytes: 256,
        decodedInFlightBytes: 512,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      reservations: [
        reservation('source', { sourceTextureBytes: 1_100 }),
        reservation('thumbnail', { thumbnailTextureBytes: 128 }),
        reservation('decode-url-upgrade', {
          decodedInFlightBytes: 512,
          objectUrlCount: 2,
          activeSourceUpgrades: 1,
          evictable: false
        })
      ]
    })

    expect(snapshot.version).toBe(1)
    expect(snapshot.usage).toEqual({
      sourceTextureBytes: 1_100,
      thumbnailTextureBytes: 128,
      gpuTextureBytesTotal: 1_228,
      decodedResidentBytes: 0,
      decodedInFlightBytes: 512,
      encodedBlobBytes: 0,
      tileResidentBytes: 0,
      gpuUploadBytesInFlight: 0,
      objectUrlCount: 2,
      activeSourceUpgrades: 1,
      thumbnailJobs: 0,
      sourceJobs: 0,
      tileVisibleJobs: 0,
      tilePrefetchJobs: 0
    })
    expect(snapshot.remaining).toEqual({
      sourceTextureBytes: 0,
      thumbnailTextureBytes: 128,
      gpuTextureBytesTotal: null,
      decodedResidentBytes: null,
      decodedInFlightBytes: 0,
      encodedBlobBytes: null,
      tileResidentBytes: null,
      gpuUploadBytesInFlight: null,
      objectUrlCount: 0,
      activeSourceUpgrades: 0,
      thumbnailJobs: null,
      sourceJobs: null,
      tileVisibleJobs: null,
      tilePrefetchJobs: null
    })
    expect(snapshot.pressure).toEqual({
      sourceTextureBytes: 'over-budget',
      thumbnailTextureBytes: 'available',
      gpuTextureBytesTotal: 'unbounded',
      decodedResidentBytes: 'unbounded',
      decodedInFlightBytes: 'at-limit',
      encodedBlobBytes: 'unbounded',
      tileResidentBytes: 'unbounded',
      gpuUploadBytesInFlight: 'unbounded',
      objectUrlCount: 'at-limit',
      activeSourceUpgrades: 'at-limit',
      thumbnailJobs: 'unbounded',
      sourceJobs: 'unbounded',
      tileVisibleJobs: 'unbounded',
      tilePrefetchJobs: 'unbounded'
    })
    expect(snapshot.overBudget).toEqual([
      expect.objectContaining({
        key: 'sourceTextureBytes',
        reason: 'source-texture-budget',
        excess: 100
      })
    ])
    expect(snapshot.reservationCount).toBe(3)
    expect(snapshot.evictableReservationCount).toBe(2)
    expect(snapshot.sourceTextureReservationCount).toBe(1)
    expect(snapshot.thumbnailTextureReservationCount).toBe(1)
    expect(snapshot.gpuTextureReservationCount).toBe(2)
    expect(snapshot.decodedResidentReservationCount).toBe(0)
    expect(snapshot.decodedInFlightReservationCount).toBe(1)
    expect(snapshot.encodedBlobReservationCount).toBe(0)
    expect(snapshot.tileResidentReservationCount).toBe(0)
    expect(snapshot.gpuUploadReservationCount).toBe(0)
    expect(snapshot.objectUrlReservationCount).toBe(1)
    expect(snapshot.activeSourceUpgradeReservationCount).toBe(1)
    expect(snapshot.thumbnailJobReservationCount).toBe(0)
    expect(snapshot.sourceJobReservationCount).toBe(0)
    expect(snapshot.tileVisibleJobReservationCount).toBe(0)
    expect(snapshot.tilePrefetchJobReservationCount).toBe(0)
  })
})
